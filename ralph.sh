#!/usr/bin/env bash
#
# ralph.sh — run one long loop of fresh agents over one repository.
#
# Every iteration is a NEW `claude -p` with an empty context. The only thing that
# crosses the boundary between iterations is PROGRESS.md on disk, which the agent
# rewrites at the end of its turn. That is the whole trick: iteration 40 starts as
# clean as iteration 1 and reads its predecessor's notes instead of dragging a
# transcript behind it. A loop that keeps one context instead fills it and dies.
#
# The gate is a commit, judged outside the model. If HEAD did not move, the
# iteration found nothing, and the loop looks less often rather than giving up.
# If it moved and WORKTREE=1, the harness checks the new commits (frozen files,
# VERIFY_CMD, an optional read-only reviewer), resets the ones that fail, and
# pushes the rest itself. The agent commits; it never pushes.
#
# Usage: ralph.sh <loop-dir>
#
# The loop dir holds config.sh, PROMPT.md and PROGRESS.md. Create one with
# `ralph new <name> <repo>`.

set -uo pipefail

arg="${1:-${RALPH_LOOP:-}}"
[ -n "$arg" ] || { echo "usage: ralph.sh <loop-dir>" >&2; exit 2; }
DIR="$(cd "${arg%/}" 2>/dev/null && pwd)" || { echo "ralph: no such loop directory: $arg" >&2; exit 2; }

for f in config.sh PROMPT.md PROGRESS.md; do
  [ -f "$DIR/$f" ] || { echo "ralph: loop is missing $f: $DIR/$f" >&2; exit 2; }
done

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# One loop process per loop directory. Two would share PROGRESS.md, the log and
# the worktree, and each would take the other's commits for its own.
LOCK="$DIR/ralph.lock"
# A PID is not an identity: a loop killed by `kill -9`, the OOM killer or a
# reboot leaves this file behind, and the number is then somebody else's, so
# `kill -0` alone made the loop refuse to start for good. The holder has to be
# running a ralph loop. Looser than the CLI's check, which can demand this exact
# directory because it is the CLI that put it on the command line; started
# through RALPH_LOOP the directory is not there to match.
lock_held() {
  local pid; pid="$(cat "$LOCK" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  case "$(ps -p "$pid" -o command= 2>/dev/null)" in
    *ralph*.sh*) return 0 ;;
  esac
  return 1
}
if [ -f "$LOCK" ] && lock_held; then
  echo "ralph: this loop is already running as PID $(cat "$LOCK"): $DIR" >&2
  exit 2
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# ---------------------------------------------------------------- defaults
# Every default keeps a loop written for the old harness behaving as it did.
MODEL="opus"
MAX_ITER=500
QUIET_STOP=0
QUIET_SLEEP=1200
STEP_SLEEP=30
ADD_DIRS=()
CLOSING="Run one iteration now. When you are done, rewrite $DIR/PROGRESS.md with your entry at the top of the Log section."
WORKTREE=0
WORKTREE_DIR=""
BRANCH="main"
PUSH=0
SETUP_CMD=""
ITER_TIMEOUT=7200
VERIFY_CMD=""
VERIFY_TIMEOUT=1800
FROZEN=()
REVIEW=0
RATE_LIMIT_SLEEP=1800
ERROR_SLEEP=300
ERROR_STOP=0
PROGRESS_KEEP=8
ESCALATE_AFTER=3
LIVE_STEER=1
LOG_MAX_BYTES=10000000
LOG_KEEP=3
# What claude prints when a limit ends a run: plan limits (5-hour, weekly), an
# overloaded API, or an API key out of credit. Only consulted when claude exited
# non-zero, and only on its last lines, so an audit whose own output mentions
# "429" is never misread. A limit is waited out, never counted as a failure.
RATE_LIMIT_RE='hit your ([a-z]+ )?limit|usage limit|(weekly|session|[0-9]+-hour) limit|rate_limit_error|overloaded_error|API Error: (429|529)|credit balance is too low|spend limit|insufficient_quota'

# shellcheck disable=SC1091
. "$DIR/config.sh"

[ -n "${REPO:-}" ] || { echo "ralph: config.sh must set REPO" >&2; exit 2; }
[ -e "$REPO/.git" ] || { echo "ralph: REPO is not a git checkout: $REPO" >&2; exit 2; }

LOG="$DIR/ralph.log"
RESULTS="$DIR/results.tsv"
PROMPT_FILE="$DIR/.prompt"
NAME="$(basename "$DIR")"
WORK="$REPO"


log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# Every agent's whole output goes into ralph.log, so a loop left running for days
# writes gigabytes into one file that nothing can then read. Rotate it between
# iterations — ralph.log.1 is the one before this, up to LOG_KEEP of them — which
# bounds the lot at roughly LOG_MAX_BYTES * (LOG_KEEP + 1). Between iterations,
# not during one, so an iteration's output stays in one piece; one very loud
# agent can therefore overshoot the limit by its own output before it is noticed.
# `ralph status`, `ralph log` and `ralph tail` read the rotated files too.
rotate_log() {
  [ "${LOG_MAX_BYTES:-0}" -gt 0 ] 2>/dev/null || return 0
  local size i f n
  size=$(wc -c < "$LOG" 2>/dev/null | tr -d ' ') || return 0
  [ -n "$size" ] && [ "$size" -ge "$LOG_MAX_BYTES" ] || return 0
  if [ "${LOG_KEEP:-0}" -ge 1 ] 2>/dev/null; then
    # Everything numbered at or above LOG_KEEP goes, not only the file at
    # exactly that number: a loop whose LOG_KEEP was lowered still carries the
    # files from the higher setting, and nothing else would ever remove them,
    # so the bound below would not hold.
    for f in "$LOG".[0-9]*; do
      n="${f##*.}"
      case "$n" in *[!0-9]*) continue ;; esac
      if [ -f "$f" ] && [ "$n" -ge "$LOG_KEEP" ]; then rm -f "$f"; fi
    done
    i=$((LOG_KEEP - 1))
    while [ "$i" -ge 1 ]; do
      [ -f "$LOG.$i" ] && mv "$LOG.$i" "$LOG.$((i + 1))"
      i=$((i - 1))
    done
    mv "$LOG" "$LOG.1"
  else
    rm -f "$LOG"
  fi
  : > "$LOG"
  log "log rotated at $size bytes; the $LOG_KEEP before this one are $(basename "$LOG").1 and up"
}

# ------------------------------------------------------ processes and timing
# The agent, VERIFY_CMD, the reviewer and `git push` all run through run_bounded.
# Each gets its own process group, so a timeout or `ralph stop` takes down
# everything it started (test runners, dev servers, MCP servers), not only the
# top process. macOS has no timeout(1) or setsid(1); this needs bash 3.2 and,
# for the process group, the perl that ships with macOS and every Linux distro.

CHILD=""
NAP=""
RC=0
TIMED_OUT=0
PERL="$(command -v perl 2>/dev/null || true)"

kill_group() {
  local pid="$1" i=0
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 10 ]; do sleep 1; i=$((i + 1)); done
  kill -KILL -- "-$pid" 2>/dev/null
}

# run_bounded <seconds> <stdin file> <output file> <command...>
# Output is appended. Sets RC and TIMED_OUT. The files are arguments, not
# `VAR=x run_bounded` prefixes, because bash exports a prefix assignment to
# every process the function starts: a VERIFY_CMD that runs another ralph loop
# (as this repo's own tests do) would inherit it. Never call it inside
# $(...): the command would become a grandchild that `ralph stop` cannot see.
run_bounded() {
  local secs="$1" input="$2" output="$3" start polls=0
  shift 3
  TIMED_OUT=0
  if [ -n "$PERL" ]; then
    # The command becomes the leader of a new process group, with pid == pgid.
    # shellcheck disable=SC2016  # $ARGV is perl's, not the shell's
    "$PERL" -e 'setpgrp(0, 0); exec { $ARGV[0] } @ARGV or exit 127' "$@" \
      < "$input" >> "$output" 2>&1 &
  else
    # Job control gives background jobs their own group, but only where the
    # shell can enable it; without a terminal on Linux it cannot.
    set -m
    "$@" < "$input" >> "$output" 2>&1 &
    set +m
  fi
  CHILD=$!
  start=$(date +%s)
  while kill -0 "$CHILD" 2>/dev/null; do
    if [ $(( $(date +%s) - start )) -ge "$secs" ]; then
      TIMED_OUT=1
      kill_group "$CHILD"
      break
    fi
    # Poll fast at first, so quick commands (git push, a short VERIFY_CMD) do
    # not each cost two seconds.
    if [ "$polls" -lt 20 ]; then sleep 0.1 & else sleep 2 & fi
    wait $! 2>/dev/null
    polls=$((polls + 1))
  done
  wait "$CHILD" 2>/dev/null
  RC=$?
  CHILD=""
}

# A sleep the TERM trap can interrupt immediately.
nap() {
  [ "${1:-0}" -gt 0 ] 2>/dev/null || return 0
  sleep "$1" &
  NAP=$!
  wait "$NAP" 2>/dev/null
  NAP=""
}

iter=0
on_signal() {
  [ -n "$CHILD" ] && kill_group "$CHILD"
  [ -n "$NAP" ] && kill "$NAP" 2>/dev/null
  rm -f "$DIR/ralph.pid"
  log "ralph stopped by signal during iteration $iter"
  exit 130
}
# The CLI writes ralph.pid; clearing it here keeps `ralph status` honest after the
# loop ends on its own rather than by `ralph stop`.
trap on_signal INT TERM

# ------------------------------------------------------------ bookkeeping

# record <before> <after> <status> <seconds> <reason>
record() {
  [ -f "$RESULTS" ] || printf 'time\titer\tbefore\tafter\tstatus\tsecs\treason\n' > "$RESULTS"
  local reason
  reason="$(printf '%s' "${5:-}" | tr '\t\n\r' '   ' | cut -c1-300)"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$iter" \
    "${1:0:12}" "${2:0:12}" "$3" "$4" "${reason:--}" >> "$RESULTS"
}

# Consecutive failures double the pause, up to an hour.
trouble_sleep() {
  local s="$ERROR_SLEEP" i=1
  while [ "$i" -lt "$trouble" ] && [ "$s" -lt 3600 ]; do s=$((s * 2)); i=$((i + 1)); done
  [ "$s" -gt 3600 ] && s=3600
  echo "$s"
}

# Keeps PROGRESS.md at its head sections plus the newest PROGRESS_KEEP Log
# entries, so the prompt stops growing. The overflow is appended to
# PROGRESS-archive.md oldest first, and is never injected.
CAP_WARNED=""
cap_progress() {
  [ "$PROGRESS_KEEP" -gt 0 ] 2>/dev/null || return 0
  local f="$DIR/PROGRESS.md" archive="$DIR/PROGRESS-archive.md" n tmp over
  n=$(awk '/^## Log/{f=1; next} f && /^## /{f=0} f && /^### /{c++} END{print c+0}' "$f")
  if [ "$n" -eq 0 ]; then
    if [ -z "$CAP_WARNED" ] && grep -q '^## Log' "$f"; then
      log "progress cap: no '### ' entries under ## Log, leaving PROGRESS.md as it is"
    fi
    CAP_WARNED=1
    return 0
  fi
  [ "$n" -gt "$PROGRESS_KEEP" ] || return 0

  tmp="$f.tmp.$$"
  over="$DIR/.progress-overflow.$$"
  : > "$over"
  awk -v keep="$PROGRESS_KEEP" -v over="$over" '
    /^## Log/          { inlog = 1; print; next }
    inlog && /^## /    { inlog = 0 }
    inlog && /^### /   { c++ }
    inlog && c > keep  { print > over; next }
                       { print }
  ' "$f" > "$tmp" || { rm -f "$tmp" "$over"; return 0; }

  [ -f "$archive" ] || printf '# Progress archive\n\nLog entries moved out of PROGRESS.md, oldest first.\n\n' > "$archive"
  # The overflow is newest first; the archive reads oldest first.
  awk '/^### /{n++} {b[n] = b[n] $0 "\n"} END{for (i = n; i >= 1; i--) printf "%s", b[i]}' "$over" >> "$archive"
  mv "$tmp" "$f"
  rm -f "$over"
  log "progress cap: moved $((n - PROGRESS_KEEP)) old Log entries to PROGRESS-archive.md"
}

build_prompt() {
  {
    cat "$DIR/PROMPT.md"
    printf '\n---\n\n# PROGRESS.md (your memory of previous iterations — read this before doing anything)\n\n'
    cat "$DIR/PROGRESS.md"
    if [ -s "$DIR/PROGRESS-archive.md" ]; then
      printf '\nOlder Log entries are in %s. Read it only when you need that history.\n' "$DIR/PROGRESS-archive.md"
    fi

    if [ -f "$RESULTS" ]; then
      printf '\n---\n\n# Harness verdicts (ground truth: where PROGRESS.md disagrees, this wins)\n\n'
      printf 'The last iterations as the harness recorded them. "revert:*" means the commits were reset and never shipped.\n\n'
      head -n 1 "$RESULTS"
      tail -n +2 "$RESULTS" | tail -n 10
    fi

    if [ "$WORKTREE" = 1 ]; then
      printf '\n---\n\n# Where you work\n\n'
      printf 'Your working copy is %s, on branch ralph/%s. Never touch %s.\n' "$WORK" "$NAME" "$REPO"
      if [ "$PUSH" = 1 ]; then
        printf 'Commit your work, but do not push: the harness checks each commit and pushes the ones it keeps. A rejected commit is reset, and the verdict shows up above next time.\n'
      else
        printf 'Commit your work, but do not push. A human merges ralph/%s.\n' "$NAME"
      fi
    fi

    if [ "${#FROZEN[@]}" -gt 0 ]; then
      printf '\nFrozen, never edit: %s. A commit that touches any of them is reset.\n' "${FROZEN[*]}"
    fi

    if [ "$ESCALATE_AFTER" -gt 0 ] && [ "$trouble" -ge $((ESCALATE_AFTER * 2)) ]; then
      printf '\n---\n\n# Harness: stuck\n\nThe last %s iterations were reverted or failed (see the verdicts). Stop attacking this. Write the blocker under "Needs a decision" in PROGRESS.md, with what was tried, then take unrelated work. If there is none, change nothing.\n' "$trouble"
    elif [ "$ESCALATE_AFTER" -gt 0 ] && [ "$trouble" -ge "$ESCALATE_AFTER" ]; then
      printf '\n---\n\n# Harness: stuck\n\nThe last %s iterations were reverted or failed (see the verdicts). Do not retry that approach. Pivot to a different defect or a different method.\n' "$trouble"
    fi

    printf '\n---\n\n%s\n' "$CLOSING"
  } > "$PROMPT_FILE"
}

# ------------------------------------------------------------ git helpers
# Everything below that can discard commits runs only in the harness-owned
# worktree, never in your own checkout.

clean_tree() {
  local gitdir
  gitdir="$(git rev-parse --git-dir)"
  if [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]; then
    git rebase --abort >/dev/null 2>&1
  fi
  rm -f "$gitdir/index.lock"
  git reset -q --hard HEAD
  git clean -qfd
}

# revert_to <sha>: put ralph/<name> back at <sha>, whatever the agent did —
# left the branch, rewrote its history, or deleted the ref out from under the
# worktree. -B remakes the branch when it is gone, so a deleted ref costs one
# iteration instead of ending the run.
revert_to() {
  git checkout -q -f -B "ralph/$NAME" "$1" || return 1
  git clean -qfd
}

# The repository a checkout belongs to, as an absolute path, or nothing.
# Everything the harness does in $WORK resets and cleans it, so $WORK has to be
# this REPO's own worktree and not merely some git checkout that happens to sit
# at the path WORKTREE_DIR names.
git_home() {
  local common
  common="$(git -C "$1" rev-parse --git-common-dir 2>/dev/null)" || return 1
  [ -n "$common" ] || return 1
  # pwd -P, because git answers with ".git" for a checkout and an absolute path
  # for a worktree, and on macOS that absolute path has been through /private.
  (cd "$1" && cd "$common" && pwd -P)
}

setup_worktree() {
  WORK="${WORKTREE_DIR:-$(dirname "$REPO")/$(basename "$REPO")-ralph-$NAME}"
  if git -C "$WORK" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    [ "$(git_home "$WORK")" = "$(git_home "$REPO")" ] && return 0
    log "$WORK is not a worktree of $REPO — refusing to reset a checkout this loop does not own"
    exit 1
  fi
  git -C "$REPO" worktree prune
  if git -C "$REPO" show-ref --verify --quiet "refs/heads/ralph/$NAME"; then
    # Reuse the branch as it is. `worktree add -B` would reset it and lose kept work.
    git -C "$REPO" worktree add -q "$WORK" "ralph/$NAME" >> "$LOG" 2>&1 \
      || { log "cannot create worktree $WORK"; exit 1; }
  else
    local base="$BRANCH"
    git -C "$REPO" fetch -q origin "$BRANCH" >> "$LOG" 2>&1 && base="origin/$BRANCH"
    git -C "$REPO" worktree add -q -b "ralph/$NAME" "$WORK" "$base" >> "$LOG" 2>&1 \
      || { log "cannot create worktree $WORK from $base"; exit 1; }
    if [ -n "$SETUP_CMD" ]; then
      log "setup: $SETUP_CMD"
      if ! (cd "$WORK" && bash -c "$SETUP_CMD") >> "$LOG" 2>&1; then
        # The branch goes with the worktree. Keeping it sent the next start down
        # the "reuse the branch" path above, which never runs SETUP_CMD, so the
        # loop ran for good in a worktree its own setup had never prepared.
        log "SETUP_CMD failed; removing the new worktree and branch ralph/$NAME, so the next start runs setup again"
        git -C "$REPO" worktree remove --force "$WORK" >/dev/null 2>&1
        git -C "$REPO" branch -q -D "ralph/$NAME" >/dev/null 2>&1
        exit 1
      fi
    fi
  fi
  [ "$(git_home "$WORK")" = "$(git_home "$REPO")" ] \
    || { log "worktree $WORK is not usable"; exit 1; }
  log "worktree $WORK on ralph/$NAME"
}

GATE_REASON=""

verify() {
  [ -n "$VERIFY_CMD" ] || return 0
  : > "$DIR/verify.out"
  run_bounded "$VERIFY_TIMEOUT" /dev/null "$DIR/verify.out" bash -c "$VERIFY_CMD"
  cat "$DIR/verify.out" >> "$LOG"
  if [ "$TIMED_OUT" = 1 ]; then
    GATE_REASON="verify timed out after ${VERIFY_TIMEOUT}s"
    return 1
  fi
  if [ "$RC" -ne 0 ]; then
    GATE_REASON="verify exited $RC: $(grep -v '^[[:space:]]*$' "$DIR/verify.out" | tail -n 1)"
    return 1
  fi
  return 0
}

# review <before>: a fresh, read-only claude judges the new commits.
# Sets REVIEW_STATUS to accept, reject or unavailable.
REVIEW_STATUS=""
review() {
  local before="$1" job steering
  { git diff --stat "$before" HEAD; echo; git diff "$before" HEAD; } | head -c 200000 > "$DIR/review.diff"
  job="$(awk '/^## The job/{f=1; next} /^## /{f=0} f' "$DIR/PROMPT.md")"
  # A PROMPT.md written without that heading is still the job. Better the
  # reviewer reads all of it than judges the diff against nothing at all.
  [ -n "$job" ] || job="$(cat "$DIR/PROMPT.md")"
  steering="$(awk '/^## Steering/{f=1; next} /^## /{f=0} f' "$DIR/PROMPT.md")"
  # Steering handed to the agent mid-iteration by hooks/steer.sh.
  if [ -s "$DIR/STEER.md.delivered" ]; then
    steering="${steering:+$steering
}$(cat "$DIR/STEER.md.delivered")"
  fi
  cat > "$DIR/.review-prompt" <<EOF
You are reviewing commits that another agent just made in $WORK. You cannot change
anything; you only judge.

## The job the loop is doing

$job

## Steering from the human (outranks the job)

${steering:-(none)}

## What to review

The commits are in $DIR/review.diff: a stat, then the full diff, capped at 200 KB.
Read it. Read files in $WORK if you need context.

Reject when the change is wrong, is not what the job asks for, breaks something
visible in the diff, weakens a test or a measurement so that it passes, or claims
a result the diff does not support. Otherwise accept. Style alone is not a reason
to reject.

End your reply with exactly one line, either

VERDICT: ACCEPT

or

VERDICT: REJECT: <one sentence saying why>
EOF
  local verdict
  while :; do
    : > "$DIR/review.out"
    run_bounded "$ITER_TIMEOUT" "$DIR/.review-prompt" "$DIR/review.out" \
      claude -p --restricted --tools "Read,Grep,Glob" --strict-mcp-config \
      --permission-prompts none --add-dir "$DIR" --model "$MODEL"
    cat "$DIR/review.out" >> "$LOG"
    verdict="$(grep -a '^VERDICT:' "$DIR/review.out" | tail -n 1)"
    # A limit is not an answer: wait it out and ask again, rather than ship the
    # commit unreviewed or throw it away.
    if [ -z "$verdict" ] && [ "$RC" -ne 0 ] && [ "$TIMED_OUT" = 0 ] \
      && tail -n 20 "$DIR/review.out" | grep -Eqi "$RATE_LIMIT_RE"; then
      log "reviewer hit a limit — asking again in ${RATE_LIMIT_SLEEP}s"
      nap "$RATE_LIMIT_SLEEP"
      continue
    fi
    break
  done
  case "$verdict" in
    "VERDICT: ACCEPT"*) REVIEW_STATUS=accept ;;
    "VERDICT: REJECT"*)
      REVIEW_STATUS=reject
      GATE_REASON="${verdict#VERDICT: REJECT}"
      GATE_REASON="${GATE_REASON#:}"
      GATE_REASON="reviewer: ${GATE_REASON# }"
      ;;
    *)
      REVIEW_STATUS=unavailable
      GATE_REASON="reviewer gave no verdict (exit $RC, timed out $TIMED_OUT)"
      ;;
  esac
}

# The last HEAD the harness judged. An iteration killed by `ralph stop`, a crash
# or a reboot can leave commits no gate has seen; at the next start they are set
# aside instead of being judged by nobody and pushed by the next sync.
GATED="$DIR/.gated-head"
mark_gated() { git rev-parse HEAD > "$GATED"; }

drop_unjudged() {
  [ -f "$GATED" ] || { mark_gated; return 0; }
  local judged head
  judged="$(cat "$GATED")"
  head="$(git rev-parse HEAD)"
  [ "$judged" != "$head" ] || return 0
  git cat-file -e "$judged^{commit}" 2>/dev/null || { mark_gated; return 0; }
  git update-ref "refs/ralph/dropped/$(date +%s)" "$head"
  if ! revert_to "$judged"; then
    log "cannot reset ralph/$NAME to the last judged commit $judged — fix the worktree by hand"
    exit 1
  fi
  record "$head" "$judged" "drop:interrupted" 0 \
    "commits from an interrupted iteration were never judged; saved under refs/ralph/dropped/"
  log "start: $head was never judged (an iteration was interrupted); reset to $judged, saved under refs/ralph/dropped/"
}

# sync: follow origin/$BRANCH and push kept commits. Worktree + PUSH only.
# Runs before every iteration and after every keep, so a push that failed once
# is retried, and work done while a human pushed to the same branch is rebased
# and verified again before it goes out.
sync() {
  sync_once
  mark_gated
}

sync_once() {
  local upstream="origin/$BRANCH" head
  clean_tree
  if ! git fetch -q origin "$BRANCH" >> "$LOG" 2>&1; then
    log "sync: fetch failed, not pushing this time"
    return 0
  fi
  if [ -z "$(git rev-list "$upstream..HEAD")" ]; then
    git reset -q --hard "$upstream"
    return 0
  fi
  if ! git merge-base --is-ancestor "$upstream" HEAD; then
    head="$(git rev-parse HEAD)"
    if ! git rebase -q "$upstream" >> "$LOG" 2>&1; then
      git rebase --abort >/dev/null 2>&1
      git update-ref "refs/ralph/dropped/$(date +%s)" "$head"
      git reset -q --hard "$upstream"
      record "$head" "$(git rev-parse HEAD)" "drop:conflict" 0 \
        "rebase onto $upstream conflicted; unpushed commits dropped, saved under refs/ralph/dropped/"
      log "sync: rebase conflicted, dropped unpushed commits (saved under refs/ralph/dropped/)"
      return 0
    fi
    if ! verify; then
      git update-ref "refs/ralph/dropped/$(date +%s)" HEAD
      record "$head" "$(git rev-parse HEAD)" "drop:reverify" 0 "after rebase onto $upstream: $GATE_REASON"
      git reset -q --hard "$upstream"
      log "sync: rebased commits failed verify, dropped them (saved under refs/ralph/dropped/)"
      return 0
    fi
  fi
  run_bounded 300 /dev/null "$LOG" git push -q origin "HEAD:$BRANCH"
  if [ "$RC" -eq 0 ]; then
    log "pushed $(git rev-parse HEAD) to $upstream"
  else
    log "sync: push failed (exit $RC); the commits stay local and the next sync retries"
  fi
}

# ------------------------------------------------------------------ start

# PUSH with nowhere to push. Every sync would fetch, fail, and copy git's
# four-line complaint into the log; over days that is the whole log. Say it
# once and keep the commits local, which is what PUSH=0 does anyway.
if [ "$WORKTREE" = 1 ] && [ "$PUSH" = 1 ] \
  && ! git -C "$REPO" remote get-url origin >/dev/null 2>&1; then
  log "PUSH=1 but $REPO has no origin remote — keeping commits local, as PUSH=0 does"
  PUSH=0
fi

if [ "$WORKTREE" = 1 ]; then
  setup_worktree
fi
cd "$WORK" || exit 1
if [ "$WORKTREE" = 1 ]; then
  drop_unjudged
fi

if [ "$LIVE_STEER" = 1 ]; then
  printf '{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"\\"%s\\""}]}]}}\n' \
    "$HARNESS/hooks/steer.sh" > "$DIR/.agent-settings.json"
fi

log "ralph start: loop=$NAME repo=$REPO work=$WORK model=$MODEL max_iter=$MAX_ITER quiet_stop=$QUIET_STOP worktree=$WORKTREE push=$PUSH review=$REVIEW verify=${VERIFY_CMD:+yes}"

quiet=0
trouble=0
errors=0
while :; do
  iter=$((iter + 1))
  if [ "$iter" -gt "$MAX_ITER" ]; then
    iter=$((iter - 1))   # this one never ran; do not count it
    log "stopping: hit MAX_ITER=$MAX_ITER"
    break
  fi

  rotate_log
  if [ "$WORKTREE" = 1 ]; then
    if [ "$PUSH" = 1 ]; then sync; else clean_tree; fi
  fi
  # The same text already sits in PROMPT.md's Steering section, which this
  # iteration reads; the live file is only for the iteration in flight.
  [ "$LIVE_STEER" = 1 ] && : > "$DIR/STEER.md" && : > "$DIR/STEER.md.delivered"

  before=$(git rev-parse HEAD)
  [ "$WORKTREE" = 1 ] && mark_gated
  started=$(date +%s)
  log "=== iteration $iter (HEAD $before) ==="

  # PROMPT.md is re-read every iteration, so editing it (or `ralph steer`) redirects
  # the loop without restarting it.
  build_prompt

  args=(-p --dangerously-skip-permissions --add-dir "$DIR" --model "$MODEL")
  for d in ${ADD_DIRS[@]+"${ADD_DIRS[@]}"}; do
    args+=(--add-dir "$d")
  done
  [ "$LIVE_STEER" = 1 ] && args+=(--settings "$DIR/.agent-settings.json")

  envs=("RALPH_STEER_FILE=$DIR/STEER.md")
  if [ "$WORKTREE" = 1 ] && [ "$PUSH" = 1 ]; then
    # The agent's own push to this repository fails; only the harness pushes.
    # Keyed on the URL, not on remote.origin.pushurl: git applies a setting from
    # the environment to every repository the process touches, so naming the
    # remote would also break a push to an unrelated `origin` — the throwaway
    # remotes a test suite makes for itself, for one. The URL is this loop's
    # alone, and it catches a push that spells the URL out as well.
    push_url="$(git remote get-url --push origin 2>/dev/null)"
    [ -n "$push_url" ] && envs+=(GIT_CONFIG_COUNT=1 \
      "GIT_CONFIG_KEY_0=url.no-push://disabled.pushInsteadOf" \
      "GIT_CONFIG_VALUE_0=$push_url")
  fi

  offset=$(wc -c < "$LOG" | tr -d ' ')
  run_bounded "$ITER_TIMEOUT" "$PROMPT_FILE" "$LOG" env "${envs[@]}" claude "${args[@]}"
  agent_rc=$RC
  agent_timed_out=$TIMED_OUT

  status=""
  reason=""
  if [ "$WORKTREE" = 1 ]; then
    # Gates judge what was committed. Anything left uncommitted is thrown away
    # first, so an uncommitted edit to a frozen file cannot help a commit pass.
    clean_tree
    if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" != "ralph/$NAME" ] \
      || ! git merge-base --is-ancestor "$before" HEAD 2>/dev/null; then
      status="revert:history"
      reason="the agent left ralph/$NAME or rewrote its history"
    fi
  fi
  after=$(git rev-parse HEAD)
  took=$(( $(date +%s) - started ))

  if [ -z "$status" ] && [ "$before" = "$after" ]; then
    if [ "$agent_timed_out" = 1 ]; then
      status="timeout"
      reason="killed after ${ITER_TIMEOUT}s"
    elif [ "$agent_rc" -ne 0 ]; then
      last="$(tail -c +$((offset + 1)) "$LOG" | tail -n 20)"
      if printf '%s\n' "$last" | grep -Eqi "$RATE_LIMIT_RE"; then
        status="ratelimit"
        reason="$(printf '%s\n' "$last" | grep -Ei "$RATE_LIMIT_RE" | tail -n 1)"
      else
        status="error"
        reason="claude exited $agent_rc: $(printf '%s\n' "$last" | grep -v '^[[:space:]]*$' | tail -n 1)"
      fi
    else
      status="quiet"
    fi
  elif [ -z "$status" ] && [ "$WORKTREE" = 1 ]; then
    GATE_REASON=""
    touched=""
    if [ "${#FROZEN[@]}" -gt 0 ]; then
      touched="$(git diff --name-only "$before" HEAD -- "${FROZEN[@]}" | tr '\n' ' ')"
    fi
    if [ -n "$touched" ]; then
      status="revert:frozen"
      reason="touched frozen files: $touched"
    elif ! verify; then
      status="revert:verify"
      reason="$GATE_REASON"
    elif [ "$REVIEW" = 1 ]; then
      review "$before"
      case "$REVIEW_STATUS" in
        accept) status="keep" ;;
        reject) status="revert:review"; reason="$GATE_REASON" ;;
        *)
          if [ -n "$VERIFY_CMD" ]; then
            status="keep:unreviewed"
            reason="$GATE_REASON; VERIFY_CMD passed"
          else
            # With no VERIFY_CMD the reviewer is the only gate; do not ship unjudged work.
            status="revert:review-unavailable"
            reason="$GATE_REASON"
          fi
          ;;
      esac
    fi
  fi
  [ -n "$status" ] || status="keep"
  [ "$agent_timed_out" = 1 ] && [ "${status%%:*}" != "timeout" ] && reason="${reason:+$reason; }agent timed out after ${ITER_TIMEOUT}s"

  case "$status" in
    revert:*)
      git update-ref "refs/ralph/reverted/$(date +%s)-$iter" "$after" 2>/dev/null
      if ! revert_to "$before"; then
        record "$before" "$after" "$status" "$took" "$reason"
        log "stopping: could not reset ralph/$NAME to $before after $status — fix the worktree by hand"
        break
      fi
      ;;
  esac
  record "$before" "$after" "$status" "$took" "$reason"

  case "$status" in
    keep*)
      quiet=0; trouble=0; errors=0
      [ "$WORKTREE" = 1 ] && mark_gated
      log "iteration $iter shipped $after in ${took}s${reason:+ ($reason)}"
      if [ "$WORKTREE" = 1 ] && [ "$PUSH" = 1 ]; then sync; fi
      ;;
    quiet)
      quiet=$((quiet + 1)); trouble=0; errors=0
      log "iteration $iter shipped nothing in ${took}s (quiet streak $quiet)"
      if [ "$QUIET_STOP" -gt 0 ] && [ "$quiet" -ge "$QUIET_STOP" ]; then
        log "stopping: $QUIET_STOP consecutive iterations shipped nothing"
        break
      fi
      nap "$QUIET_SLEEP"
      ;;
    ratelimit)
      log "iteration $iter hit a limit: $reason — trying it again in ${RATE_LIMIT_SLEEP}s"
      # Waiting out a limit is not work, so it does not use up MAX_ITER.
      iter=$((iter - 1))
      nap "$RATE_LIMIT_SLEEP"
      ;;
    timeout|error)
      trouble=$((trouble + 1)); errors=$((errors + 1))
      log "iteration $iter $status: $reason (errors in a row $errors)"
      if [ "$ERROR_STOP" -gt 0 ] && [ "$errors" -ge "$ERROR_STOP" ]; then
        log "stopping: $ERROR_STOP consecutive iterations failed"
        break
      fi
      nap "$(trouble_sleep)"
      ;;
    revert:*)
      trouble=$((trouble + 1)); errors=0
      log "iteration $iter reverted to $before: $status — $reason"
      nap "$(trouble_sleep)"
      ;;
  esac

  cap_progress
  nap "$STEP_SLEEP"
done

rm -f "$DIR/ralph.pid"
log "ralph finished after $iter iterations"
