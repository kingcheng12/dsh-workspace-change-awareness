import type { FsObservation, FsTarget } from '@deepseek-ai/dsh-fs'

/** Minimal structural view of the tool execution carried by `fs/observed`. */
export interface ObservationActor {
  agent?: {
    session?: object
  }
}

/** One target and the authoritative version last acknowledged by a session. */
export interface ObservedTarget {
  readonly target: FsTarget
  readonly observation: FsObservation
}

/** One model-visible workspace state that has already been delivered. */
export interface NotifiedState {
  readonly targetKey: string
  readonly stateKey: string
}

/**
 * Session-isolated observed-file versions. The Harness filesystem tools emit
 * these facts synchronously after successful reads and mutations.
 */
export class ObservationStore {
  private observations = new WeakMap<object, Map<string, ObservedTarget>>()
  private dirty = new WeakMap<object, Map<string, FsTarget>>()
  private notified = new WeakMap<object, Map<string, string>>()

  owner(actor: object | undefined): object | undefined {
    return (actor as ObservationActor | undefined)?.agent?.session
  }

  observe(target: FsTarget, observation: FsObservation, actor: object | undefined): void {
    const owner = this.owner(actor)
    if (owner === undefined) return
    this.commit(owner, target, observation)
  }

  /** Commit an observation only after its successful tool result is durable. */
  commit(owner: object, target: FsTarget, observation: FsObservation): void {
    let targets = this.observations.get(owner)
    if (targets === undefined) {
      targets = new Map()
      this.observations.set(owner, targets)
    }
    targets.set(target.targetKey, { target, observation })
    this.dirty.get(owner)?.delete(target.targetKey)
    this.clearNotified(owner, target.targetKey)
  }

  /** Retain a target whose filesystem effect was not durably shown to the model. */
  markDirty(owner: object, target: FsTarget): void {
    let targets = this.dirty.get(owner)
    if (targets === undefined) {
      targets = new Map()
      this.dirty.set(owner, targets)
    }
    targets.set(target.targetKey, target)
    this.clearNotified(owner, target.targetKey)
  }

  get(owner: object, targetKey: string): ObservedTarget | undefined {
    return this.observations.get(owner)?.get(targetKey)
  }

  list(owner: object): ObservedTarget[] {
    return [...(this.observations.get(owner)?.values() ?? [])]
  }

  listDirty(owner: object): FsTarget[] {
    return [...(this.dirty.get(owner)?.values() ?? [])]
  }

  isDirty(owner: object, targetKey: string): boolean {
    return this.dirty.get(owner)?.has(targetKey) === true
  }

  clearDirty(owner: object, targetKey: string): void {
    const targets = this.dirty.get(owner)
    if (targets === undefined) return
    targets.delete(targetKey)
    if (targets.size === 0) this.dirty.delete(owner)
  }

  wasNotified(owner: object, targetKey: string, stateKey: string): boolean {
    return this.notified.get(owner)?.get(targetKey) === stateKey
  }

  markNotified(owner: object, states: readonly NotifiedState[]): void {
    if (states.length === 0) return
    let targets = this.notified.get(owner)
    if (targets === undefined) {
      targets = new Map()
      this.notified.set(owner, targets)
    }
    for (const state of states) targets.set(state.targetKey, state.stateKey)
  }

  clearNotified(owner: object, targetKey: string): void {
    const targets = this.notified.get(owner)
    if (targets === undefined) return
    targets.delete(targetKey)
    if (targets.size === 0) this.notified.delete(owner)
  }

  clear(): void {
    this.observations = new WeakMap()
    this.dirty = new WeakMap()
    this.notified = new WeakMap()
  }
}

/** Whether two provider observations describe the same acknowledged state. */
export function sameObservation(left: FsObservation, right: FsObservation): boolean {
  return left.kind === right.kind
    && (left.kind === 'absent' || (right.kind === 'present' && left.version === right.version))
}
