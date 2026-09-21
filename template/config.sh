# Settings for the __NAME__ loop. Sourced by ralph.sh at every start.

# The checkout the loop works in. Required.
REPO="__REPO__"

# Which model runs an iteration.
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

# The last line of every prompt. Override it if PROGRESS.md is organised
# differently — for example appended at the bottom rather than the top.
# CLOSING="Run one iteration now. When you are done, rewrite $DIR/PROGRESS.md with your entry at the top of the Log section."
