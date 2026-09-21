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
check "the agent can still push in an unrelated repository with an origin of its own" \
  test "$(cat "$S/push-other.rc")" = 0
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
section "a PID is not an identity: ralph.pid and ralph.lock left by a dead loop"

# A loop that ends by `kill -9`, the OOM killer or a reboot leaves both files
# behind holding a number the kernel then hands to somebody else. A stranger
# playing the part of that somebody:
make_repo "$T/app-p" "$T/remote-p.git"
S="$T/stub-p"; mkdir -p "$S"
printf '%s\n' nothing > "$S/modes"
make_loop "$T/home-p/stale" "$T/app-p" 'MAX_ITER=1'
sleep 41 &
bystander=$!
echo "$bystander" > "$T/home-p/stale/ralph.pid"

check "status does not call a recycled PID a running loop" \
  bash -c 'RALPH_HOME="$1/home-p" "$2" status stale | grep -q stopped' _ "$T" "$ROOT/ralph"
check "stop says the loop is not running" \
  bash -c '! RALPH_HOME="$1/home-p" "$2" stop stale >/dev/null 2>&1' _ "$T" "$ROOT/ralph"
check "stop leaves the stranger who now owns that PID alone" kill -0 "$bystander"
kill "$bystander" 2>/dev/null

# The recycled number could be another loop's, which is why the check is this
# loop's own command line and not merely "some ralph.sh is alive".
S2="$T/stub-p2"; mkdir -p "$S2"
printf '%s\n' sleep > "$S2/modes"
make_loop "$T/home-p/other" "$T/app-p" 'MAX_ITER=1 ITER_TIMEOUT=600'
STUB_DIR="$S2" RALPH_HOME="$T/home-p" "$ROOT/ralph" start other >/dev/null
for _ in $(seq 1 50); do [ -s "$S2/modes.done" ] && break; sleep 0.2; done
cp "$T/home-p/other/ralph.pid" "$T/home-p/stale/ralph.pid"
RALPH_HOME="$T/home-p" "$ROOT/ralph" stop stale >/dev/null 2>&1
check "stopping one loop does not stop the loop next door" \
  bash -c 'RALPH_HOME="$1/home-p" "$2" status other | grep -q running' _ "$T" "$ROOT/ralph"
RALPH_HOME="$T/home-p" "$ROOT/ralph" stop other >/dev/null 2>&1

# The lock is the loop's own, and a recycled PID there stopped it starting at all.
sleep 41 &
bystander=$!
echo "$bystander" > "$T/home-p/stale/ralph.lock"
run_loop "$T/home-p/stale" "$S"
check "a lock left by a dead loop does not block the next start" \
  grep -q 'ralph finished' "$T/home-p/stale/ralph.log"
check "the stranger holding the lock's PID survived that too" kill -0 "$bystander"
kill "$bystander" 2>/dev/null

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
section "loops from before config.sh"

# The layout before config.sh: the settings are variables near the top of the
# loop's own ralph.sh, and there is no ralph.pid, so a running loop has to be
# found in the process list. status used to skip these directories in silence.
mkdir -p "$T/home-old/legacy"
cat > "$T/home-old/legacy/ralph.sh" <<EOF
#!/usr/bin/env bash
set -uo pipefail
DIR="\$HOME/.claude/ralph/legacy"
REPO="$T/app-d"
LOG="\$DIR/ralph.log"
MAX_ITER="\${MAX_ITER:-40}"
QUIET_STOP="\${QUIET_STOP:-3}"
while :; do sleep 0.3; done
EOF
chmod +x "$T/home-old/legacy/ralph.sh"
old_sha=1111111111111111111111111111111111111111
printf '[2026-01-01 10:00] === iteration 1 (HEAD 0000000) ===\n[2026-01-01 10:20] iteration 1 shipped %s\n[2026-01-01 10:20] === iteration 2 (HEAD %s) ===\n' \
  "$old_sha" "$old_sha" > "$T/home-old/legacy/ralph.log"
old_out="$(RALPH_HOME="$T/home-old" "$ROOT/ralph" status)"
check "status lists a loop from before config.sh" grep -q '^legacy' <<<"$old_out"
check "status marks it as the old layout" grep -q 'old layout' <<<"$old_out"
check "status reads the repo out of its ralph.sh" grep -q "repo *$T/app-d\$" <<<"$old_out"
check "status counts its iterations from the log" grep -q '2 run, 1 shipped a commit' <<<"$old_out"
check "an old-layout loop with no process is stopped" grep -q 'stopped' <<<"$old_out"
check "the guide lists old-layout loops too" \
  grep -q 'legacy (old layout)' <<<"$(RALPH_HOME="$T/home-old" "$ROOT/ralph")"

"$RALPH_BASH" "$T/home-old/legacy/ralph.sh" & legacy_pid=$!
for _ in $(seq 1 25); do pgrep -f "home-old/legacy/ralph.sh" >/dev/null && break; sleep 0.1; done
check "status finds the process running an old-layout loop" \
  grep -q 'running.*PID' <<<"$(RALPH_HOME="$T/home-old" "$ROOT/ralph" status legacy)"
kill "$legacy_pid" 2>/dev/null
wait "$legacy_pid" 2>/dev/null

# ---------------------------------------------------------------------------
section "ralph migrate: an old-layout loop becomes a current one"

# The same layout once more, this time over a real repository, so the migrated
# loop can be run by this repo's ralph.sh to prove the settings came across.
make_repo "$T/app-m" "$T/remote-m.git"
mkdir -p "$T/home-m/legacy"
cat > "$T/home-m/legacy/ralph.sh" <<EOF
#!/usr/bin/env bash
set -uo pipefail
DIR="\$HOME/.claude/ralph/legacy"
REPO="$T/app-m"
LOG="\$DIR/ralph.log"
MAX_ITER="\${MAX_ITER:-7}"
QUIET_STOP="\${QUIET_STOP:-3}"
while :; do sleep 0.3; done
EOF
chmod +x "$T/home-m/legacy/ralph.sh"
cp "$ROOT/template/PROMPT.md" "$ROOT/template/PROGRESS.md" "$T/home-m/legacy/"
prompt_sum="$(cksum < "$T/home-m/legacy/PROMPT.md")"

check "review sends an old-layout loop to migrate instead of denying it exists" \
  bash -c 'RALPH_HOME="$1/home-m" "$2" review legacy 2>&1 | grep -q "ralph migrate legacy"' _ "$T" "$ROOT/ralph"

"$RALPH_BASH" "$T/home-m/legacy/ralph.sh" & legacy_pid=$!
for _ in $(seq 1 25); do pgrep -f "home-m/legacy/ralph.sh" >/dev/null && break; sleep 0.1; done
check "migrate refuses while the loop is running" \
  bash -c '! RALPH_HOME="$1/home-m" "$2" migrate legacy' _ "$T" "$ROOT/ralph"
check "and left the running loop's ralph.sh where it was" test -f "$T/home-m/legacy/ralph.sh"
check "and wrote no config.sh" test ! -e "$T/home-m/legacy/config.sh"
kill "$legacy_pid" 2>/dev/null
wait "$legacy_pid" 2>/dev/null

check "migrate converts a stopped loop" \
  bash -c 'RALPH_HOME="$1/home-m" "$2" migrate legacy' _ "$T" "$ROOT/ralph"
check "it carries the repo over" grep -qx "REPO=\"$T/app-m\"" "$T/home-m/legacy/config.sh"
check "it carries MAX_ITER over" grep -qx 'MAX_ITER=7' "$T/home-m/legacy/config.sh"
check "it carries QUIET_STOP over" grep -qx 'QUIET_STOP=3' "$T/home-m/legacy/config.sh"
check "it leaves the settings that loop never had at the harness defaults" \
  bash -c '! grep -qE "^(WORKTREE|PUSH|REVIEW|VERIFY_CMD)=" "$1/home-m/legacy/config.sh"' _ "$T"
check "the old ralph.sh is kept as ralph.sh.old" test -f "$T/home-m/legacy/ralph.sh.old"
check "and is out of the way, so the loop is no longer the old layout" test ! -e "$T/home-m/legacy/ralph.sh"
check "PROMPT.md is untouched" test "$prompt_sum" = "$(cksum < "$T/home-m/legacy/PROMPT.md")"
check "status stops calling it the old layout" \
  bash -c '! RALPH_HOME="$1/home-m" "$2" status legacy | grep -q "old layout"' _ "$T" "$ROOT/ralph"
check "migrating twice is refused" \
  bash -c '! RALPH_HOME="$1/home-m" "$2" migrate legacy' _ "$T" "$ROOT/ralph"
check "migrate refuses a directory that is no loop at all" \
  bash -c 'mkdir -p "$1/home-m/notaloop"; ! RALPH_HOME="$1/home-m" "$2" migrate notaloop' _ "$T" "$ROOT/ralph"

# The proof that the values mean the same thing after the move: the migrated
# loop runs under this repo's ralph.sh and stops at the MAX_ITER it carried.
echo 'QUIET_SLEEP=0 STEP_SLEEP=0' >> "$T/home-m/legacy/config.sh"
S="$T/stub-m"; mkdir -p "$S"
printf '%s\n' commit commit commit commit commit commit commit commit > "$S/modes"
run_loop "$T/home-m/legacy" "$S"
check "the migrated loop runs, and stops at the MAX_ITER it carried over" \
  grep -q 'hit MAX_ITER=7' "$T/home-m/legacy/ralph.log"
check "it committed into the repo its old ralph.sh named" \
  test "$(git -C "$T/app-m" rev-list --count HEAD)" = 8

# ---------------------------------------------------------------------------
section "bad configuration and odd inputs"

# A SETUP_CMD that fails. The half-built worktree goes, and the branch it was
# built on goes with it: keeping the branch made the next start take the "reuse
# the branch" path, which skips SETUP_CMD, so the loop ran for good in a
# worktree its own setup had never prepared.
make_repo "$T/app-g" "$T/remote-g.git"
S="$T/stub-g"; mkdir -p "$S"
printf '%s\n' commit commit > "$S/modes"
make_loop "$T/loops/g" "$T/app-g" 'WORKTREE=1 MAX_ITER=2' \
  "SETUP_CMD=\"echo preparing >> '$T/setup-runs'; exit 3\""
run_loop "$T/loops/g" "$S"
run_loop "$T/loops/g" "$S"

check "a failed SETUP_CMD leaves no worktree behind" test ! -e "$T/app-g-ralph-g"
check "the next start runs SETUP_CMD again instead of skipping it" \
  test "$(wc -l < "$T/setup-runs" | tr -d ' ')" = 2
check "a loop whose setup failed runs no iteration" test ! -e "$T/loops/g/results.tsv"

# WORKTREE_DIR pointing somewhere that is not a worktree of REPO. The harness
# hard-resets and cleans whatever it finds there after every iteration, so
# accepting any git checkout means discarding a stranger's work.
make_repo "$T/app-h" "$T/remote-h.git"
git init -q -b main "$T/elsewhere"
(
  cd "$T/elsewhere" || exit 1
  echo keep > precious.txt
  git add -A && git commit -qm "not ralph's work"
  echo scratch > untracked.txt
)
S="$T/stub-h"; mkdir -p "$S"
printf '%s\n' commit > "$S/modes"
make_loop "$T/loops/h" "$T/app-h" 'WORKTREE=1 MAX_ITER=1' "WORKTREE_DIR=\"$T/elsewhere\""
run_loop "$T/loops/h" "$S"

check "a WORKTREE_DIR holding someone else's checkout is refused" \
  grep -q 'not a worktree of' "$T/loops/h/ralph.log"
check "nothing was committed into that checkout" \
  test "$(git -C "$T/elsewhere" rev-list --count HEAD)" = 1
check "and its uncommitted file was not cleaned away" test -f "$T/elsewhere/untracked.txt"

mkdir -p "$T/notempty" && echo x > "$T/notempty/x"
make_loop "$T/loops/h2" "$T/app-h" 'WORKTREE=1 MAX_ITER=1' "WORKTREE_DIR=\"$T/notempty\""
run_loop "$T/loops/h2" "$S"
check "a WORKTREE_DIR that exists and holds no checkout stops the loop" \
  grep -q 'cannot create worktree' "$T/loops/h2/ralph.log"

# PUSH=1 in a repository with no origin. Every sync used to fetch, fail, and
# log git's four-line complaint: for a loop that runs for days that is the whole
# log. Say it once and carry on as PUSH=0.
git init -q -b main "$T/app-i"
(
  cd "$T/app-i" || exit 1
  printf '#!/bin/sh\nexit 0\n' > measure.sh && chmod +x measure.sh
  git add -A && git commit -qm initial
)
S="$T/stub-i"; mkdir -p "$S"
printf '%s\n' commit commit > "$S/modes"
make_loop "$T/loops/i" "$T/app-i" 'WORKTREE=1 PUSH=1 MAX_ITER=2'
run_loop "$T/loops/i" "$S"

check "with no origin the loop still runs and keeps its commits" \
  test "$(statuses "$T/loops/i")" = "keep keep"
check "the missing origin is logged once, not once per sync" \
  test "$(grep -c 'no origin remote' "$T/loops/i/ralph.log")" = 1
check "and no failed fetch is logged at all" \
  bash -c '! grep -q "fetch failed" "$1/loops/i/ralph.log"' _ "$T"

# ralph/<name> deleted while the loop runs. The worktree's HEAD then names a ref
# that is gone, so `git rev-parse HEAD` fails and with it every gate. The loop
# used to stop and ask for a human; it can put the branch back itself.
make_repo "$T/app-j" "$T/remote-j.git"
S="$T/stub-j"; mkdir -p "$S"
printf '%s\n' drop-branch commit > "$S/modes"
make_loop "$T/loops/j" "$T/app-j" 'WORKTREE=1 MAX_ITER=2'
run_loop "$T/loops/j" "$S"

check "a branch deleted under the loop is put back, and the loop goes on" \
  test "$(statuses "$T/loops/j")" = "revert:history keep"
check "so it never stops asking for a human" \
  bash -c '! grep -q "fix the worktree by hand" "$1/loops/j/ralph.log"' _ "$T"
check "the restored branch and the worktree agree" \
  test "$(git -C "$T/app-j" rev-parse ralph/j)" = "$(git -C "$T/app-j-ralph-j" rev-parse HEAD)"

# A PROMPT.md with no "## The job" heading. The reviewer was handed an empty job
# and judged the diff against nothing at all.
make_repo "$T/app-k" "$T/remote-k.git"
S="$T/stub-k"; mkdir -p "$S"
printf '%s\n' commit > "$S/modes"
make_loop "$T/loops/k" "$T/app-k" 'WORKTREE=1 REVIEW=1 MAX_ITER=1'
printf 'Find and fix the races in the scheduler.\n' > "$T/loops/k/PROMPT.md"
run_loop "$T/loops/k" "$S"
check "with no '## The job' heading the reviewer still gets the job" \
  grep -q 'races in the scheduler' "$S/prompt.review.1"

# MAX_ITER=0: a ceiling of none. Stop before the first iteration rather than
# running one and calling it zero.
make_loop "$T/loops/l" "$T/app-k" 'WORKTREE=1 MAX_ITER=0'
run_loop "$T/loops/l" "$S"
check "MAX_ITER=0 runs no iteration" grep -q 'finished after 0 iterations' "$T/loops/l/ralph.log"
check "and records no verdict" test ! -e "$T/loops/l/results.tsv"

# A repo path with a space in it, through every gate there is.
make_repo "$T/my app" "$T/remote-n.git"
S="$T/stub-n"; mkdir -p "$S"
printf '%s\n' commit nothing > "$S/modes"
make_loop "$T/loops/n" "$T/my app" \
  'WORKTREE=1 PUSH=1 REVIEW=1 MAX_ITER=2' 'VERIFY_CMD="./measure.sh"'
run_loop "$T/loops/n" "$S" "$T/remote-n.git"

check "a repo path with a space survives verify, review and push" \
  test "$(statuses "$T/loops/n")" = "keep quiet"
check "its worktree was made next to it" test -d "$T/my app-ralph-n"
check "and its commit reached origin" \
  grep -q 'stub: work' <(git -C "$T/remote-n.git" log --format=%s main)

# ---------------------------------------------------------------------------
section "days, not minutes: a soak run over a rotating log"

# Nothing had ever run here for longer than a dozen iterations. 200 of them with
# no sleeps is about a week of a real loop with the waiting taken out: long
# enough for the log to rotate many times over, and for anything that leaks once
# per iteration to have leaked 200 times by the end.
make_repo "$T/app-soak" "$T/remote-soak.git"
S="$T/stub-soak"; mkdir -p "$S"
printf '%s\n' commit commit commit > "$S/modes"   # then "nothing" for the rest
export RALPH_HOME="$T/home-soak"
D="$RALPH_HOME/soak"
make_loop "$D" "$T/app-soak" 'MAX_ITER=200 LOG_MAX_BYTES=4000 LOG_KEEP=3'
run_loop "$D" "$S"

check "200 iterations ran" test "$(tail -n +2 "$D/results.tsv" | wc -l | tr -d ' ')" = 200
check "results.tsv counts up to the last one" test "$(tail -n 1 "$D/results.tsv" | cut -f2)" = 200
check "the verdicts add up: 3 keeps and 197 quiet" \
  bash -c 'v="$(tail -n +2 "$1" | cut -f5)"; test "$(grep -c keep <<<"$v")" = 3 \
           && test "$(grep -c quiet <<<"$v")" = 197' _ "$D/results.tsv"
check "the log rotated" test -f "$D/ralph.log.1"
check "rotation keeps LOG_KEEP files and no more" \
  bash -c 'test -f "$1.3" && test ! -e "$1.4"' _ "$D/ralph.log"
check "the log stops growing: all of it together stays near the limit" \
  test "$(cat "$D"/ralph.log* | wc -c | tr -d ' ')" -lt 30000

soak_cur="$(grep -a -c '=== iteration' "$D/ralph.log")"
soak_all="$(cat "$D"/ralph.log* | grep -a -c '=== iteration')"
check "the newest log alone has lost most of the history" test "$soak_cur" -lt "$soak_all"
check "status counts iterations across the rotated logs" \
  bash -c '"$1" status soak | grep -q "iterations  $2 run"' _ "$ROOT/ralph" "$soak_all"
check "ralph log reads the rotated files too" \
  test "$("$ROOT/ralph" log soak 100 | wc -l | tr -d ' ')" = 100
check "the progress cap says its piece once, not once per iteration" \
  test "$(cat "$D"/ralph.log* | grep -c 'progress cap')" -le 1
check "PROGRESS.md is still the file it started as" \
  bash -c 'grep -q "^## Needs a decision" "$1" && test "$(wc -c < "$1")" -lt 8000' _ "$D/PROGRESS.md"
check "no process was left behind" bash -c '! pgrep -f "home-soa[k]" >/dev/null'
check "the lock is released" test ! -e "$D/ralph.lock"
unset RALPH_HOME

# ---------------------------------------------------------------------------
section "rotated logs past ralph.log.9"

# LOG_KEEP has no ceiling, so a loop asked to keep more history rotates into
# ralph.log.10 and up. Both sides used to assume the count was fixed: the CLI
# walked a hardcoded 9..1, and rotation removed exactly the file at LOG_KEEP.
make_repo "$T/app-logn" "$T/remote-logn.git"
export RALPH_HOME="$T/home-logn"
D="$RALPH_HOME/deep"
make_loop "$D" "$T/app-logn" 'LOG_KEEP=12'
i=12
while [ "$i" -ge 1 ]; do
  printf '[2026-01-01 00:00:00] === iteration %s ===\n' "$i" > "$D/ralph.log.$i"
  i=$((i - 1))
done
printf '[2026-01-01 00:00:00] === iteration 13 ===\n' > "$D/ralph.log"

check "status counts the iterations in ralph.log.10 and up" \
  bash -c '"$1" status deep | grep -q "iterations  13 run"' _ "$ROOT/ralph"
check "ralph log reads past ralph.log.9" \
  bash -c '"$1" log deep 20 | grep -q "iteration 12 "' _ "$ROOT/ralph"
# The oldest file is ralph.log.12. A glob would sort it under ralph.log.2 and
# hand the history back shuffled, so this pins the order as numeric.
check "the log is read oldest first, by number and not by name" \
  bash -c 'test "$("$1" log deep 20 | head -1)" = "$2"' _ "$ROOT/ralph" \
  '[2026-01-01 00:00:00] === iteration 12 ==='

# Lowering LOG_KEEP used to leave every file above the new number behind for
# good, so the bound of LOG_MAX_BYTES * (LOG_KEEP + 1) was not a bound at all —
# and once the CLI could read past nine it would read that stale file for ever.
S="$T/stub-logn"; mkdir -p "$S"; printf 'nothing\n' > "$S/modes"
O="$RALPH_HOME/orphan"
make_loop "$O" "$T/app-logn" 'MAX_ITER=6 LOG_MAX_BYTES=200 LOG_KEEP=2'
echo "left over from when LOG_KEEP was higher" > "$O/ralph.log.5"
run_loop "$O" "$S"

check "the run rotated at all, so the check below means something" test -f "$O/ralph.log.1"
check "rotation prunes the logs left above a lowered LOG_KEEP" test ! -e "$O/ralph.log.5"
check "rotation still keeps the LOG_KEEP files below it" \
  bash -c 'test -f "$1.2" && test ! -e "$1.3"' _ "$O/ralph.log"
unset RALPH_HOME

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
