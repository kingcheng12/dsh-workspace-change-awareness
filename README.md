# dsh-workspace-change-awareness

An installable DeepSeek Harness bundle that tells an agent when its workspace changes while it is working. It is intended for repositories edited concurrently by a person, another agent, an IDE, or a command outside Harness filesystem tools.

The package is pinned and tested against `@deepseek-ai/dsh` `0.1.0-rc.7`. That CLI currently resolves the public Agent, filesystem, and LLM APIs at `0.1.0-rc.8`; those peer and development versions are pinned in `package.json`.

## Behavior

- One Chokidar watcher is shared by live sessions using the same normalized workspace root.
- Watcher events only invalidate paths. Before a model request, the plugin resolves and stats each path through `ctx.fs`.
- DSH `fs/observed` versions are retained per session only after the authoritative outer tool result succeeds, its `tool/result` is appended, and the enclosing `step/end` commits. Nested Code Mode effects whose outer call fails remain dirty instead of being self-acknowledged.
- A successful, durably logged Harness read/write/edit becomes that session's acknowledged version, so the writer does not receive a redundant notification while other agents still do.
- A sourced user-role notice is inserted at `agent/pre-step`, so it is persisted before the model sees it.
- `agent/turn-stopping` performs a final check and steers one additional step when a new filesystem state or degraded watcher boundary arrived while the model was working.
- Delivered states are remembered separately from DSH's read/write baseline, preventing repeated steering while still reporting a newer version.
- Exact process-local watcher receipts acknowledge only the path generation actually covered by a durable notice. Unavailable paths remain pending until verification recovers.
- Watcher startup is bounded and cancellation-aware. A watcher error produces a model-visible degraded-coverage notice before the registry attempts a fresh watcher.
- A resumed or compacted session receives a conservative reminder to re-read files because process-local observations cannot cover edits made while DSH was stopped.

The notice asks the model to re-read affected files and inspect the current diff before relying on cached contents. File names are JSON-escaped and the visible list is bounded.

## Develop

Requirements: Node.js `^22.19.0 || >=24.0.0` and pnpm `11.7.0`.

```powershell
pnpm install
pnpm check
```

All dependency versions and the package-manager version are exact. `pnpm-workspace.yaml` records the reviewed dependency build-script policy required by modern pnpm. Generated output (`lib/`), dependencies, logs, coverage, and local environment files are ignored.

## Install into a DSH profile

Build first, then run the profile installer from this checkout so the relative package path is anchored correctly:

```powershell
pnpm build
pnpm exec dsh plugin --profile <profile-name> add .
pnpm exec dsh --profile <profile-name> --dump-config
```

The package declares `dsh.bundle.patch`, so `dsh plugin` activates `cordis.patch.yml` automatically. A Git-hosted install runs the pinned `prepare` build; pnpm requires the profile owner to explicitly allow that install-time build.

## Configuration

The bundle works without configuration. A later profile patch may replace its row with values such as:

```yaml
- id: workspace-change-awareness
  name: dsh-workspace-change-awareness
  config:
    debounceMs: 75
    maxWaitMs: 500
    maxNoticePaths: 50
    statConcurrency: 16
    usePolling: false
    pollIntervalMs: 100
    verifyAtTurnStop: true
    ignoredDirectories: [.git, node_modules]
```

## Boundaries

- A filesystem event cannot prove who made a change. Notices say that a path changed outside the session's acknowledged filesystem observations rather than claiming a human author.
- Host watching does not cover a remote filesystem provider. Previously observed remote targets are still revalidated through `ctx.fs.stat()` at pre-step.
- A brand-new agent starts from current workspace state; initial files are not reported as changes.
- Exact offline comparison is not available without plugin-owned durable manifest storage. Resume therefore emits a conservative re-read reminder.
- A watcher outage cannot reconstruct every unobserved host change that happened during the gap. The plugin warns the agent that coverage degraded and asks it to inspect current Git state, then restarts the watcher; previously observed targets continue to be revalidated through `ctx.fs`.
- A change after the final pre-step stat is observed at the next boundary. DSH's existing filesystem observation policy still provides atomic stale-version protection for first-party writes and edits; arbitrary shell writes bypass that policy.
