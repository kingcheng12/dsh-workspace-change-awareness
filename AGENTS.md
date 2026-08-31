# Repository guidance

This repository contains one out-of-tree DeepSeek Harness plugin bundle.

- Keep the plugin on public Harness extension points; do not patch the Harness agent loop.
- Model-visible context must be a normal durable `user/message`.
- Treat watcher events as invalidations. Reconcile with `ctx.fs` before reporting state.
- Preserve per-session isolation when multiple agents share one workspace.
- Keep watcher teardown quiescent and contain callback errors.
- Pin dependency versions and never commit credentials or `.env` files.

Specifications belong in `docs/specs/`.

