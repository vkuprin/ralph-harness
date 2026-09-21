# Settings for the __NAME__ loop. Sourced by ralph.sh at every start.

# The checkout the loop works in. Required. Written already quoted for the
# shell, because this file is sourced: an unquoted $ or backtick in a path
# would be expanded or run on the way back in.
REPO=__REPO_SH__

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
# Seconds the machine was awake for, not wall clock: a laptop suspended in the
# middle of an iteration used to kill a healthy agent the moment it woke.
ITER_TIMEOUT=7200

# Pause before retrying an iteration that hit a limit (5-hour, weekly, credit,
# overloaded API). A limit is not an error: the same iteration is tried again,
# as often as it takes, and the retries do not count toward MAX_ITER.
RATE_LIMIT_SLEEP=1800
# To recognise another message as a limit (a proxy, a gateway), extend the pattern:
# RATE_LIMIT_RE="$RATE_LIMIT_RE|quota window closed"

# The reviewer's limit is waited out the same way, but not forever: it waits
# holding a commit no gate has judged, so a limit that never clears (a spent
# credit balance) would park the loop on that commit for good. After this many
# tries the iteration gives up on the review and falls back to VERIFY_CMD
# (keep:unreviewed) or, with no VERIFY_CMD, reverts. 0 waits forever.
REVIEW_LIMIT_TRIES=12

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

# ------------------------------------------------------------ telling you

# A command the harness runs when something happens that you would otherwise
# only find by reading ralph.log:
#
#   stopped      the loop ended (MAX_ITER, QUIET_STOP, ERROR_STOP, a file of
#                its own gone, a worktree it could not put back)
#   refused      a start that never ran an iteration
#   stuck        ESCALATE_AFTER iterations in a row reverted or failed
#   limit        the first iteration of a limit streak
#   limit-clear  claude answered again
#   decision     new text under "Needs a decision" in PROGRESS.md — the agent
#                asking you something it cannot settle
#
# Never on a keep or a quiet iteration: that is the noise that makes you stop
# reading them. The event arrives in the environment, not pasted into the
# command: RALPH_EVENT, RALPH_LOOP, RALPH_DIR, RALPH_ITER, RALPH_MESSAGE. It is
# run with a timeout and its exit status is thrown away — a notifier is not a
# gate, and an unreachable host must never be able to stop the loop.
#
# macOS notification centre. `system attribute` reads the environment from
# inside AppleScript, for the same reason the harness does not paste the
# message into this command: interpolated, a message holding a " would end the
# AppleScript string early and the notification would be lost.
# NOTIFY_CMD='osascript -e '\''display notification (system attribute "RALPH_MESSAGE") with title ("ralph: " & (system attribute "RALPH_LOOP")) subtitle (system attribute "RALPH_EVENT")'\'''
#
# Telegram (BotFather for the token, @userinfobot for the chat id):
# NOTIFY_CMD='curl -sS -m 20 -X POST "https://api.telegram.org/bot$TG_TOKEN/sendMessage" -d chat_id="$TG_CHAT" --data-urlencode text="ralph/$RALPH_LOOP $RALPH_EVENT: $RALPH_MESSAGE" >/dev/null'
NOTIFY_CMD=""
# Seconds the notifier may take before its process group is killed. Seconds the
# machine was awake for, like every other timeout here.
NOTIFY_TIMEOUT=30

# ---------------------------------------------------------------- memory

# Log entries kept in PROGRESS.md. Older ones move to PROGRESS-archive.md, which
# the agent can read but which is not put into every prompt. 0 keeps everything.
PROGRESS_KEEP=8

# The backstop under that cap, and the bound that cannot be switched off. The
# cap above counts '### ' entries under a '## Log' heading, and the agent writes
# both, so a file it reshapes — or one huge entry — leaves it nothing to count.
# At most this many bytes of PROGRESS.md go into one prompt, keeping the first of
# them, since the newest entry is at the top. The file is never truncated; the
# prompt says where the rest is. Meeting this bound means the cap above has
# stopped working. 0 injects the whole file however big it gets.
PROGRESS_MAX_BYTES=120000

# ralph.log holds every agent's whole output and the harness's own errors, so it
# grows without bound on a loop
# that runs for days. It rotates between iterations once it passes LOG_MAX_BYTES,
# keeping LOG_KEEP older files (ralph.log.1 and up); status, log and tail read
# them all, however many there are. There is no ceiling on LOG_KEEP, and lowering
# it prunes the files above the new number at the next rotation.
# 0 bytes never rotates; 0 kept throws the old log away.
LOG_MAX_BYTES=10000000
LOG_KEEP=3

# Every commit a gate throws away is kept under refs/ralph/reverted/ or
# refs/ralph/dropped/, so `ralph review` can still show it and you can still get
# it back. That ref is also the only thing keeping the commit reachable, so
# unbounded they stop `git gc` from ever reclaiming the objects. The newest
# REF_KEEP of each kind are kept and the older ones let go. 0 keeps every ref.
REF_KEEP=20

# `ralph steer` also reaches the iteration in flight, at its next tool call.
LIVE_STEER=1

# The last line of every prompt. Override it if PROGRESS.md is organised
# differently — for example appended at the bottom rather than the top.
# CLOSING="Run one iteration now. When you are done, rewrite $DIR/PROGRESS.md with your entry at the top of the Log section."
