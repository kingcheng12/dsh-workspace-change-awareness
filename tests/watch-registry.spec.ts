import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceWatchRegistry } from '../src/watch-registry.js'
import type {
  WatcherFactory,
  WatcherHandle,
  WorkspaceWatchEvent,
} from '../src/watch-registry.js'

type Listener = (...arguments_: unknown[]) => void

class FakeWatcher {
  readonly listeners = new Map<string, Listener[]>()
  closes = 0

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event)
    if (listeners === undefined) this.listeners.set(event, [listener])
    else listeners.push(listener)
    return this
  }

  emit(event: string, ...arguments_: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...arguments_)
  }

  async close(): Promise<void> {
    this.closes += 1
  }
}

function setup() {
  const watchers: FakeWatcher[] = []
  const options: unknown[] = []
  const factory: WatcherFactory = (_root, nextOptions) => {
    const watcher = new FakeWatcher()
    watchers.push(watcher)
    options.push(nextOptions)
    return watcher as unknown as WatcherHandle
  }
  const warnings: string[] = []
  const registry = new WorkspaceWatchRegistry({
    debounceMs: 0,
    maxWaitMs: 10,
    usePolling: false,
    pollIntervalMs: 100,
    ignoredDirectories: ['.git', 'node_modules'],
  }, { warn: message => warnings.push(message) }, factory)
  return { registry, watchers, options, warnings }
}

describe('WorkspaceWatchRegistry', () => {
  it('shares one watcher while retaining independent session queues', async () => {
    const { registry, watchers } = setup()
    const root = join(process.cwd(), 'fixture')
    const first = {}
    const second = {}
    registry.attach(first, root)
    registry.attach(second, root)
    expect(watchers).toHaveLength(1)
    watchers[0]?.emit('ready')
    watchers[0]?.emit('change', join(root, 'src', 'a.ts'))

    const firstSnapshot = await registry.snapshot(first)
    const secondSnapshot = await registry.snapshot(second)
    expect(firstSnapshot?.changes.map(change => [change.event, change.displayPath])).toEqual([
      ['change', 'src/a.ts'],
    ])
    expect(secondSnapshot?.changes).toHaveLength(1)

    registry.acknowledge(first, {
      entries: firstSnapshot?.changes.map(change => ({
        absolutePath: change.absolutePath,
        revision: change.revision,
        generation: change.generation,
      })) ?? [],
    })
    expect((await registry.snapshot(first))?.changes).toHaveLength(0)
    expect((await registry.snapshot(second))?.changes).toHaveLength(1)

    registry.detach(first)
    expect(watchers[0]?.closes).toBe(0)
    registry.detach(second)
    await registry.close()
    expect(watchers[0]?.closes).toBe(1)
  })

  it('coalesces atomic replacement and transient creation events', async () => {
    const { registry, watchers } = setup()
    const root = join(process.cwd(), 'fixture')
    const owner = {}
    registry.attach(owner, root)
    watchers[0]?.emit('ready')
    const replaced = join(root, 'replaced.ts')
    const transient = join(root, 'transient.ts')
    watchers[0]?.emit('unlink', replaced)
    watchers[0]?.emit('add', replaced)
    watchers[0]?.emit('add', transient)
    watchers[0]?.emit('change', transient)
    watchers[0]?.emit('unlink', transient)

    expect((await registry.snapshot(owner))?.changes.map(change => [change.event, change.displayPath])).toEqual([
      ['change', 'replaced.ts'],
    ])
    await registry.close()
  })

  it('passes a segment-based ignore predicate to Chokidar', async () => {
    const { registry, watchers, options } = setup()
    const root = join(process.cwd(), 'fixture')
    registry.attach({}, root)
    watchers[0]?.emit('ready')
    const ignored = (options[0] as { ignored(path: string): boolean }).ignored

    expect(ignored(join(root, '.git', 'index'))).toBe(true)
    expect(ignored(join(root, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    expect(ignored(join(root, 'src', 'index.ts'))).toBe(false)
    await registry.close()
  })

  it('contains watcher errors and releases readiness', async () => {
    const { registry, watchers, warnings } = setup()
    const owner = {}
    registry.attach(owner, join(process.cwd(), 'fixture'))
    watchers[0]?.emit('error', new Error('watch failed'))

    await expect(registry.snapshot(owner)).resolves.toMatchObject({ changes: [], healthy: false })
    expect(watchers).toHaveLength(2)
    watchers[1]?.emit('ready')
    await expect(registry.snapshot(owner)).resolves.toMatchObject({ healthy: true })
    expect(warnings[0]).toContain('watch failed')
    await registry.close()
  })

  it('does not acknowledge a newer duplicate event with an older exact receipt', async () => {
    const { registry, watchers } = setup()
    const root = join(process.cwd(), 'fixture')
    const owner = {}
    const path = join(root, 'same.ts')
    registry.attach(owner, root)
    watchers[0]?.emit('ready')
    watchers[0]?.emit('change', path)
    const first = await registry.snapshot(owner)
    const firstChange = first?.changes[0]
    if (firstChange === undefined) throw new Error('missing first invalidation')

    watchers[0]?.emit('change', path)
    registry.acknowledge(owner, { entries: [{
      absolutePath: firstChange.absolutePath,
      revision: firstChange.revision,
      generation: firstChange.generation,
    }] })

    const remaining = await registry.snapshot(owner)
    expect(remaining?.changes).toHaveLength(1)
    expect(remaining?.changes[0]?.revision).toBeGreaterThan(firstChange.revision)
    await registry.close()
  })

  it('bounds watcher startup and responds to cancellation before ready', async () => {
    const { registry } = setup()
    const owner = {}
    registry.attach(owner, join(process.cwd(), 'fixture'))
    const controller = new AbortController()
    const pending = registry.snapshot(owner, controller.signal)
    controller.abort(new Error('cancel startup'))

    await expect(pending).rejects.toThrow('cancel startup')
    await registry.close()
  })
})
