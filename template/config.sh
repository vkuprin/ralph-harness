# Settings for the __NAME__ loop. Sourced by ralph.sh at every start.

# The checkout the loop works in. Required.
REPO="__REPO__"

# Which model runs an iteration (and the reviewer).
MODEL="opus"

# Hard ceiling on iterations. The loop stops here whatever else is true.
MAX_ITER=500

# How many consecutive iterations may ship nothing before the loop stops.
# 0 means never stop on silence — right for an open-ended audit, where finding
# nothing this hour says nothing about the next. Set 3 for a finite task list,
# where three silent iterations really do mean the list is done.
QUIET_STOP=0

# Pause after an iteration that shipped nothing. Silence is a reason to look
# less often, not a reason to give up.
QUIET_SLEEP=1200

# Pause between iterations that did ship.
STEP_SLEEP=30

# Extra directories the agent may read, beyond the repo and the loop dir.
# ADD_DIRS=("$HOME/.claude/plans")

# ---------------------------------------------------------------- the gate

# Work in a separate git worktree on branch ralph/__NAME__, so the harness can
# reset rejected commits without ever touching your own checkout. Every gate
# below needs it. The worktree sits next to the repo by default, so build tools
# that look at parent directories see the same layout.
WORKTREE=1
# Somewhere other than next to the repo. It must be free, or already be a
# worktree of REPO: the harness resets and cleans whatever is there after every
# iteration, so it refuses to start on a checkout that is not this loop's.
# WORKTREE_DIR="/somewhere/else"

# The branch the worktree starts from, and the one kept commits are pushed to.
BRANCH="main"

# 1: the harness pushes kept commits to origin/$BRANCH itself (the agent cannot).
# 0: commits stay on ralph/__NAME__ for you to merge.
# A repository with no origin says so once at start and behaves as 0.
PUSH=1

# Runs once in a new worktree. Untracked files such as .env and node_modules do
# not exist there until something puts them there. If it fails the loop stops
# and takes the half-built worktree and its branch with it, so fixing the
# command and starting again runs it from scratch.
# SETUP_CMD="npm ci && cp __REPO__/.env ."
SETUP_CMD=""

# A check you own, run by the harness after every commit. If it fails, the
# commit is reset. Keep it deterministic: this is the gate the model cannot talk
# its way past. With it empty, an unavailable reviewer blocks the commit rather
# than waving it through.
# VERIFY_CMD="npm test --silent && ./scripts/measure.sh --max-defects 0"
VERIFY_CMD=""
VERIFY_TIMEOUT=1800

# Paths a commit may not touch: the measurement script, fixtures, the tests
# VERIFY_CMD relies on. A commit that edits one is reset, so the agent cannot
# pass the gate by moving it.
# FROZEN=("scripts/measure.sh" "test/fixtures")
FROZEN=()

# A second, read-only claude reads each new commit's diff and can reject it.
REVIEW=1

# ---------------------------------------------------------------- reliability

# Seconds one agent run may take before its whole process group is killed.
ITER_TIMEOUT=7200

# Pause before retrying an iteration that hit a limit (5-hour, weekly, credit,
# overloaded API). A limit is not an error: the same iteration is tried again,
# as often as it takes, and the retries do not count toward MAX_ITER.
RATE_LIMIT_SLEEP=1800
# To recognise another message as a limit (a proxy, a gateway), extend the pattern:
# RATE_LIMIT_RE="$RATE_LIMIT_RE|quota window closed"

# Pause after a failed or reverted iteration, doubling each time in a row, up
# to an hour.
ERROR_SLEEP=300

# Consecutive failed iterations (crash, timeout) before the loop stops.
# 0 means never: back off and keep trying.
ERROR_STOP=0

# After this many reverted or failed iterations in a row, the prompt tells the
# agent to pivot; after twice as many, to record the blocker under "Needs a
# decision" and move on.
ESCALATE_AFTER=3

# ---------------------------------------------------------------- memory

# Log entries kept in PROGRESS.md. Older ones move to PROGRESS-archive.md, which
# the agent can read but which is not put into every prompt. 0 keeps everything.
PROGRESS_KEEP=8

# ralph.log holds every agent's whole output, so it grows without bound on a loop
# that runs for days. It rotates between iterations once it passes LOG_MAX_BYTES,
# keeping LOG_KEEP older files (ralph.log.1 and up); status, log and tail read
# them all. 0 bytes never rotates; 0 kept throws the old log away.
LOG_MAX_BYTES=10000000
LOG_KEEP=3

# `ralph steer` also reaches the iteration in flight, at its next tool call.
LIVE_STEER=1

# The last line of every prompt. Override it if PROGRESS.md is organised
# differently — for example appended at the bottom rather than the top.
# CLOSING="Run one iteration now. When you are done, rewrite $DIR/PROGRESS.md with your entry at the top of the Log section."
