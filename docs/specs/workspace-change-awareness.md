# Workspace change awareness

## Goal

Before a DeepSeek Harness agent continues from cached filesystem context, surface workspace paths changed by a human, another agent, or an untracked command.

## Required behavior

1. Share a host watcher by normalized session working directory.
2. Keep invalidations and acknowledged versions isolated per agent session.
3. Reconcile watcher invalidations through the configured `ctx.fs` provider before presenting them.
4. Revalidate every target previously reported through `fs/observed`, even if the host watcher missed an event.
5. Insert one bounded, source-attributed user message into the next admitted pre-step.
6. Recheck at the turn-stopping boundary and continue the turn once when a new late state or watcher degradation exists.
7. Do not wake an idle agent only because the workspace changed.
8. Close watchers and settle pending lifecycle work on plugin disposal.
9. Commit `fs/observed` baselines only after a successful authoritative tool result is present in the durable step log.
10. Acknowledge watcher invalidations with exact process-local path/generation receipts; never consume an unavailable path or a newer duplicate event.

## Acceptance criteria

- An external modification after Agent A reads a file is present in A's next model request.
- Agent A's successful filesystem-tool write does not create a redundant notice for A.
- A blocked, aborted, or failed outer tool does not self-ack nested filesystem effects.
- The same write is reported to Agent B when both agents use the same workspace.
- Adds, modifications, deletions, and atomic replacements are coalesced and rendered.
- A watcher miss is recovered by observed-version revalidation.
- A change arriving during a turn prevents a stale final stop and enters another step.
- Rejected or aborted pre-steps do not consume pending invalidations.
- One delivered external version causes at most one additional step; a newer version is reported again.
- A transient stat failure remains pending and is reported when verification recovers.
- Watcher startup is cancellation-aware and watcher failure is visible before restart.
- Resume produces a conservative stale-workspace reminder.
- Newline-bearing or otherwise hostile file names cannot alter the notice structure.
- Watcher error and disposal paths do not leak handles or inject late messages.
