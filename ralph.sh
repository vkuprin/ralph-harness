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
# The gate is a commit. If HEAD moved, the iteration shipped something; if it did
# not, the iteration found nothing, and the loop looks less often rather than
# giving up.
#
# Usage: ralph.sh <loop-dir>
#
# The loop dir holds config.sh, PROMPT.md and PROGRESS.md. Create one with
# `ralph new <name> <repo>`.

set -uo pipefail

DIR="${1:-${RALPH_LOOP:-}}"
[ -n "$DIR" ] || { echo "usage: ralph.sh <loop-dir>" >&2; exit 2; }
DIR="${DIR%/}"
[ -d "$DIR" ] || { echo "ralph: no such loop directory: $DIR" >&2; exit 2; }

for f in config.sh PROMPT.md PROGRESS.md; do
  [ -f "$DIR/$f" ] || { echo "ralph: loop is missing $f: $DIR/$f" >&2; exit 2; }
done

# ---------------------------------------------------------------- defaults
MODEL="opus"
MAX_ITER=500
QUIET_STOP=0        # consecutive iterations shipping nothing before stopping; 0 = never stop
QUIET_SLEEP=1200    # pause after an iteration that shipped nothing
STEP_SLEEP=30       # pause between iterations
ADD_DIRS=()
CLOSING="Run one iteration now. When you are done, rewrite $DIR/PROGRESS.md with your entry at the top of the Log section."

# shellcheck disable=SC1091
. "$DIR/config.sh"

[ -n "${REPO:-}" ] || { echo "ralph: config.sh must set REPO" >&2; exit 2; }
[ -d "$REPO/.git" ] || { echo "ralph: REPO is not a git checkout: $REPO" >&2; exit 2; }

LOG="$DIR/ralph.log"
NAME="$(basename "$DIR")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

iter=0
# The CLI writes ralph.pid; clearing it here keeps `ralph status` honest after the
# loop ends on its own rather than by `ralph stop`.
trap 'rm -f "$DIR/ralph.pid"; log "ralph stopped by signal during iteration $iter"; exit 130' INT TERM

cd "$REPO" || exit 1

log "ralph start: loop=$NAME repo=$REPO model=$MODEL max_iter=$MAX_ITER quiet_stop=$QUIET_STOP"

quiet=0
while :; do
  iter=$((iter + 1))
  if [ "$iter" -gt "$MAX_ITER" ]; then
    iter=$((iter - 1))   # this one never ran; do not count it
    log "stopping: hit MAX_ITER=$MAX_ITER"
    break
  fi

  before=$(git rev-parse HEAD)
  started=$(date +%s)
  log "=== iteration $iter (HEAD $before) ==="

  # PROMPT.md is re-read every iteration, so editing it (or `ralph steer`) redirects
  # the loop without restarting it.
  prompt="$(cat "$DIR/PROMPT.md")

---

# PROGRESS.md (your memory of previous iterations — read this before doing anything)

$(cat "$DIR/PROGRESS.md")

---

$CLOSING"

  args=(-p "$prompt" --dangerously-skip-permissions --add-dir "$DIR" --model "$MODEL")
  for d in ${ADD_DIRS[@]+"${ADD_DIRS[@]}"}; do
    args+=(--add-dir "$d")
  done

  command claude "${args[@]}" >> "$LOG" 2>&1

  after=$(git rev-parse HEAD)
  took=$(( $(date +%s) - started ))

  if [ "$before" = "$after" ]; then
    quiet=$((quiet + 1))
    log "iteration $iter shipped nothing in ${took}s (quiet streak $quiet)"
    if [ "$QUIET_STOP" -gt 0 ] && [ "$quiet" -ge "$QUIET_STOP" ]; then
      log "stopping: $QUIET_STOP consecutive iterations shipped nothing"
      break
    fi
    sleep "$QUIET_SLEEP"
  else
    quiet=0
    log "iteration $iter shipped $after in ${took}s"
  fi

  sleep "$STEP_SLEEP"
done

rm -f "$DIR/ralph.pid"
log "ralph finished after $iter iterations"
