# __NAME__

One iteration of this loop is a fresh agent with no memory of the last one. The only
thing it knows about what came before is PROGRESS.md, which it rewrites at the end of
its turn. Write both files for a stranger, because every reader is one.

## The job

<Two or three sentences. Name the outcome the loop is chasing, not the steps. If the
outcome is a finite list of tasks, say so and set QUIET_STOP in config.json — a loop
that can finish should be allowed to.>

## Done looks like

<What would convince you the job is done: an example or a check, not an
adjective. "The landing page renders with the brand fonts and colours at 375 and
1440 px", "every pricing endpoint answers in under 200 ms by scripts/bench.sh".
The reviewer holds each commit against it.>

## Direction

<For a loop that runs open-ended: what to look for, in which order, and what to
leave alone. Without it, a loop whose list is done drifts into whatever it
happens to find.>

## The repository

- Commit on the branch you are on. Do not push: the harness checks every commit
  and pushes the ones it keeps. A commit it rejects is reset, and the verdict
  shows up under "Harness verdicts" in your next prompt.
- Tests: `<command>` — and how long it takes, so an iteration budgets for it.
- Typecheck/build: `<command>`
- <Anything with a slow or remote step: a container to build, a host to reach.>

## How one iteration goes

1. **Verify what the last iteration shipped, before starting anything new.**
   PROGRESS.md names it and says how to check it. An unverified fix is a claim.
2. **Find the next defect by measuring, not by reading code and guessing.** Count
   something. A finding with no number attached is not a finding, and a number that
   came from a different input than the one production uses is worse than none.
3. **Ship one change.** One coherent commit. Put the measurement in the message:
   what was wrong, how much of what it affected, what the number is now.
4. **Rewrite PROGRESS.md.** What you measured and how, what you shipped, what the
   next iteration should verify first, and any earlier conclusion you now believe
   is wrong.

## Rules

- Never mutate production data. Read it, never write it. Code changes only.
- Do not report that something works because the code looks right. Run it.
- If an earlier PROGRESS.md entry is wrong, correct it in your entry and say it was
  yours to correct. A journal nobody contradicts stops being evidence.
- What only a human can settle goes under "Needs a decision", and you move on to
  work you can finish.
- Leave the tree clean. Scratch scripts and measurement directories get deleted
  before the commit, not gitignored.
- Never edit the frozen files. The measurement is not yours to move.
- A closed item is deleted from PROGRESS.md, not carried from entry to entry.
- If the last three commits under "What this loop shipped recently" share a
  topic, pick a different one, unless PROGRESS.md says why this one still pays.
- <Project rules: what must never be touched, what must be regenerated rather than
  edited, where commits are made from.>
