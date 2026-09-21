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

LOG="$DIR/ralph.log"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# The harness's own errors belong in ralph.log, which is where `ralph log`,
# `ralph tail` and `ralph status` read and where a human is sent. Everything it
# said before this line went to the inherited stderr instead, and `ralph start`
# points that at ralph.out: the CLI printed "started <name> as PID N", the loop
# was gone a second later, and `ralph log` answered "no log yet". So the
# redirect goes as early as the log's name is known, and the fatals below say
# their piece through log(), which tees to stdout as well so a hand-run in a
# terminal still hears it.
exec 2>>"$LOG"

# have_files <name...>: every one of them is a regular file this process can
# read. Names the first that is not in MISSING_FILE, so the caller can say
# which. `-f` as well as `-r`, because a directory is readable and cannot be
# cat'd; a loop directory holding a PROMPT.md/ is still a loop with no job.
#
# Called at the start and again before every iteration, and that is the point.
# config.sh is read once on purpose — a restart is how a setting changes — but
# PROMPT.md and PROGRESS.md are re-read for every prompt, and the reviewer
# re-reads PROMPT.md for the job it judges against. Nothing looked a second
# time, and the agent can write in this directory: it is told to rewrite
# PROGRESS.md here. So one of them could go, and the harness carried on. With
# PROMPT.md gone the next agent got its own notes, the verdict table and "Run
# one iteration now" — no job at all, under --dangerously-skip-permissions.
# With PROGRESS.md gone the prompt told it its memory had been clipped at ""
# bytes and to read the rest on disk, of a file that is not there.
MISSING_FILE=""
have_files() {
  local f
  for f in "$@"; do
    if [ ! -f "$DIR/$f" ] || [ ! -r "$DIR/$f" ]; then MISSING_FILE="$f"; return 1; fi
  done
  return 0
}

have_files config.sh PROMPT.md PROGRESS.md \
  || { log "ralph: loop is missing $MISSING_FILE: $DIR/$MISSING_FILE"; exit 2; }

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
  log "ralph: this loop is already running as PID $(cat "$LOCK"): $DIR"
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
# How many times running into a limit the reviewer is asked again before the
# iteration gives up and takes the "reviewer unavailable" path. Unlike the
# agent's limit, this one is waited out while holding a commit no gate has
# judged, so it needs a ceiling: 12 tries at the default sleep is six hours,
# past a session limit's reset and well short of a weekly one. 0 or a
# non-number means no ceiling, which is how this behaved before.
REVIEW_LIMIT_TRIES=12
# A check the human owns that says the job is done: run in the work directory
# at the top of every iteration, after the push of the last one; exit 0 stops
# the loop. It is how a loop whose list is finished stops instead of wandering
# off into unrelated work.
DONE_CMD=""
# Local hours the loop may start iterations in, as "22-08" (end hour excluded,
# wrapping past midnight). Empty means any hour. The loop shares a plan limit
# with its human; this keeps it to the hours the human is not using.
ACTIVE_HOURS=""
ACTIVE_POLL=300
# Tool patterns the agent may not use, such as "Bash(ssh *)". Each becomes a
# --disallowedTools flag, which claude enforces ahead of
# --dangerously-skip-permissions. A guard against accidents, not against an
# agent set on getting round it: `bash -c` and scripts are still there.
DENY=()
# The reviewer's model. Empty means MODEL. A cheaper one saves the plan limit
# the loop shares with its human.
REVIEW_MODEL=""
RATE_LIMIT_SLEEP=1800
ERROR_SLEEP=300
ERROR_STOP=0
PROGRESS_KEEP=8
PROGRESS_MAX_BYTES=120000
ESCALATE_AFTER=3
# A shell command the harness runs to tell a human what they would otherwise
# only find by reading the log: the loop stopped, a start was refused, an error
# streak reached ESCALATE_AFTER, a limit began or cleared, or the agent wrote
# something new under "Needs a decision" in PROGRESS.md. Empty is silence,
# which is what a loop written before this setting keeps. Never on a keep: a
# notifier that speaks every iteration is one nobody reads.
NOTIFY_CMD=""
NOTIFY_TIMEOUT=30
LIVE_STEER=1
LOG_MAX_BYTES=10000000
LOG_KEEP=3
REF_KEEP=20
# The longest gap between two polls of a running command that is counted as
# time the command had. Every timeout is a budget of seconds the machine was
# awake for, not of wall clock: see run_bounded.
POLL_GAP_MAX=60
# What claude prints when a limit ends a run: plan limits (5-hour, weekly), an
# overloaded API, or an API key out of credit. Only consulted when claude exited
# non-zero, and only on its last lines, so an audit whose own output mentions
# "429" is never misread. A limit is waited out, never counted as a failure.
RATE_LIMIT_RE='hit your ([a-z]+ )?limit|usage limit|(weekly|session|[0-9]+-hour) limit|rate_limit_error|overloaded_error|API Error: (429|529)|credit balance is too low|spend limit|insufficient_quota'

# Sourcing a file that does not parse runs the commands before the error,
# abandons the rest and returns non-zero — and nothing checked that, so every
# setting after a stray bracket was silently left at its harness default. A
# loop written for a gated worktree then ran with WORKTREE=0 and committed
# straight into the user's own checkout. Half a config is not a config, so
# refuse. The parse alone is checked, and not the source's exit status: a
# config.sh ending in `[ -d x ] && ADD_DIRS=(x)` returns non-zero when the
# directory is absent, and it has always been a working config. $BASH, so it is
# judged by the same bash that is about to read it.
if ! "${BASH:-bash}" -n "$DIR/config.sh"; then
  log "ralph: $DIR/config.sh does not parse (bash said so above) — refusing to start with only the settings before the error"
  exit 2
fi
# shellcheck disable=SC1091
. "$DIR/config.sh"

RESULTS="$DIR/results.tsv"
PROMPT_FILE="$DIR/.prompt"
NAME="$(basename "$DIR")"
# REPO itself is judged in the start section below rather than here, beside the
# source: a refused start tells the human, and notify() needs run_bounded,
# which is defined between the two. This default is the only thing between them
# that reads REPO, and setup_worktree replaces it when WORKTREE=1.
WORK="${REPO:-}"

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
  # A descriptor follows the file it was opened on, not the name, so without
  # this stderr would go on filling ralph.log.1 for the rest of the run — the
  # very bug ralph.out has, and the reason it cannot be rotated from outside.
  exec 2>>"$LOG"
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

# What a run costs comes back only as JSON (--output-format json), and reading
# JSON takes perl's JSON::PP, which Debian's perl-base ships without. Where it is
# missing, claude runs in text mode as it always did and no cost is recorded.
JSON_OK=0
if [ -n "$PERL" ] && "$PERL" -MJSON::PP -e1 2>/dev/null; then JSON_OK=1; fi

# json_text <json file> <text file>: appends the run's text, its result or, for
# a run that failed, its errors, to <text file>, and sets RUN_COST (dollars,
# as the CLI reports them) and RUN_TOKENS (input + output, cache reads not
# counted), each "-" when the run did not say. The output is one object, or an
# array of messages in verbose mode, whose last "result" is the one. A file that
# is not JSON, as from a run killed before it answered, is appended as it is.
RUN_COST="-"
RUN_TOKENS="-"
json_text() {
  local meta
  # shellcheck disable=SC2016  # perl's variables, not the shell's
  meta="$("$PERL" -MJSON::PP -e '
    local $/; my ($in, $out) = @ARGV;
    open my $f, "<", $in or exit 0; my $raw = <$f> // "";
    open my $o, ">>", $out or exit 0;
    my $j = eval { JSON::PP->new->utf8->decode($raw) };
    $j = (grep { ref $_ eq "HASH" && ($_->{type} // "") eq "result" } @$j)[-1] if ref $j eq "ARRAY";
    if (ref $j ne "HASH") { print $o $raw; print "-\t-"; exit 0 }
    binmode $o, ":utf8";
    my $u = ref $j->{usage} eq "HASH" ? $j->{usage} : {};
    my $tok = (defined $u->{input_tokens} || defined $u->{output_tokens})
      ? ($u->{input_tokens} // 0) + ($u->{output_tokens} // 0) : "-";
    my $cost = defined $j->{total_cost_usd} ? sprintf("%.4f", $j->{total_cost_usd}) : "-";
    if (ref $j->{errors} eq "ARRAY" && @{$j->{errors}} && !(defined $j->{result} && length $j->{result})) {
      print $o join("\n", map { ref $_ ? JSON::PP->new->canonical->encode($_) : $_ } @{$j->{errors}});
    } elsif (exists $j->{result}) { print $o ($j->{result} // "") }
    else { print $o $raw }
    print $o "\n";
    print "$cost\t$tok";
  ' "$1" "$2" 2>/dev/null)" || meta=""
  RUN_COST="${meta%%$'\t'*}"
  RUN_TOKENS="${meta#*$'\t'}"
  [ -n "$RUN_COST" ] && [ "$meta" != "$RUN_COST" ] || { RUN_COST="-"; RUN_TOKENS="-"; }
}

# add_cost / add_tokens <a> <b>: a sum in which "-" means nothing is known.
add_cost() {
  awk -v a="$1" -v b="$2" 'BEGIN { if (a == "-" && b == "-") { print "-"; exit }
    printf "%.4f\n", (a == "-" ? 0 : a) + (b == "-" ? 0 : b) }'
}
add_tokens() {
  awk -v a="$1" -v b="$2" 'BEGIN { if (a == "-" && b == "-") { print "-"; exit }
    printf "%d\n", (a == "-" ? 0 : a) + (b == "-" ? 0 : b) }'
}

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
  local secs="$1" input="$2" output="$3" last now gap elapsed=0 polls=0 cap
  shift 3
  # Not an opt-out: a value the harness cannot read as a tolerance, 0 included,
  # falls back to the default rather than to no cap, because no cap is the
  # defect below and not a setting anyone would want.
  cap="$POLL_GAP_MAX"
  [ "$cap" -ge 1 ] 2>/dev/null || cap=60
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
  last=$(date +%s)
  while kill -0 "$CHILD" 2>/dev/null; do
    # The budget is seconds the machine was awake, not wall clock. A suspended
    # machine stops polling and `date` jumps by the whole nap, so comparing
    # now - start kills a healthy agent on the first poll after the wake: seen
    # on a Mac asleep 09:52 to 15:40, recorded as 22710s with the reason
    # "timed out after 3600s" in the same row. Summing the gaps instead is the
    # same arithmetic while the machine is awake — consecutive readings
    # telescope to now - start exactly — and a gap longer than any poll asks
    # for is a suspend, so it costs the budget POLL_GAP_MAX seconds, no more. A
    # negative gap is the clock being set back; it counts as nothing rather
    # than handing time back.
    now=$(date +%s)
    gap=$(( now - last ))
    last=$now
    [ "$gap" -lt 0 ] && gap=0
    [ "$gap" -gt "$cap" ] && gap=$cap
    elapsed=$(( elapsed + gap ))
    if [ "$elapsed" -ge "$secs" ]; then
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

# notify <event> <message>: tell the human. The event reaches NOTIFY_CMD in the
# environment and never in its text, so a message holding a quote, a newline or
# a $(...) cannot become part of the command that runs — the hazard AGENTS.md
# records for sed, awk and config.sh, one tool further out. RALPH_EVENT is one
# of: stopped, refused, stuck, limit, limit-clear, decision.
#
# A notifier is not a gate. It is bounded by NOTIFY_TIMEOUT and its exit status
# is dropped, because an unreachable host must not be able to hold up, or stop,
# the loop the notification is about. RC and TIMED_OUT are put back for the
# same reason: they are how the gates read their own run_bounded, so a
# notification between a gate and its verdict must not be able to decide it.
# Every call below is already past that point; putting them back is what keeps
# the next call site from having to know.
notify() {
  [ -n "${NOTIFY_CMD:-}" ] || return 0
  local secs rc="$RC" timed="$TIMED_OUT"
  secs="${NOTIFY_TIMEOUT:-30}"
  [ "$secs" -ge 1 ] 2>/dev/null || secs=30
  run_bounded "$secs" /dev/null "$LOG" env \
    "RALPH_EVENT=$1" "RALPH_LOOP=$NAME" "RALPH_DIR=$DIR" "RALPH_ITER=$iter" \
    "RALPH_MESSAGE=$2" bash -c "$NOTIFY_CMD"
  if [ "$TIMED_OUT" = 1 ]; then
    log "notify: $1 timed out after ${secs}s and its process group was killed"
  elif [ "$RC" -ne 0 ]; then
    log "notify: $1 exited $RC (ignored; a notifier is not a gate)"
  fi
  RC="$rc"
  TIMED_OUT="$timed"
}

# refuse <message> [exit code]: a start that will not run an iteration. The one
# a human most needs to hear about, because a loop that never started has
# nothing else to notice — no log line arriving, no commits, no results row.
# One place, so every refusal below the config.sh source reaches the human and
# the next one added does too. The refusals above it cannot: NOTIFY_CMD is in
# the file they could not read or could not parse.
refuse() {
  log "$1"
  notify refused "$1"
  exit "${2:-1}"
}

# The "Needs a decision" section of PROGRESS.md is how the agent hands a
# blocker back — the escalation prompt tells it to write one there and take
# other work — and nothing read it: the loop went on, the note sat in a file
# and the human found it days later. Notified when the section changes and has
# text in it, once per change. What was already there when the loop started is
# not news, and neither is the template's own placeholder.
DECISION_SEEN="$DIR/.decision-seen"
decisions() {
  [ -f "$DIR/PROGRESS.md" ] || return 0
  awk '/^## Needs a decision/{f=1; next} f && /^## /{f=0} f' "$DIR/PROGRESS.md" \
    | grep -v '^[[:space:]]*$' | grep -Fv '_(nothing yet)_'
}
# Only lines that were not there before count. An agent rewrites PROGRESS.md
# whole every iteration, so a question settled, reworded or moved changes the
# section without asking anything new, and a notifier that fired on that would
# be noise a human learns to ignore.
check_decisions() {
  local now added
  [ -f "$DIR/PROGRESS.md" ] || return 0
  now="$(decisions)"
  if [ -f "$DECISION_SEEN" ]; then
    added="$(printf '%s\n' "$now" | grep -v '^$' | grep -Fxv -f "$DECISION_SEEN")"
  else
    added="$now"
  fi
  printf '%s\n' "$now" > "$DECISION_SEEN"
  [ -n "$added" ] || return 0
  log "PROGRESS.md has a new question under \"Needs a decision\" — the agent is asking a human"
  notify decision "$(printf '%s' "$added" | head -c 1000)"
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

# record <before> <after> <status> <seconds> <reason> [cost] [tokens]
# The cost columns come after reason, so every reader that counts columns from
# the left reads what it always read, and a file started by an older harness
# keeps its seven-column header.
record() {
  [ -f "$RESULTS" ] || printf 'time\titer\tbefore\tafter\tstatus\tsecs\treason\tcost_usd\ttokens\n' > "$RESULTS"
  local reason
  reason="$(printf '%s' "${5:-}" | tr '\t\n\r' '   ' | cut -c1-300)"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$iter" \
    "${1:0:12}" "${2:0:12}" "$3" "$4" "${reason:--}" "${6:--}" "${7:--}" >> "$RESULTS"
}

# The streak the prompt escalates on, told to the human as it is reached and
# not again: from here the prompt is already telling the agent to pivot, and
# every iteration after this one is the same news. Called from both arms that
# raise $trouble, because a revert streak and a crash streak are the same
# trouble to a human and the counter is shared.
streak_notice() {
  [ "$ESCALATE_AFTER" -gt 0 ] || return 0
  [ "$trouble" -eq "$ESCALATE_AFTER" ] || return 0
  notify stuck "$trouble iterations in a row were reverted or failed; the last: $status — ${reason:-no reason recorded}"
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
    # Said whether or not the '## Log' heading is there. A file with the heading
    # and no entries yet is a new loop; a file without it is one whose agent
    # reshaped its own memory, and then this cap can see nothing to count.
    # Either way the entry cap is doing nothing and PROGRESS_MAX_BYTES is the
    # only bound left, so a human reading the log should hear it once.
    [ -n "$CAP_WARNED" ] || log "progress cap: no '### ' entries under a '## Log' heading in PROGRESS.md, so the entry cap does nothing; the prompt is bounded by PROGRESS_MAX_BYTES alone"
    CAP_WARNED=1
    return 0
  fi
  [ "$n" -gt "$PROGRESS_KEEP" ] || return 0

  tmp="$f.tmp.$$"
  over="$DIR/.progress-overflow.$$"
  : > "$over"
  # ENVIRON and not -v for the path: awk processes escape sequences in a -v
  # value, so a backslash anywhere in $DIR reached awk as a *different* path —
  # `\t` as a tab, an unknown escape such as `\q` with the backslash dropped,
  # which maps one real directory onto another. Then either awk cannot open it,
  # the `||` below swallows that, and this cap silently does nothing for the
  # rest of the run; or it can, and awk writes the overflow into a directory
  # the loop does not own while the shell reads the un-mangled name, finds the
  # empty file it made itself, appends nothing to the archive and lets the mv
  # truncate PROGRESS.md regardless — the loop's memory destroyed, and logged
  # as archived. awk does not rescan the environment. `keep` stays on -v: it is
  # a number, and a number has no escapes to process.
  RALPH_OVERFLOW="$over" awk -v keep="$PROGRESS_KEEP" '
    BEGIN              { over = ENVIRON["RALPH_OVERFLOW"] }
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

# The cap above keeps PROGRESS.md at PROGRESS_KEEP entries, but it counts '### '
# entries under a '## Log' heading — and the agent is what writes both. Rename
# either and the cap silently counts nothing; keep them and one enormous entry
# is still under the cap however big it grows. So the bound that matters was
# enforced inside the model, against the invariant that gates live outside it.
#
# What kills a loop is the prompt, not the file, and the prompt is the harness's
# alone. This is the bound no shape the agent invents can switch off: inject at
# most PROGRESS_MAX_BYTES, and never touch the file, so nothing is lost. The
# head of the file is what survives because the newest entry is at the top by
# convention — the same end the entry cap keeps — and the agent is told in the
# prompt where to read the rest.
#
# LC_ALL=C because length() counts characters, and a PROGRESS.md full of em
# dashes would then be let through at up to three bytes each. The awk here
# counts bytes in either locale, so this is for the machines where it does not.
# It cannot log for itself: this runs inside the group build_prompt redirects
# into the prompt file, and log() tees to stdout, so the line would be injected
# rather than logged. It leaves the message in INJECT_NOTE instead.
INJECT_WARNED=""
INJECT_NOTE=""
inject_progress() {
  local f="$DIR/PROGRESS.md" bytes
  bytes=$(wc -c < "$f" | tr -d ' ')
  if ! [ "$PROGRESS_MAX_BYTES" -gt 0 ] 2>/dev/null || [ "$bytes" -le "$PROGRESS_MAX_BYTES" ]; then
    cat "$f"
    return 0
  fi
  LC_ALL=C awk -v max="$PROGRESS_MAX_BYTES" '
    { n += length($0) + 1; if (n > max) exit } 1
  ' "$f"
  printf '\n[Cut off here by the harness: PROGRESS.md is %s bytes and at most %s are injected. The whole file is on disk at %s — read it if you need what is missing from the end. Then shorten it, because a prompt that keeps growing is what ends a loop.]\n' \
    "$bytes" "$PROGRESS_MAX_BYTES" "$f"
  [ -n "$INJECT_WARNED" ] || INJECT_NOTE="progress cap: PROGRESS.md is $bytes bytes, over PROGRESS_MAX_BYTES=$PROGRESS_MAX_BYTES — injecting its first $PROGRESS_MAX_BYTES bytes and leaving the file alone"
  INJECT_WARNED=1
}

# The commits this loop kept, newest first, as git has them. Each agent otherwise
# knows only what its predecessors wrote down, and that is how a loop carried a
# closed item forward for three entries and spent three iterations on one topic.
# Built from the keep rows, not from `git log`, which on a shared branch also
# shows commits by people and by other loops. Subjects are cut, so the prompt
# stays bounded whatever the agents write.
shipped_recently() {
  [ -f "$RESULTS" ] || return 0
  local lines
  lines="$(tail -n +2 "$RESULTS" \
    | awk -F'\t' '$5 ~ /^keep/ {r[n++] = $3 " " $4} END {for (i = n - 1; i >= 0 && i >= n - 5; i--) print r[i]}' \
    | while read -r b a; do git log --format='%h %s' "$b..$a" 2>/dev/null; done \
    | cut -c1-200 | head -n 10)"
  [ -n "$lines" ] || return 0
  printf '\n---\n\n# What this loop shipped recently (from git, newest first)\n\n%s\n' "$lines"
}

in_active_hours() {
  [ -n "$ACTIVE_HOURS" ] || return 0
  local h s e
  h=$((10#$(date +%H)))
  s=$((10#${ACTIVE_HOURS%-*}))
  e=$((10#${ACTIVE_HOURS#*-}))
  if [ "$s" -lt "$e" ]; then
    [ "$h" -ge "$s" ] && [ "$h" -lt "$e" ]
  else
    [ "$h" -ge "$s" ] || [ "$h" -lt "$e" ]
  fi
}

# Before an iteration, never during one: a running agent is not cut off. The
# wait is not an iteration and does not count toward MAX_ITER.
wait_for_active_hours() {
  in_active_hours && return 0
  log "outside ACTIVE_HOURS=$ACTIVE_HOURS — waiting for the window to open"
  until in_active_hours; do nap "$ACTIVE_POLL"; done
  log "inside ACTIVE_HOURS=$ACTIVE_HOURS — going on"
}

build_prompt() {
  INJECT_NOTE=""
  {
    cat "$DIR/PROMPT.md"
    printf '\n---\n\n# PROGRESS.md (your memory of previous iterations — read this before doing anything)\n\n'
    inject_progress
    if [ -s "$DIR/PROGRESS-archive.md" ]; then
      printf '\nOlder Log entries are in %s. Read it only when you need that history.\n' "$DIR/PROGRESS-archive.md"
    fi

    if [ -f "$RESULTS" ]; then
      printf '\n---\n\n# Harness verdicts (ground truth: where PROGRESS.md disagrees, this wins)\n\n'
      printf 'The last iterations as the harness recorded them. "revert:*" means the commits were reset and never shipped.\n\n'
      head -n 1 "$RESULTS" | cut -f1-7
      tail -n +2 "$RESULTS" | tail -n 10 | cut -f1-7
    fi
    shipped_recently

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
  [ -z "$INJECT_NOTE" ] || log "$INJECT_NOTE"
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

# save_ref <reverted|dropped> <commit>: keep a commit the gates threw away, so
# a human can still get it back through `ralph review`, and let go of the
# oldest beyond REF_KEEP. A ref is the only thing keeping such a commit
# reachable, so unbounded these make `git gc` unable to ever reclaim the
# objects: a long run pins one whole tree per thrown-away iteration, for good,
# in the repository being worked on. Bounded the way ralph.log is. REF_KEEP=0
# keeps every ref, which is what the harness used to do.
#
# Oldest is by the epoch in the refname — when the work was set aside, which is
# not the commit's own date: a commit from an interrupted iteration is set
# aside long after it was made. Numeric, because by name 1758400010-10 sorts
# under 1758400002-2.
save_ref() {
  local ns="$1" ref
  git update-ref "refs/ralph/$ns/$(date +%s)-$iter" "$2" 2>/dev/null
  [ "${REF_KEEP:-0}" -ge 1 ] 2>/dev/null || return 0
  git for-each-ref --format='%(refname)' "refs/ralph/$ns/" \
    | sort -t/ -k4,4 -rn | tail -n +$((REF_KEEP + 1)) \
    | while IFS= read -r ref; do git update-ref -d "$ref"; done
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
    refuse "$WORK is not a worktree of $REPO — refusing to reset a checkout this loop does not own"
  fi
  git -C "$REPO" worktree prune
  if git -C "$REPO" show-ref --verify --quiet "refs/heads/ralph/$NAME"; then
    # Reuse the branch as it is. `worktree add -B` would reset it and lose kept work.
    git -C "$REPO" worktree add -q "$WORK" "ralph/$NAME" >> "$LOG" 2>&1 \
      || refuse "cannot create worktree $WORK"
  else
    local base="$BRANCH"
    git -C "$REPO" fetch -q origin "$BRANCH" >> "$LOG" 2>&1 && base="origin/$BRANCH"
    git -C "$REPO" worktree add -q -b "ralph/$NAME" "$WORK" "$base" >> "$LOG" 2>&1 \
      || refuse "cannot create worktree $WORK from $base"
    if [ -n "$SETUP_CMD" ]; then
      log "setup: $SETUP_CMD"
      if ! (cd "$WORK" && bash -c "$SETUP_CMD") >> "$LOG" 2>&1; then
        # The branch goes with the worktree. Keeping it sent the next start down
        # the "reuse the branch" path above, which never runs SETUP_CMD, so the
        # loop ran for good in a worktree its own setup had never prepared.
        git -C "$REPO" worktree remove --force "$WORK" >/dev/null 2>&1
        git -C "$REPO" branch -q -D "ralph/$NAME" >/dev/null 2>&1
        refuse "SETUP_CMD failed; removed the new worktree and branch ralph/$NAME, so the next start runs setup again"
      fi
    fi
  fi
  [ "$(git_home "$WORK")" = "$(git_home "$REPO")" ] \
    || refuse "worktree $WORK is not usable"
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
# Set only when the review was abandoned at the REVIEW_LIMIT_TRIES ceiling, so
# the recorded reason says a limit rather than blaming the reviewer's exit code.
REVIEW_LIMIT_TRIED=0
review() {
  local before="$1" job steering
  REVIEW_LIMIT_TRIED=0
  # A job the harness cannot read is not a job. Asked with an empty brief the
  # reviewer still answers, and the answer is worth nothing: it cannot say
  # "this is not what the loop asked for", which is the one thing it is here
  # for, so an ACCEPT out of it would ship work nobody judged. Hand it to the
  # unavailable path below, which is the harness's existing answer to a
  # reviewer it cannot get — and do it before spending the call. The loop
  # itself stops at the top of the next iteration.
  if ! have_files PROMPT.md; then
    REVIEW_STATUS=unavailable
    GATE_REASON="$MISSING_FILE is gone, so there is no job to review against"
    return 0
  fi
  { git diff --stat "$before" HEAD; echo; git diff "$before" HEAD; } | head -c 200000 > "$DIR/review.diff"
  job="$(awk '/^## The job/{f=1; next} /^## /{f=0} f' "$DIR/PROMPT.md")"
  # A PROMPT.md written without that heading is still the job. Better the
  # reviewer reads all of it than judges the diff against nothing at all.
  [ -n "$job" ] || job="$(cat "$DIR/PROMPT.md")"
  steering="$(awk '/^## Steering/{f=1; next} /^## /{f=0} f' "$DIR/PROMPT.md")"
  # The human's picture of the finished result, unless it is still the
  # template's <placeholder>, which pictures nothing.
  local done_like done_block=""
  done_like="$(awk '/^## Done looks like/{f=1; next} /^## /{f=0} f' "$DIR/PROMPT.md")"
  if printf '%s' "$done_like" | grep -q '[^[:space:]]' \
    && ! printf '%s' "$done_like" | tr -d '\n' | grep -Eq '^[[:space:]]*<.*>[[:space:]]*$'; then
    done_block="
## What done looks like (from the human)

$done_like

Hold the commit against this, as one step toward it. Reject a commit that
contradicts it, or one that claims the job is done while this is not met. A step
that is merely not the finished result yet is not a reason to reject.
"
  fi
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
$done_block
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
  local verdict tries=0
  local rargs=(-p --restricted --tools "Read,Grep,Glob" --strict-mcp-config
    --permission-prompts none --add-dir "$DIR" --model "${REVIEW_MODEL:-$MODEL}")
  while :; do
    : > "$DIR/review.out"
    if [ "$JSON_OK" = 1 ]; then
      # stdout is JSON; stderr goes straight to review.out, and the text is
      # appended after it, so the VERDICT line and a limit's message are read
      # from text exactly as before.
      : > "$DIR/.review.json"
      # shellcheck disable=SC2016  # expanded by the inner sh, on purpose
      run_bounded "$ITER_TIMEOUT" "$DIR/.review-prompt" "$DIR/.review.json" \
        sh -c 'exec "$@" 2>>"$0"' "$DIR/review.out" claude "${rargs[@]}" --output-format json
      json_text "$DIR/.review.json" "$DIR/review.out"
      REVIEW_COST="$(add_cost "$REVIEW_COST" "$RUN_COST")"
      REVIEW_TOKENS="$(add_tokens "$REVIEW_TOKENS" "$RUN_TOKENS")"
    else
      run_bounded "$ITER_TIMEOUT" "$DIR/.review-prompt" "$DIR/review.out" claude "${rargs[@]}"
    fi
    cat "$DIR/review.out" >> "$LOG"
    verdict="$(grep -a '^VERDICT:' "$DIR/review.out" | tail -n 1)"
    # A limit is not an answer: wait it out and ask again, rather than ship the
    # commit unreviewed or throw it away. But bounded, unlike the agent's limit.
    # The agent hits its limit with nothing pending, so waiting costs nothing;
    # the reviewer hits it holding a commit that passed verify and that no gate
    # has judged. While we wait there is no results.tsv row, MAX_ITER does not
    # advance, and a restart sets that commit aside as unjudged — so a limit
    # that never clears (a spent credit balance) parks the loop for good. After
    # REVIEW_LIMIT_TRIES, hand it to the unavailable path below, which is the
    # harness's existing answer to a reviewer it cannot get.
    if [ -z "$verdict" ] && [ "$RC" -ne 0 ] && [ "$TIMED_OUT" = 0 ] \
      && tail -n 20 "$DIR/review.out" | grep -Eqi "$RATE_LIMIT_RE"; then
      tries=$((tries + 1))
      if [ "$REVIEW_LIMIT_TRIES" -gt 0 ] 2>/dev/null \
        && [ "$tries" -ge "$REVIEW_LIMIT_TRIES" ]; then
        REVIEW_LIMIT_TRIED=$tries
        break
      fi
      log "reviewer hit a limit — asking again in ${RATE_LIMIT_SLEEP}s (try $tries of ${REVIEW_LIMIT_TRIES})"
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
      if [ "$REVIEW_LIMIT_TRIED" -gt 0 ]; then
        GATE_REASON="reviewer hit a limit; gave up at try $REVIEW_LIMIT_TRIED of $REVIEW_LIMIT_TRIES"
      else
        GATE_REASON="reviewer gave no verdict (exit $RC, timed out $TIMED_OUT)"
      fi
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
  save_ref dropped "$head"
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
      save_ref dropped "$head"
      git reset -q --hard "$upstream"
      record "$head" "$(git rev-parse HEAD)" "drop:conflict" 0 \
        "rebase onto $upstream conflicted; unpushed commits dropped, saved under refs/ralph/dropped/"
      log "sync: rebase conflicted, dropped unpushed commits (saved under refs/ralph/dropped/)"
      return 0
    fi
    if ! verify; then
      save_ref dropped HEAD
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

# The config's own two fatals. Same words, same exit code and same log line as
# when they sat beside the source above; what is new is that they come through
# refuse(), so a human hears about a loop that never started.
[ -n "${REPO:-}" ] || refuse "ralph: config.sh must set REPO" 2
[ -e "$REPO/.git" ] || refuse "ralph: REPO is not a git checkout: $REPO" 2

# ACTIVE_HOURS is read as numbers with 10# everywhere: bash takes a leading
# zero for octal, so $((08)) is an error that ends the script, at 08:00 and
# 09:00 every day. A window that opens and closes at once is refused rather
# than guessed at.
if [ -n "$ACTIVE_HOURS" ]; then
  case "$ACTIVE_HOURS" in
    [0-9]-[0-9]|[0-9][0-9]-[0-9]|[0-9]-[0-9][0-9]|[0-9][0-9]-[0-9][0-9]) ;;
    *) refuse "ralph: ACTIVE_HOURS=$ACTIVE_HOURS is not hours like 22-08" 2 ;;
  esac
  if [ $((10#${ACTIVE_HOURS%-*})) -gt 23 ] || [ $((10#${ACTIVE_HOURS#*-})) -gt 23 ] \
    || [ $((10#${ACTIVE_HOURS%-*})) -eq $((10#${ACTIVE_HOURS#*-})) ]; then
    refuse "ralph: ACTIVE_HOURS=$ACTIVE_HOURS must be two different hours from 0 to 23" 2
  fi
fi
[ "$ACTIVE_POLL" -ge 1 ] 2>/dev/null || ACTIVE_POLL=300

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
cd "$WORK" || refuse "cannot enter the work directory $WORK"
if [ "$WORKTREE" = 1 ]; then
  drop_unjudged
fi

if [ "$LIVE_STEER" = 1 ]; then
  printf '{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"\\"%s\\""}]}]}}\n' \
    "$HARNESS/hooks/steer.sh" > "$DIR/.agent-settings.json"
fi

log "ralph start: loop=$NAME repo=$REPO work=$WORK model=$MODEL max_iter=$MAX_ITER quiet_stop=$QUIET_STOP worktree=$WORKTREE push=$PUSH review=$REVIEW verify=${VERIFY_CMD:+yes}"
[ "$JSON_OK" = 1 ] || log "cost: this perl has no JSON::PP, so claude runs in text mode and no cost is recorded"

quiet=0
trouble=0
errors=0
limits=0
# Why the loop ended, for the one notification at the bottom. Every break below
# sets it and logs it in the same words, so a stop the human hears about and a
# stop in the log can never say different things — and a break added later is
# notified whether or not whoever writes it knows this exists.
stop_why=""
# What the loop was already being asked before it started is not news; only
# what an agent of this run writes is.
decisions > "$DECISION_SEEN"
while :; do
  wait_for_active_hours
  iter=$((iter + 1))
  if [ "$iter" -gt "$MAX_ITER" ]; then
    iter=$((iter - 1))   # this one never ran; do not count it
    stop_why="hit MAX_ITER=$MAX_ITER"
    log "stopping: $stop_why"
    break
  fi
  # The other gate on whether this iteration runs at all. Refusing is the same
  # answer the start gives, for the same reason: half a prompt is not a prompt,
  # and an agent handed one under --dangerously-skip-permissions does something
  # with it. A human who wants the loop back puts the file back and restarts.
  if ! have_files PROMPT.md PROGRESS.md; then
    iter=$((iter - 1))   # this one never ran; do not count it
    stop_why="$MISSING_FILE is gone or unreadable at $DIR/$MISSING_FILE — every iteration re-reads it, and the harness will not run an agent without it"
    log "stopping: $stop_why"
    break
  fi

  rotate_log
  if [ "$WORKTREE" = 1 ]; then
    if [ "$PUSH" = 1 ]; then sync; else clean_tree; fi
  fi
  # The same text already sits in PROMPT.md's Steering section, which this
  # iteration reads; the live file is only for the iteration in flight.
  [ "$LIVE_STEER" = 1 ] && : > "$DIR/STEER.md" && : > "$DIR/STEER.md.delivered"

  # After the sync, so a push that failed after the last keep has been retried
  # and nothing DONE_CMD approves can still be dropped by it.
  if [ -n "$DONE_CMD" ]; then
    : > "$DIR/done.out"
    run_bounded 300 /dev/null "$DIR/done.out" \
      env "RALPH_DIR=$DIR" "RALPH_LOOP=$NAME" bash -c "$DONE_CMD"
    if [ "$RC" -eq 0 ] && [ "$TIMED_OUT" = 0 ]; then
      iter=$((iter - 1))   # this one never ran; do not count it
      unpushed=""
      if [ "$WORKTREE" = 1 ] && [ "$PUSH" = 1 ]; then
        unpushed="$(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null)"
        [ "${unpushed:-0}" -gt 0 ] 2>/dev/null || unpushed=""
      fi
      stop_why="DONE_CMD says the job is done${unpushed:+ — $unpushed kept commits are still not pushed}"
      log "stopping: $stop_why"
      break
    fi
  fi

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
  for d in ${DENY[@]+"${DENY[@]}"}; do
    args+=(--disallowedTools "$d")
  done

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
  AGENT_COST="-"; AGENT_TOKENS="-"; REVIEW_COST="-"; REVIEW_TOKENS="-"
  if [ "$JSON_OK" = 1 ]; then
    # stdout is JSON; stderr goes to the log as it happens, and the text is
    # appended after it, so the log reads as before and a limit's message is
    # still among the last lines the limit check reads. The wrapper execs, so
    # the pid and the process group are claude's.
    : > "$DIR/.run.json"
    # shellcheck disable=SC2016  # expanded by the inner sh, on purpose
    run_bounded "$ITER_TIMEOUT" "$PROMPT_FILE" "$DIR/.run.json" \
      sh -c 'exec "$@" 2>>"$0"' "$LOG" env "${envs[@]}" claude "${args[@]}" --output-format json
    agent_rc=$RC
    agent_timed_out=$TIMED_OUT
    json_text "$DIR/.run.json" "$LOG"
    AGENT_COST="$RUN_COST"; AGENT_TOKENS="$RUN_TOKENS"
  else
    run_bounded "$ITER_TIMEOUT" "$PROMPT_FILE" "$LOG" env "${envs[@]}" claude "${args[@]}"
    agent_rc=$RC
    agent_timed_out=$TIMED_OUT
  fi

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

  iter_cost="$(add_cost "$AGENT_COST" "$REVIEW_COST")"
  iter_tokens="$(add_tokens "$AGENT_TOKENS" "$REVIEW_TOKENS")"

  case "$status" in
    revert:*)
      save_ref reverted "$after"
      if ! revert_to "$before"; then
        record "$before" "$after" "$status" "$took" "$reason" "$iter_cost" "$iter_tokens"
        stop_why="could not reset ralph/$NAME to $before after $status — fix the worktree by hand"
        log "stopping: $stop_why"
        break
      fi
      ;;
  esac
  record "$before" "$after" "$status" "$took" "$reason" "$iter_cost" "$iter_tokens"

  # A limit streak clears the moment claude answers again, whatever the verdict
  # of that iteration is. Said once, at the end of the streak, like the limit
  # itself: the iterations in between are the same news over again.
  if [ "$status" != ratelimit ] && [ "$limits" -gt 0 ]; then
    notify limit-clear "claude answered again after $limits iteration(s) waiting out a limit"
    limits=0
  fi
  # Before the case below, not after: a human hears about a question now rather
  # than up to an hour later, once the naps in there have had their turn, and
  # the two `break`s inside it cannot jump over a call made above it.
  check_decisions

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
        stop_why="$QUIET_STOP consecutive iterations shipped nothing"
        log "stopping: $stop_why"
        break
      fi
      nap "$QUIET_SLEEP"
      ;;
    ratelimit)
      limits=$((limits + 1))
      log "iteration $iter hit a limit: $reason — trying it again in ${RATE_LIMIT_SLEEP}s"
      # The first of the streak only. A loop can wait out a weekly limit over
      # dozens of iterations, and a human needs to hear that once.
      [ "$limits" -eq 1 ] && notify limit "$reason"
      # Waiting out a limit is not work, so it does not use up MAX_ITER.
      iter=$((iter - 1))
      nap "$RATE_LIMIT_SLEEP"
      ;;
    timeout|error)
      trouble=$((trouble + 1)); errors=$((errors + 1))
      log "iteration $iter $status: $reason (errors in a row $errors)"
      streak_notice
      if [ "$ERROR_STOP" -gt 0 ] && [ "$errors" -ge "$ERROR_STOP" ]; then
        stop_why="$ERROR_STOP consecutive iterations failed"
        log "stopping: $stop_why"
        break
      fi
      nap "$(trouble_sleep)"
      ;;
    revert:*)
      trouble=$((trouble + 1)); errors=0
      log "iteration $iter reverted to $before: $status — $reason"
      streak_notice
      nap "$(trouble_sleep)"
      ;;
  esac

  cap_progress
  nap "$STEP_SLEEP"
done

rm -f "$DIR/ralph.pid"
log "ralph finished after $iter iterations"
# The one stop notification, for every way the loop can end. Not for a signal:
# `ralph stop` and a reboot are the human's own doing, and on_signal exits
# before this. ${stop_why:-...} because a break added later that forgets to set
# it should still be heard about, if less usefully.
notify stopped "${stop_why:-the loop ended} (after $iter iterations)"
