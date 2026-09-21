#!/usr/bin/env bash
#
# End-to-end tests for ralph.sh and the ralph CLI. No network, no credentials:
# a stub stands in for claude (tests/stub/claude) and a bare repository stands
# in for origin.
#
#   tests/run.sh                     run with the bash on PATH
#   RALPH_BASH=/bin/bash tests/run.sh   run the loop under another bash (3.2 on macOS)

# The single-quoted `bash -c '...' _ "$arg"` checks expand $1 in the child on purpose.
# shellcheck disable=SC2016

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RALPH_BASH="${RALPH_BASH:-bash}"
# cd+pwd normalises the path: macOS sets TMPDIR with a trailing slash, so mktemp
# hands back a doubled slash, and paths the harness normalises stop matching it.
T="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/ralph-test.XXXXXX")" && pwd)"
trap 'rm -rf "$T"' EXIT

export PATH="$ROOT/tests/stub:$PATH"
export GIT_AUTHOR_NAME="ralph test" GIT_AUTHOR_EMAIL="test@example.invalid"
export GIT_COMMITTER_NAME="ralph test" GIT_COMMITTER_EMAIL="test@example.invalid"

fails=0
pass() { printf '  \033[32mok\033[0m    %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fails=$((fails + 1)); }
check() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$what"; else fail "$what"; fi; }
section() { printf '\n%s\n' "$*"; }

statuses() { tail -n +2 "$1/results.tsv" | cut -f5 | tr '\n' ' ' | sed 's/ $//'; }

# make_repo <dir> <remote>: a checkout of a fresh bare remote with one commit.
make_repo() {
  git init -q --bare -b main "$2"
  git init -q -b main "$1"
  (
    cd "$1" || exit 1
    printf '#!/bin/sh\ntest ! -f BAD\n' > measure.sh
    chmod +x measure.sh
    echo "start" > work.txt
    git add -A && git commit -qm "initial"
    git remote add origin "$2"
    git push -q -u origin main
  )
}

# make_loop <dir> <repo> <extra config lines...>
make_loop() {
  local dir="$1" repo="$2"
  shift 2
  mkdir -p "$dir"
  cp "$ROOT/template/PROMPT.md" "$ROOT/template/PROGRESS.md" "$dir/"
  {
    echo "REPO=\"$repo\""
    echo "QUIET_SLEEP=0 STEP_SLEEP=0 ERROR_SLEEP=0 RATE_LIMIT_SLEEP=0"
    for line in "$@"; do echo "$line"; done
  } > "$dir/config.sh"
}

run_loop() { STUB_DIR="$2" STUB_REMOTE="${3:-}" "$RALPH_BASH" "$ROOT/ralph.sh" "$1" > "$1/ralph.out" 2>&1; }

echo "ralph tests — loop under: $("$RALPH_BASH" -c 'echo "$BASH_VERSION"')"

# ---------------------------------------------------------------------------
section "gates, verdicts and pushes (WORKTREE=1 PUSH=1 REVIEW=1)"

make_repo "$T/app" "$T/remote.git"
S="$T/stub-a"; mkdir -p "$S"
printf '%s\n' commit commit-bad touch-frozen commit sleep limit fail nothing cheat push-attempt conflict > "$S/modes"
printf '%s\n' ACCEPT "REJECT: not what the job asks for" ACCEPT ACCEPT > "$S/verdicts"
make_loop "$T/loops/a" "$T/app" \
  'WORKTREE=1 PUSH=1 REVIEW=1 ITER_TIMEOUT=3 MAX_ITER=10' \
  "VERIFY_CMD=\"env > '$T/loops/a/verify-env'; ./measure.sh\"" 'FROZEN=("measure.sh")'
app_head="$(git -C "$T/app" rev-parse HEAD)"
run_loop "$T/loops/a" "$S" "$T/remote.git"

want="keep revert:verify revert:frozen revert:review timeout ratelimit error quiet revert:verify keep keep drop:conflict"
got="$(statuses "$T/loops/a")"
if [ "$got" = "$want" ]; then pass "verdicts in order: $got"; else fail "verdicts: got [$got] want [$want]"; fi

W="$T/app-ralph-a"
check "worktree created next to the repo" test -d "$W"
remote_log="$(git -C "$T/remote.git" log --format=%s main)"
check "first kept commit reached origin" grep -q 'stub: work (agent call 1)' <<<"$remote_log"
check "commit kept after the agent's own push attempt reached origin" grep -q 'stub: pushed' <<<"$remote_log"
check "rejected commits never reached origin" \
  bash -c '! grep -Eq "stub: (bad|frozen|cheat)|agent call 4" <<<"$1"' _ "$remote_log"
check "human commit survived; conflicting agent commit was dropped" \
  bash -c 'grep -q "human: edit work.txt" <<<"$1" && ! grep -q "stub: conflicting" <<<"$1"' _ "$remote_log"
check "dropped commit saved under refs/ralph/dropped/" test -n "$(git -C "$W" for-each-ref refs/ralph/dropped/)"
check "the agent's own git push failed" test "$(cat "$S/push-attempt.rc")" != 0
check "your checkout was never touched" test "$(git -C "$T/app" rev-parse HEAD)" = "$app_head"
check "your checkout is clean" test -z "$(git -C "$T/app" status --porcelain)"
check "worktree is clean after the run" test -z "$(git -C "$W" status --porcelain)"
check "uncommitted edit to the frozen file was discarded" grep -q 'test ! -f BAD' "$W/measure.sh"
check "the prompt tells the agent not to push" grep -q 'do not push' "$S/prompt.agent.1"
check "the prompt lists frozen files" grep -q 'Frozen, never edit: measure.sh' "$S/prompt.agent.1"
check "iteration 2 sees the harness verdicts" grep -q '# Harness verdicts' "$S/prompt.agent.2"
check "after 3 failures the prompt says pivot" grep -q 'Do not retry that approach' "$S/prompt.agent.5"
check "a quiet iteration clears the escalation" bash -c '! grep -q "Harness: stuck" "$1"' _ "$S/prompt.agent.9"
check "the reviewer was only asked about commits that passed verify" test "$(cat "$S/review_calls")" = 4
check "the reviewer prompt points at the diff file" grep -q 'review.diff' "$S/prompt.review.1"
check "timeout killed the agent's process group" bash -c '! pgrep -f "sleep 99[9]" >/dev/null'
check "usage-limit reason recorded" grep -q "hit your limit" "$T/loops/a/results.tsv"
check "no harness variable leaks into the agent's environment" test ! -s "$S/leaked-env"
check "no harness variable leaks into VERIFY_CMD" bash -c '! grep -q "^BOUNDED_" "$1"' _ "$T/loops/a/verify-env"
check "reverted commits are kept under refs/ralph/reverted/" \
  test "$(git -C "$W" for-each-ref refs/ralph/reverted/ | wc -l | tr -d ' ')" -ge 4
review_a="$(RALPH_HOME="$T/loops" "$ROOT/ralph" review a)"
check "review shows what shipped" grep -q "stub: work (agent call 1)" <<<"$review_a"
check "review shows what the gates threw away" \
  bash -c 'sed -n "/Reverted or dropped/,\$p" <<<"$1" | grep -q "stub: bad"' _ "$review_a"

# ---------------------------------------------------------------------------
section "escalation and the PROGRESS.md cap"

make_repo "$T/app-b" "$T/remote-b.git"
S="$T/stub-b"; mkdir -p "$S"
printf '%s\n' commit-bad commit-bad commit-bad commit-bad commit-bad commit-bad nothing > "$S/modes"
make_loop "$T/loops/b" "$T/app-b" \
  'WORKTREE=1 PUSH=1 MAX_ITER=7 PROGRESS_KEEP=8' 'VERIFY_CMD="./measure.sh"'
{
  sed '/^## Log/,$d' "$ROOT/template/PROGRESS.md"
  printf '## Log\n\n'
  for i in 12 11 10 9 8 7 6 5 4 3 2 1; do printf '### 2026-01-%02d 10:00 — iteration %s\n\nentry %s\n\n' "$i" "$i" "$i"; done
} > "$T/loops/b/PROGRESS.md"
run_loop "$T/loops/b" "$S" "$T/remote-b.git"

check "six rejected commits in a row then quiet" \
  test "$(statuses "$T/loops/b")" = "revert:verify revert:verify revert:verify revert:verify revert:verify revert:verify quiet"
check "after 3 in a row: pivot" grep -q 'Do not retry that approach' "$S/prompt.agent.4"
check "after 6 in a row: hand it to a human" grep -q 'Needs a decision' <(sed -n '/Harness: stuck/,$p' "$S/prompt.agent.7")
check "PROGRESS.md keeps 8 Log entries" test "$(grep -c '^### ' "$T/loops/b/PROGRESS.md")" = 8
check "PROGRESS.md keeps the newest entries" grep -q 'iteration 12$' "$T/loops/b/PROGRESS.md"
check "PROGRESS.md keeps its head sections" grep -q '^## Needs a decision' "$T/loops/b/PROGRESS.md"
check "archive holds the 4 oldest entries, oldest first" \
  test "$(grep '^### ' "$T/loops/b/PROGRESS-archive.md" | sed 's/.*iteration //' | tr '\n' ' ')" = "1 2 3 4 "
check "later prompts point at the archive" grep -q 'PROGRESS-archive.md' "$S/prompt.agent.2"
check "nothing reached origin" test "$(git -C "$T/remote-b.git" rev-list --count main)" = 1

# ---------------------------------------------------------------------------
section "old-style loop (WORKTREE=0, every new setting left at its default)"

make_repo "$T/app-c" "$T/remote-c.git"
S="$T/stub-c"; mkdir -p "$S"
printf '%s\n' commit nothing > "$S/modes"
make_loop "$T/loops/c" "$T/app-c" 'MAX_ITER=2'
c_before="$(git -C "$T/app-c" rev-parse HEAD)"
run_loop "$T/loops/c" "$S" "$T/remote-c.git"

check "keep then quiet" test "$(statuses "$T/loops/c")" = "keep quiet"
check "the agent committed straight into the checkout" test "$(git -C "$T/app-c" rev-list --count "$c_before..HEAD")" = 1
check "no worktree was made" test ! -e "$T/app-c-ralph-c"
check "nothing was pushed" test "$(git -C "$T/remote-c.git" rev-list --count main)" = 1
check "empty FROZEN=() did not break set -u" bash -c '! grep -q "unbound variable" "$1"' _ "$T/loops/c/ralph.out"

# ---------------------------------------------------------------------------
section "CLI: new, start, status, steer, results, stop"

make_repo "$T/app-d" "$T/remote-d.git"
S="$T/stub-d"; mkdir -p "$S"
printf '%s\n' sleep > "$S/modes"
export RALPH_HOME="$T/home"
"$ROOT/ralph" new demo "$T/app-d" >/dev/null
check "ralph new scaffolds the loop" test -f "$RALPH_HOME/demo/config.sh"
check "ralph new fills in the repo path" grep -q "REPO=\"$T/app-d\"" "$RALPH_HOME/demo/config.sh"
echo 'QUIET_SLEEP=0 STEP_SLEEP=0 ERROR_SLEEP=0 ITER_TIMEOUT=600 REVIEW=0 PUSH=0' >> "$RALPH_HOME/demo/config.sh"
STUB_DIR="$S" "$ROOT/ralph" start demo >/dev/null
for _ in $(seq 1 50); do [ -s "$S/modes.done" ] && break; sleep 0.2; done
check "the loop is running" bash -c '"$1" status demo | grep -q running' _ "$ROOT/ralph"
check "status shows the worktree" bash -c '"$1" status demo | grep -q "ralph/demo"' _ "$ROOT/ralph"
check "a second loop on the same directory is refused" \
  bash -c '! "$1" "$2/ralph.sh" "$3" >/dev/null 2>&1' _ "$RALPH_BASH" "$ROOT" "$RALPH_HOME/demo"
"$ROOT/ralph" steer demo "look at the login flow first" >/dev/null
check "steer reaches the running iteration (STEER.md)" grep -q 'login flow' "$RALPH_HOME/demo/STEER.md"
check "steer holds for later iterations (PROMPT.md)" grep -q 'login flow' "$RALPH_HOME/demo/PROMPT.md"
"$ROOT/ralph" stop demo >/dev/null
check "stop ends the loop" bash -c '"$1" status demo | grep -q stopped' _ "$ROOT/ralph"
check "stop kills the agent's process group" bash -c '! pgrep -f "sleep 99[9]" >/dev/null'
check "the loop logged why it stopped" grep -q 'stopped by signal' "$RALPH_HOME/demo/ralph.log"
check "the lock is released" test ! -e "$RALPH_HOME/demo/ralph.lock"
cp "$T/loops/a/results.tsv" "$RALPH_HOME/demo/results.tsv"
check "ralph results renders a table" bash -c '"$1" results demo | head -1 | grep -q "status"' _ "$ROOT/ralph"
check "status counts the verdicts" bash -c '"$1" status demo | grep -q "verdicts.*keep"' _ "$ROOT/ralph"
git -C "$T/app-d-ralph-demo" commit -q --allow-empty -m "stub: waiting for a human"
check "review lists what waits on ralph/<name> for a merge" \
  bash -c '"$1" review demo | sed -n "/Waiting to merge/,\$p" | grep -q "stub: waiting for a human"' _ "$ROOT/ralph"
check "bare ralph prints the guide and lists your loops" \
  bash -c 'out="$("$1")"; grep -q "Getting started" <<<"$out" && grep -q "Your loops: demo" <<<"$out"' _ "$ROOT/ralph"
unset RALPH_HOME

# ---------------------------------------------------------------------------
section "limits heal themselves; interrupted iterations are set aside"

make_repo "$T/app-f" "$T/remote-f.git"
S="$T/stub-f"; mkdir -p "$S"
printf '%s\n' limit weekly credit custom-limit fail429 commit > "$S/modes"
printf '%s\n' LIMIT ACCEPT > "$S/verdicts"
make_loop "$T/loops/f" "$T/app-f" \
  'WORKTREE=1 PUSH=1 REVIEW=1 MAX_ITER=2' 'VERIFY_CMD="./measure.sh"' \
  "RATE_LIMIT_RE=\"\$RATE_LIMIT_RE|quota window closed\""
run_loop "$T/loops/f" "$S" "$T/remote-f.git"

check "every kind of limit is waited out, a real crash is not, and the work still ships" \
  test "$(statuses "$T/loops/f")" = "ratelimit ratelimit ratelimit ratelimit error keep"
check "waiting out limits did not use up MAX_ITER=2" grep -q 'stub: work' <(git -C "$T/remote-f.git" log --format=%s main)
check "an agent crash whose output mentions 429 is an error, not a limit" \
  test "$(tail -n +2 "$T/loops/f/results.tsv" | cut -f5 | sed -n 5p)" = error
check "config.sh can extend RATE_LIMIT_RE" grep -q 'quota window closed' "$T/loops/f/results.tsv"
check "the reviewer waited out its limit and was asked again" test "$(cat "$S/review_calls")" = 2
check "that commit was reviewed, not waved through" test "$(tail -n 1 "$T/loops/f/results.tsv" | cut -f5)" = keep

# A commit made by an iteration that never finished: nobody judged it.
W="$T/app-f-ralph-f"
git -C "$W" commit -q --allow-empty -m "stub: from an interrupted iteration"
printf '%s\n' nothing > "$S/modes"
sed -i.bak 's/MAX_ITER=2/MAX_ITER=1/' "$T/loops/f/config.sh"
run_loop "$T/loops/f" "$S" "$T/remote-f.git"

check "on restart the unjudged commit is set aside" \
  test "$(tail -n 2 "$T/loops/f/results.tsv" | cut -f5 | tr '\n' ' ')" = "drop:interrupted quiet "
check "the unjudged commit never reached origin" \
  bash -c '! git -C "$1" log --format=%s main | grep -q interrupted' _ "$T/remote-f.git"
check "the unjudged commit is kept under refs/ralph/dropped/" \
  bash -c 'git -C "$1" log --format=%s $(git -C "$1" for-each-ref --format="%(refname)" refs/ralph/dropped/) | grep -q interrupted' _ "$W"

# ---------------------------------------------------------------------------
section "CLI: usage, and a status with nothing to show"

mkdir -p "$T/home-f/notaloop"
check "bare ralph prints the usage instead of running status" \
  bash -c 'RALPH_HOME="$1/home-f" "$2" | grep -q "ralph stop <name>"' _ "$T" "$ROOT/ralph"
check "status says so when it recognises no loops" \
  bash -c 'RALPH_HOME="$1/home-f" "$2" status | grep -q "no loops"' _ "$T" "$ROOT/ralph"
check "status of a name that is not a loop says so" \
  bash -c 'RALPH_HOME="$1/home-f" "$2" status nosuch | grep -q "no loop"' _ "$T" "$ROOT/ralph"

# grep -c prints 0 and exits 1 when it matches nothing, so a `|| echo 0` fallback
# used to add a second 0 and split the line.
mkdir -p "$T/home-f/logged"
printf 'REPO="%s"\n' "$T/app-d" > "$T/home-f/logged/config.sh"
printf '[2026-01-01 10:00] === iteration 1 ===\n' > "$T/home-f/logged/ralph.log"
check "iteration counts stay on one line when nothing shipped yet" \
  bash -c 'RALPH_HOME="$1/home-f" "$2" status logged | grep -q "1 run, 0 shipped a commit"' _ "$T" "$ROOT/ralph"

# ---------------------------------------------------------------------------
section "CLI through a symlink on PATH"

mkdir -p "$T/bin" "$T/deep/bin"
ln -s "$ROOT/ralph" "$T/bin/ralph"                  # absolute link
ln -s ../../bin/ralph "$T/deep/bin/ralph"           # relative link to a link
make_repo "$T/app-e" "$T/remote-e.git"
check "an absolute symlink finds the harness" \
  bash -c 'RALPH_HOME="$1/home-e" "$1/bin/ralph" new viasymlink "$1/app-e"' _ "$T"
check "the loop it scaffolds comes from the real template" test -f "$T/home-e/viasymlink/PROMPT.md"
check "a relative chain of symlinks finds the harness" bash -c '"$1/deep/bin/ralph" help | grep -q "ralph new"' _ "$T"

# ---------------------------------------------------------------------------
section "live steer hook"

printf 'drop the CSS work\n' > "$T/steer.md"
out="$(RALPH_STEER_FILE="$T/steer.md" "$ROOT/hooks/steer.sh")"
check "the hook blocks the tool call once, with the text as the reason" \
  bash -c 'printf "%s" "$1" | jq -e ".decision == \"block\" and (.reason | contains(\"drop the CSS work\"))"' _ "$out"
check "the hook empties STEER.md" test ! -s "$T/steer.md"
check "the hook keeps what it delivered for the reviewer" grep -q 'drop the CSS work' "$T/steer.md.delivered"
check "an empty STEER.md lets every call through" test -z "$(RALPH_STEER_FILE="$T/steer.md" "$ROOT/hooks/steer.sh")"

# ---------------------------------------------------------------------------
echo
if [ "$fails" -eq 0 ]; then
  printf '\033[32mall tests passed\033[0m\n'
else
  printf '\033[31m%s test(s) failed\033[0m — loop output is in the ralph.out and ralph.log files under %s\n' "$fails" "$T"
  trap - EXIT
fi
exit "$fails"
