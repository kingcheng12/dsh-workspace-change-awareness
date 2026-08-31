import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ChokidarOptions } from 'chokidar'

export type WorkspaceWatchEvent = 'add' | 'change' | 'unlink'

export interface WorkspaceInvalidation {
  readonly event: WorkspaceWatchEvent
  readonly absolutePath: string
  readonly displayPath: string
  readonly revision: number
  readonly generation: number
}

export interface WorkspaceInvalidationSnapshot {
  readonly root: string
  readonly changes: readonly WorkspaceInvalidation[]
  readonly throughRevision: number
  readonly generation: number
  readonly healthy: boolean
  readonly healthRevision: number
}

export interface WorkspaceInvalidationReceipt {
  readonly entries: readonly {
    readonly absolutePath: string
    readonly revision: number
    readonly generation: number
  }[]
}

export interface WatcherHandle {
  on(event: WorkspaceWatchEvent, listener: (path: string) => void): this
  on(event: 'ready', listener: () => void): this
  on(event: 'error', listener: (error: unknown) => void): this
  close(): Promise<void>
}

export type WatcherFactory = (root: string, options: ChokidarOptions) => WatcherHandle

export interface WatchRegistryConfig {
  readonly debounceMs: number
  readonly maxWaitMs: number
  readonly usePolling: boolean
  readonly pollIntervalMs: number
  readonly ignoredDirectories: readonly string[]
}

export interface WatchRegistryLogger {
  warn(message: string): void
}

interface Subscription {
  readonly owner: object
  state: WorkspaceState
  readonly pending: Map<string, WorkspaceInvalidation>
}

function rootKey(root: string): string {
  const normalized = resolve(root)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function displayPath(root: string, absolutePath: string): string {
  const value = relative(root, absolutePath)
  return (value.length === 0 ? '.' : value).split(sep).join('/')
}

function nextEvent(
  previous: WorkspaceWatchEvent | undefined,
  current: WorkspaceWatchEvent,
): WorkspaceWatchEvent | undefined {
  if (previous === 'add' && current === 'unlink') return undefined
  if (previous === 'unlink' && current === 'add') return 'change'
  if (previous === 'add' && current === 'change') return 'add'
  return current
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason)
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolveDelay()
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      rejectDelay(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

class WorkspaceState {
  readonly subscriptions = new Set<Subscription>()
  readonly ready: Promise<void>
  private resolveReady!: () => void
  private isReady = false
  private unhealthy = false
  private healthRevision = 0
  private closed = false
  private revision = 0
  private lastEventAt = 0

  constructor(
    readonly root: string,
    readonly generation: number,
    private readonly watcher: WatcherHandle,
    private readonly logger: WatchRegistryLogger,
    private readonly config: WatchRegistryConfig,
  ) {
    this.ready = new Promise(resolveReady => {
      this.resolveReady = resolveReady
    })
    watcher.on('ready', () => {
      if (this.closed) return
      this.unhealthy = false
      this.releaseReadiness()
    })
    watcher.on('error', error => {
      this.logger.warn(`workspace-change-awareness: watcher error for ${JSON.stringify(root)}: ${String(error)}`)
      this.markUnhealthy()
      this.releaseReadiness()
    })
    for (const event of ['add', 'change', 'unlink'] as const) {
      watcher.on(event, path => {
        this.record(event, path)
      })
    }
  }

  private releaseReadiness(): void {
    if (this.isReady) return
    this.isReady = true
    this.resolveReady()
  }

  private markUnhealthy(): void {
    if (this.unhealthy) return
    this.unhealthy = true
    this.healthRevision += 1
  }

  isUnhealthy(): boolean {
    return this.unhealthy
  }

  health(): { healthy: boolean; revision: number } {
    return { healthy: !this.unhealthy, revision: this.healthRevision }
  }

  private record(event: WorkspaceWatchEvent, path: string): void {
    if (this.closed) return
    this.unhealthy = false
    this.releaseReadiness()
    const absolutePath = isAbsolute(path) ? resolve(path) : resolve(this.root, path)
    const renderedPath = displayPath(this.root, absolutePath)
    this.revision += 1
    this.lastEventAt = Date.now()
    for (const subscription of this.subscriptions) {
      const prior = subscription.pending.get(absolutePath)
      const combined = nextEvent(prior?.event, event)
      if (combined === undefined) {
        subscription.pending.delete(absolutePath)
        continue
      }
      subscription.pending.set(absolutePath, {
        event: combined,
        absolutePath,
        displayPath: renderedPath,
        revision: this.revision,
        generation: this.generation,
      })
    }
  }

  async settle(signal?: AbortSignal): Promise<void> {
    if (!this.isReady) {
      const ready = await Promise.race([
        this.ready.then(() => true),
        abortableDelay(this.config.maxWaitMs, signal).then(() => false),
      ])
      if (!ready) {
        this.markUnhealthy()
        return
      }
    }
    if (this.unhealthy) return
    const startedAt = Date.now()
    await abortableDelay(this.config.debounceMs, signal)
    while (!this.closed) {
      const now = Date.now()
      const quietFor = now - this.lastEventAt
      const waitedFor = now - startedAt
      if (this.lastEventAt === 0 || quietFor >= this.config.debounceMs || waitedFor >= this.config.maxWaitMs) return
      await abortableDelay(
        Math.min(this.config.debounceMs - quietFor, this.config.maxWaitMs - waitedFor),
        signal,
      )
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (!this.isReady) {
      this.releaseReadiness()
    }
    await this.watcher.close()
  }
}

/** Shared watcher ownership plus per-session invalidation queues. */
export class WorkspaceWatchRegistry {
  private readonly states = new Map<string, WorkspaceState>()
  private subscriptions = new WeakMap<object, Subscription>()
  private failures = new WeakMap<object, { root: string; revision: number }>()
  private readonly closing = new Set<Promise<void>>()
  private closed = false
  private nextGeneration = 0
  private nextFailureRevision = 0

  constructor(
    private readonly config: WatchRegistryConfig,
    private readonly logger: WatchRegistryLogger,
    private readonly createWatcher: WatcherFactory,
  ) {}

  private createState(root: string): WorkspaceState {
    const ignored = new Set(this.config.ignoredDirectories)
    const watcher = this.createWatcher(root, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      atomic: true,
      usePolling: this.config.usePolling,
      interval: this.config.pollIntervalMs,
      ignored: candidate => {
        const rawCandidate = String(candidate)
        const candidatePath = isAbsolute(rawCandidate) ? resolve(rawCandidate) : resolve(root, rawCandidate)
        const candidateRelative = relative(root, candidatePath)
        if (candidateRelative.length === 0 || candidateRelative.startsWith(`..${sep}`)) return false
        return candidateRelative.split(sep).some(segment => ignored.has(segment))
      },
    })
    this.nextGeneration += 1
    return new WorkspaceState(root, this.nextGeneration, watcher, this.logger, this.config)
  }

  private recover(state: WorkspaceState): WorkspaceState {
    if (!state.isUnhealthy() || this.closed) return state
    const key = rootKey(state.root)
    if (this.states.get(key) !== state) return this.states.get(key) ?? state
    let replacement: WorkspaceState
    try {
      replacement = this.createState(state.root)
    } catch (error: unknown) {
      this.logger.warn(`workspace-change-awareness: could not restart watcher for ${JSON.stringify(state.root)}: ${String(error)}`)
      return state
    }
    this.states.set(key, replacement)
    for (const subscription of [...state.subscriptions]) {
      state.subscriptions.delete(subscription)
      subscription.state = replacement
      replacement.subscriptions.add(subscription)
    }
    const close = state.close().catch((error: unknown) => {
      this.logger.warn(`workspace-change-awareness: failed to close watcher for ${JSON.stringify(state.root)}: ${String(error)}`)
    }).finally(() => {
      this.closing.delete(close)
    })
    this.closing.add(close)
    return replacement
  }

  attach(owner: object, cwd: string): void {
    if (this.closed || this.subscriptions.has(owner)) return
    const root = resolve(cwd)
    const key = rootKey(root)
    let state = this.states.get(key)
    if (state === undefined) {
      try {
        state = this.createState(root)
        this.states.set(key, state)
      } catch (error: unknown) {
        this.logger.warn(`workspace-change-awareness: could not watch ${JSON.stringify(root)}: ${String(error)}`)
        if (this.failures.get(owner)?.root !== root) {
          this.nextFailureRevision += 1
          this.failures.set(owner, { root, revision: this.nextFailureRevision })
        }
        return
      }
    }
    this.failures.delete(owner)
    const subscription: Subscription = { owner, state, pending: new Map() }
    state.subscriptions.add(subscription)
    this.subscriptions.set(owner, subscription)
  }

  detach(owner: object): void {
    this.failures.delete(owner)
    const subscription = this.subscriptions.get(owner)
    if (subscription === undefined) return
    this.subscriptions.delete(owner)
    subscription.state.subscriptions.delete(subscription)
    if (subscription.state.subscriptions.size !== 0) return
    this.states.delete(rootKey(subscription.state.root))
    const close = subscription.state.close().catch((error: unknown) => {
      this.logger.warn(
        `workspace-change-awareness: failed to close watcher for ${JSON.stringify(subscription.state.root)}: ${String(error)}`,
      )
    }).finally(() => {
      this.closing.delete(close)
    })
    this.closing.add(close)
  }

  async snapshot(owner: object, signal?: AbortSignal): Promise<WorkspaceInvalidationSnapshot | undefined> {
    let subscription = this.subscriptions.get(owner)
    if (subscription === undefined) {
      const failure = this.failures.get(owner)
      return failure === undefined ? undefined : {
        root: failure.root,
        changes: [],
        throughRevision: 0,
        generation: 0,
        healthy: false,
        healthRevision: failure.revision,
      }
    }
    const inspectedState = subscription.state
    await inspectedState.settle(signal)
    subscription = this.subscriptions.get(owner)
    if (subscription === undefined) return undefined
    const changes = [...subscription.pending.values()].sort((left, right) =>
      left.displayPath.localeCompare(right.displayPath))
    const health = inspectedState.health()
    const snapshot = {
      root: inspectedState.root,
      changes,
      throughRevision: changes.reduce((maximum, change) => Math.max(maximum, change.revision), 0),
      generation: inspectedState.generation,
      healthy: health.healthy,
      healthRevision: health.revision,
    }
    // Surface the degraded boundary once before attempting a fresh watcher.
    if (!health.healthy) this.recover(inspectedState)
    return snapshot
  }

  acknowledge(owner: object, receipt: WorkspaceInvalidationReceipt): void {
    const subscription = this.subscriptions.get(owner)
    if (subscription === undefined) return
    for (const entry of receipt.entries) {
      const change = subscription.pending.get(entry.absolutePath)
      if (change?.revision === entry.revision && change.generation === entry.generation) {
        subscription.pending.delete(entry.absolutePath)
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const states = [...this.states.values()]
    this.states.clear()
    this.subscriptions = new WeakMap()
    this.failures = new WeakMap()
    await Promise.allSettled(states.map(state => state.close()))
    await Promise.allSettled([...this.closing])
  }
}
