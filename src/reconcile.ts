import { createHash } from 'node:crypto'
import type { FileSystem, FsInfo, FsObservation, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { ObservationStore, sameObservation } from './observations.js'
import type { NotifiedState } from './observations.js'
import type {
  WorkspaceInvalidation,
  WorkspaceInvalidationReceipt,
  WorkspaceInvalidationSnapshot,
  WorkspaceWatchEvent,
} from './watch-registry.js'
import { WorkspaceWatchRegistry } from './watch-registry.js'

export type WorkspaceChangeAction = 'created' | 'modified' | 'deleted' | 'unavailable'

export interface WorkspaceChange {
  readonly action: WorkspaceChangeAction
  readonly path: string
}

export interface WorkspaceInspection {
  readonly changes: readonly WorkspaceChange[]
  readonly fingerprint: string
  readonly throughRevision?: number
  readonly hasVerifiedChange: boolean
  readonly notificationStates: readonly NotifiedState[]
  readonly receiptEntries: readonly (WorkspaceInvalidationReceipt['entries'][number] | undefined)[]
  readonly receipt?: WorkspaceInvalidationReceipt
}

type CurrentState =
  | { readonly kind: 'present'; readonly version: FsVersion; readonly type: FsInfo['type'] }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable' }

interface Candidate {
  readonly target?: FsTarget
  readonly targetKey: string
  readonly displayPath: string
  readonly current: CurrentState
  readonly baseline?: FsObservation
  readonly dirty?: boolean
  readonly watcherEvent?: WorkspaceWatchEvent
  readonly watcherPath?: string
  readonly watcherRevision?: number
  readonly watcherGeneration?: number
}

function currentObservation(current: CurrentState): FsObservation | undefined {
  if (current.kind === 'unavailable') return undefined
  return current.kind === 'absent'
    ? { kind: 'absent' }
    : { kind: 'present', version: current.version }
}

function currentStateKey(current: CurrentState): string {
  if (current.kind !== 'present') return current.kind
  return `present:${current.type}:${current.version}`
}

function classify(candidate: Candidate): WorkspaceChangeAction | undefined {
  if (candidate.current.kind === 'unavailable') return 'unavailable'
  if (candidate.baseline !== undefined) {
    const current = currentObservation(candidate.current)
    if (current !== undefined && sameObservation(candidate.baseline, current)) return undefined
    if (candidate.baseline.kind === 'absent') return 'created'
    if (candidate.current.kind === 'absent') return 'deleted'
    return 'modified'
  }
  if (candidate.watcherEvent === 'add') return candidate.current.kind === 'absent' ? 'deleted' : 'created'
  if (candidate.watcherEvent === 'unlink') return candidate.current.kind === 'present' ? 'modified' : 'deleted'
  if (candidate.watcherEvent === 'change') return candidate.current.kind === 'absent' ? 'deleted' : 'modified'
  if (candidate.dirty === true) return candidate.current.kind === 'absent' ? 'deleted' : 'modified'
  return undefined
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await operation(values[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

async function statTarget(
  fileSystem: FileSystem,
  target: FsTarget,
  signal?: AbortSignal,
): Promise<CurrentState> {
  try {
    const info = await fileSystem.stat(target, signal)
    return info === undefined
      ? { kind: 'absent' }
      : { kind: 'present', version: info.version, type: info.type }
  } catch (error: unknown) {
    if (signal?.aborted === true) throw error
    return { kind: 'unavailable' }
  }
}

/** Reconcile watcher invalidations and every per-session observed version. */
export class WorkspaceReconciler {
  constructor(
    private readonly fileSystem: FileSystem,
    private readonly observations: ObservationStore,
    private readonly watchers: WorkspaceWatchRegistry,
    private readonly statConcurrency: number,
  ) {}

  private async watcherCandidate(
    owner: object,
    snapshot: WorkspaceInvalidationSnapshot,
    invalidation: WorkspaceInvalidation,
    signal?: AbortSignal,
  ): Promise<Candidate> {
    try {
      const target = await this.fileSystem.resolve(invalidation.absolutePath, {
        cwd: snapshot.root,
        ...signal === undefined ? {} : { signal },
      })
      const current = await statTarget(this.fileSystem, target, signal)
      const observed = this.observations.get(owner, target.targetKey)
      return {
        target,
        targetKey: target.targetKey,
        displayPath: invalidation.displayPath,
        current,
        ...observed === undefined ? {} : { baseline: observed.observation },
        dirty: this.observations.isDirty(owner, target.targetKey),
        watcherEvent: invalidation.event,
        watcherPath: invalidation.absolutePath,
        watcherRevision: invalidation.revision,
        watcherGeneration: invalidation.generation,
      }
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      return {
        targetKey: `path:${invalidation.absolutePath}`,
        displayPath: invalidation.displayPath,
        current: { kind: 'unavailable' },
        watcherEvent: invalidation.event,
        watcherPath: invalidation.absolutePath,
        watcherRevision: invalidation.revision,
        watcherGeneration: invalidation.generation,
      }
    }
  }

  async inspect(owner: object, signal?: AbortSignal): Promise<WorkspaceInspection> {
    const snapshot = await this.watchers.snapshot(owner, signal)
    const watcherCandidates = snapshot === undefined
      ? []
      : await mapConcurrent(snapshot.changes, this.statConcurrency, change =>
          this.watcherCandidate(owner, snapshot, change, signal))

    const candidates = new Map<string, Candidate>()
    for (const candidate of watcherCandidates) candidates.set(candidate.targetKey, candidate)

    const knownTargets = new Map<string, {
      target: FsTarget
      baseline?: FsObservation
      dirty: boolean
    }>()
    for (const observed of this.observations.list(owner)) {
      knownTargets.set(observed.target.targetKey, {
        target: observed.target,
        baseline: observed.observation,
        dirty: this.observations.isDirty(owner, observed.target.targetKey),
      })
    }
    for (const target of this.observations.listDirty(owner)) {
      const known = knownTargets.get(target.targetKey)
      if (known === undefined) knownTargets.set(target.targetKey, { target, dirty: true })
      else known.dirty = true
    }
    const remainingKnown = [...knownTargets.values()]
      .filter(known => !candidates.has(known.target.targetKey))
    const observedCandidates = await mapConcurrent(remainingKnown, this.statConcurrency, async known => ({
      target: known.target,
      targetKey: known.target.targetKey,
      displayPath: known.target.displayPath,
      current: await statTarget(this.fileSystem, known.target, signal),
      ...known.baseline === undefined ? {} : { baseline: known.baseline },
      dirty: known.dirty,
    } satisfies Candidate))
    for (const candidate of observedCandidates) candidates.set(candidate.targetKey, candidate)

    const rendered: Array<WorkspaceChange & NotifiedState & {
      readonly verified: boolean
      readonly watcherEntry?: WorkspaceInvalidationReceipt['entries'][number]
    }> = []
    const immediatelyAcknowledged: WorkspaceInvalidationReceipt['entries'][number][] = []
    for (const candidate of candidates.values()) {
      const action = classify(candidate)
      const stateKey = currentStateKey(candidate.current)
      const watcherEntry = candidate.watcherPath === undefined
        || candidate.watcherRevision === undefined
        || candidate.watcherGeneration === undefined
        ? undefined
        : {
            absolutePath: candidate.watcherPath,
            revision: candidate.watcherRevision,
            generation: candidate.watcherGeneration,
          }
      if (action === undefined) {
        this.observations.clearNotified(owner, candidate.targetKey)
        this.observations.clearDirty(owner, candidate.targetKey)
        if (watcherEntry !== undefined) immediatelyAcknowledged.push(watcherEntry)
        continue
      }
      if (this.observations.wasNotified(owner, candidate.targetKey, stateKey)) {
        if (candidate.current.kind !== 'unavailable' && watcherEntry !== undefined) {
          immediatelyAcknowledged.push(watcherEntry)
        }
        continue
      }
      rendered.push({
        action,
        path: candidate.displayPath,
        targetKey: candidate.targetKey,
        stateKey,
        verified: candidate.current.kind !== 'unavailable',
        ...watcherEntry === undefined ? {} : { watcherEntry },
      })
    }
    if (snapshot !== undefined) {
      const healthTargetKey = `watcher-health:${snapshot.root}`
      if (snapshot.healthy) {
        this.observations.clearNotified(owner, healthTargetKey)
      } else if (!this.observations.wasNotified(owner, healthTargetKey, 'unavailable')) {
        rendered.push({
          action: 'unavailable',
          path: '.',
          targetKey: healthTargetKey,
          stateKey: 'unavailable',
          verified: false,
        })
      }
    }
    rendered.sort((left, right) => left.path.localeCompare(right.path) || left.action.localeCompare(right.action))

    if (immediatelyAcknowledged.length > 0) {
      this.watchers.acknowledge(owner, { entries: immediatelyAcknowledged })
    }
    const coveredEntries = rendered.flatMap(change =>
      change.verified && change.watcherEntry !== undefined ? [change.watcherEntry] : [])
    const fingerprint = createHash('sha256')
      .update(rendered.map(change => `${change.action}\0${change.targetKey}\0${change.stateKey}`).join('\n'))
      .digest('hex')
    return {
      changes: rendered.map(({ action, path }) => ({ action, path })),
      fingerprint,
      ...coveredEntries.length > 0
        ? { throughRevision: Math.max(...coveredEntries.map(entry => entry.revision)) }
        : {},
      hasVerifiedChange: rendered.some(change => change.verified),
      notificationStates: rendered.map(({ targetKey, stateKey }) => ({ targetKey, stateKey })),
      receiptEntries: rendered.map(change =>
        change.verified && change.watcherEntry !== undefined ? change.watcherEntry : undefined),
      ...coveredEntries.length > 0 ? { receipt: { entries: coveredEntries } } : {},
    }
  }
}
