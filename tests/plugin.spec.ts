import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { CallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.js'

const SIGNAL = new AbortController().signal
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function version(info: Awaited<ReturnType<typeof stat>>): string {
  return `${String(info.dev)}:${String(info.ino)}:${String(info.size)}:${String(info.mtimeMs)}:${String(info.ctimeMs)}`
}

class HostFileSystem extends FileSystem {
  readonly unavailable = new Set<string>()

  override async resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    options?.signal?.throwIfAborted()
    const absolute = resolve(options?.cwd ?? process.cwd(), path)
    return { targetKey: FsTargetKey(absolute), displayPath: absolute }
  }

  override processPath(target: FsTarget): string { return String(target.targetKey) }
  override fileUrl(target: FsTarget): string { return pathToFileURL(String(target.targetKey)).href }
  override contains(parent: FsTarget, child: FsTarget): boolean {
    const value = relative(String(parent.targetKey), String(child.targetKey))
    return value === '' || (!value.startsWith('..') && !resolve(value).startsWith('..'))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    signal?.throwIfAborted()
    if (this.unavailable.has(String(target.targetKey))) throw new Error('temporary stat failure')
    try {
      const info = await stat(String(target.targetKey))
      return {
        version: FsVersion(version(info)),
        type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
        size: info.size,
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  override async lstat(path: string, options?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const target = await this.resolve(path, { ...options, ...signal === undefined ? {} : { signal } })
    return this.stat(target, signal)
  }

  override async readText(target: FsTarget): Promise<string> { return readFile(String(target.targetKey), 'utf8') }
  override async streamText(target: FsTarget): Promise<AsyncIterable<string>> {
    const text = await this.readText(target)
    return (async function* () { yield text })()
  }
  override async readBytes(target: FsTarget): Promise<Uint8Array> { return readFile(String(target.targetKey)) }
  override async listDir(_target: FsTarget): Promise<FsDirEntry[]> { throw new Error('not used') }
  override async writeText(
    _target: FsTarget,
    _content: string,
    _expected?: FsWriteIntent,
  ): Promise<FsWriteOutcome> { throw new Error('not used') }
  override async editText(_target: FsTarget, _edit: FsEditRequest): Promise<FsEditOutcome> {
    throw new Error('not used')
  }
}

interface TestAgent extends Agent {
  readonly injected: ReturnType<typeof createUserMessage>[]
  readonly steered: ReturnType<typeof createUserMessage>[]
}

function testAgent(root: string, idText: string): TestAgent {
  const id = SessionId(idText)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    cwd: root,
  })
  const injected: ReturnType<typeof createUserMessage>[] = []
  const steered: ReturnType<typeof createUserMessage>[] = []
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    injected,
    steered,
    send() {},
    followup() {},
    inject: message => { injected.push(message) },
    steer: message => { steered.push(message) },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function preStep(ctx: Context, agent: Agent) {
  const proposed = createUserMessage({
    content: [{ type: 'text', text: 'continue' }],
    source: { kind: 'user' },
  })
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [proposed], turn: 1, step: 1, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
  )
}

async function setup(root: string) {
  const ctx = new Context()
  const agentRegistry = await ctx.plugin(AgentRegistry)
  const fileSystemFiber = await ctx.plugin(HostFileSystem)
  const fileSystem = ctx.fs as HostFileSystem
  const pluginFiber = await ctx.plugin(plugin, {
    debounceMs: 20,
    maxWaitMs: 250,
    maxNoticePaths: 10,
    statConcurrency: 4,
    ignoredDirectories: ['.git', 'node_modules'],
  })
  return {
    ctx,
    fileSystem,
    close: async () => {
      await pluginFiber.dispose()
      await fileSystemFiber.dispose()
      await agentRegistry.dispose()
    },
  }
}

function stubExecution(
  agent: Agent,
  callIdText: string,
  options: { parent?: ToolExecutionToken; signal?: AbortSignal } = {},
): ToolExecution {
  const callId = CallId(callIdText)
  return {
    callId,
    rootCallId: callId,
    name: 'read',
    arguments: { file_path: 'fixture' },
    agent,
    signal: options.signal ?? SIGNAL,
    token: Symbol(callIdText) as ToolExecutionToken,
    ...options.parent === undefined ? {} : { parent: options.parent },
  }
}

const SUCCESS: ToolExecutionResult = { isError: false, value: null, content: [] }
const FAILURE = {
  isError: true,
  content: [{ type: 'text', text: 'blocked after execution' }],
  error: { name: 'Error', code: 'BLOCKED', message: 'blocked after execution' },
} as unknown as ToolExecutionResult

function emitSessionEvent(ctx: Context, session: Session, event: SessionEvent): void {
  ctx.emit('session/event', session, event)
}

function openToolStep(ctx: Context, agent: Agent, exec: ToolExecution, turn: number): void {
  agent.session.append('turn/start', { turn })
  const start = agent.session.append('step/start', { turn, step: 1 })
  emitSessionEvent(ctx, agent.session, start)
  agent.session.append('tool/call', {
    turn,
    step: 1,
    callId: exec.callId,
    name: exec.name,
    arguments: '{}',
  })
}

function closeToolStep(
  ctx: Context,
  agent: Agent,
  exec: ToolExecution,
  result: ToolExecutionResult,
  turn: number,
): void {
  const toolResult = agent.session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({
      callId: exec.callId,
      content: result.content,
      isError: result.isError,
    }),
  }, { surfaceOp: 'append' })
  emitSessionEvent(ctx, agent.session, toolResult)
  const end = agent.session.append('step/end', { turn, step: 1 })
  emitSessionEvent(ctx, agent.session, end)
  agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function commitObservation(
  ctx: Context,
  agent: Agent,
  target: FsTarget,
  observation: { kind: 'present'; version: FsInfo['version'] } | { kind: 'absent' },
  callId: string,
  turn: number,
): void {
  const exec = stubExecution(agent, callId)
  openToolStep(ctx, agent, exec, turn)
  ctx.emit('fs/observed', target, observation, exec)
  ctx.emit('tools/result', exec, SUCCESS)
  closeToolStep(ctx, agent, exec, SUCCESS, turn)
}

function commitNotice(ctx: Context, agent: Agent, message: ReturnType<typeof createUserMessage>): void {
  ctx.emit('session/event', agent.session, {
    type: 'user/message',
    seq: agent.session.events.length,
    time: Date.now(),
    data: message,
    surfaceOp: 'append',
    sourceEventSeqs: [],
  } as SessionEvent)
}

function noticeText(messages: readonly ReturnType<typeof createUserMessage>[]): string {
  return messages
    .filter(message => message.source.kind === plugin.name)
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

describe('workspace-change-awareness plugin', () => {
  it('reports another agent write while suppressing the writer\'s acknowledged version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-change-awareness-'))
    temporaryRoots.push(root)
    const path = join(root, 'shared.ts')
    await writeFile(path, 'before\n')
    const { ctx, close } = await setup(root)
    const first = testAgent(root, 'first')
    const second = testAgent(root, 'second')
    const detachFirst = ctx.agents.register(first)
    const detachSecond = ctx.agents.register(second)
    try {
      // Wait for the shared watcher to become ready without producing a notice.
      const firstReady = await preStep(ctx, first)
      const secondReady = await preStep(ctx, second)
      if (firstReady.kind !== 'enter' || secondReady.kind !== 'enter') throw new Error('unexpected ready rejection')
      expect(firstReady.messages).toHaveLength(1)
      expect(secondReady.messages).toHaveLength(1)
      const target = await ctx.fs.resolve(path)
      const before = await ctx.fs.stat(target)
      if (before === undefined) throw new Error('missing baseline file')
      commitObservation(ctx, first, target, { kind: 'present', version: before.version }, 'first-read', 1)
      commitObservation(ctx, second, target, { kind: 'present', version: before.version }, 'second-read', 1)

      await writeFile(path, 'after, with a different size\n')
      const after = await ctx.fs.stat(target)
      if (after === undefined) throw new Error('missing updated file')
      // This exact observation models Agent A's successful, durably logged DSH write.
      commitObservation(ctx, first, target, { kind: 'present', version: after.version }, 'first-write', 2)

      const firstDecision = await preStep(ctx, first)
      const secondDecision = await preStep(ctx, second)
      expect(firstDecision.kind).toBe('enter')
      expect(secondDecision.kind).toBe('enter')
      if (firstDecision.kind !== 'enter' || secondDecision.kind !== 'enter') throw new Error('unexpected reject')
      expect(noticeText(firstDecision.messages)).toBe('')
      expect(noticeText(secondDecision.messages)).toContain('modified')
      expect(noticeText(secondDecision.messages)).toContain(JSON.stringify('shared.ts'))
    } finally {
      detachSecond()
      detachFirst()
      await close()
    }
  })

  it('revalidates an observed file even without relying on a watcher event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-change-awareness-'))
    temporaryRoots.push(root)
    const path = join(root, 'observed.ts')
    await writeFile(path, 'v1')
    const { ctx, close } = await setup(root)
    const agent = testAgent(root, 'observed')
    const detach = ctx.agents.register(agent)
    try {
      await preStep(ctx, agent)
      const target = await ctx.fs.resolve(path)
      const baseline = await ctx.fs.stat(target)
      if (baseline === undefined) throw new Error('missing baseline')
      commitObservation(ctx, agent, target, { kind: 'present', version: baseline.version }, 'observed-read', 1)
      await writeFile(path, 'v2 with different size')

      const decision = await preStep(ctx, agent)
      if (decision.kind !== 'enter') throw new Error('unexpected reject')
      expect(noticeText(decision.messages)).toContain('Workspace freshness warning')
    } finally {
      detach()
      await close()
    }
  })

  it('delivers each observed external version once and steers again only for a newer version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-change-awareness-'))
    temporaryRoots.push(root)
    const path = join(root, 'changing.ts')
    await writeFile(path, 'v1')
    const { ctx, close } = await setup(root)
    const agent = testAgent(root, 'version-ledger')
    const detach = ctx.agents.register(agent)
    try {
      await preStep(ctx, agent)
      const target = await ctx.fs.resolve(path)
      const initial = await ctx.fs.stat(target)
      if (initial === undefined) throw new Error('missing initial file')
      commitObservation(ctx, agent, target, { kind: 'present', version: initial.version }, 'ledger-read', 1)

      await writeFile(path, 'v2 is longer')
      const decision = await preStep(ctx, agent)
      if (decision.kind !== 'enter') throw new Error('unexpected reject')
      const notice = decision.messages.find(message => message.source.kind === plugin.name)
      if (notice === undefined) throw new Error('missing change notice')
      commitNotice(ctx, agent, notice)

      await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 2, signal: SIGNAL })
      expect(agent.steered).toHaveLength(0)

      await writeFile(path, 'v3 is substantially longer than v2')
      await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 3, signal: SIGNAL })
      expect(agent.steered).toHaveLength(1)
      commitNotice(ctx, agent, agent.steered[0]!)
      await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 3, signal: SIGNAL })
      expect(agent.steered).toHaveLength(1)
    } finally {
      detach()
      await close()
    }
  })

  it('does not self-ack a nested filesystem effect when its outer tool result fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-change-awareness-'))
    temporaryRoots.push(root)
    const path = join(root, 'nested.ts')
    await writeFile(path, 'before')
    const { ctx, close } = await setup(root)
    const agent = testAgent(root, 'failed-outer')
    const detach = ctx.agents.register(agent)
    try {
      await preStep(ctx, agent)
      const target = await ctx.fs.resolve(path)
      const before = await ctx.fs.stat(target)
      if (before === undefined) throw new Error('missing baseline')
      commitObservation(ctx, agent, target, { kind: 'present', version: before.version }, 'baseline-read', 1)

      await writeFile(path, 'after a nested write')
      const after = await ctx.fs.stat(target)
      if (after === undefined) throw new Error('missing updated file')
      const outer = stubExecution(agent, 'run-code')
      const inner = stubExecution(agent, 'nested-write', { parent: outer.token })
      openToolStep(ctx, agent, outer, 2)
      ctx.emit('fs/observed', target, { kind: 'present', version: after.version }, inner)
      ctx.emit('tools/result', inner, SUCCESS)
      ctx.emit('tools/result', outer, FAILURE)
      closeToolStep(ctx, agent, outer, FAILURE, 2)

      const decision = await preStep(ctx, agent)
      if (decision.kind !== 'enter') throw new Error('unexpected reject')
      expect(noticeText(decision.messages)).toContain(JSON.stringify('nested.ts'))
    } finally {
      detach()
      await close()
    }
  })

  it('retains an unavailable watcher invalidation until it can be verified', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-change-awareness-'))
    temporaryRoots.push(root)
    const { ctx, fileSystem, close } = await setup(root)
    const agent = testAgent(root, 'unavailable-recovery')
    const detach = ctx.agents.register(agent)
    try {
      await preStep(ctx, agent)
      const path = join(root, 'recover.ts')
      const target = await ctx.fs.resolve(path)
      await writeFile(path, 'appeared')
      fileSystem.unavailable.add(String(target.targetKey))

      const unavailable = await preStep(ctx, agent)
      if (unavailable.kind !== 'enter') throw new Error('unexpected reject')
      expect(noticeText(unavailable.messages)).toContain('could not verify')
      const unavailableNotice = unavailable.messages.find(message => message.source.kind === plugin.name)
      if (unavailableNotice === undefined) throw new Error('missing unavailable notice')
      commitNotice(ctx, agent, unavailableNotice)

      fileSystem.unavailable.clear()
      const recovered = await preStep(ctx, agent)
      if (recovered.kind !== 'enter') throw new Error('unexpected reject')
      expect(noticeText(recovered.messages)).toContain(JSON.stringify('recover.ts'))
      expect(noticeText(recovered.messages)).not.toContain('could not verify')
    } finally {
      detach()
      await close()
    }
  })

  it('delivers bounded path batches without consuming omitted changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-change-awareness-'))
    temporaryRoots.push(root)
    const { ctx, close } = await setup(root)
    const agent = testAgent(root, 'bounded-batches')
    const detach = ctx.agents.register(agent)
    try {
      await preStep(ctx, agent)
      await Promise.all(Array.from({ length: 12 }, (_, index) =>
        writeFile(join(root, `created-${String(index).padStart(2, '0')}.ts`), String(index))))

      const first = await preStep(ctx, agent)
      if (first.kind !== 'enter') throw new Error('unexpected reject')
      expect(noticeText(first.messages)).toContain('2 additional changed path(s) omitted')
      const firstNotice = first.messages.find(message => message.source.kind === plugin.name)
      if (firstNotice === undefined) throw new Error('missing first batch')
      commitNotice(ctx, agent, firstNotice)

      const second = await preStep(ctx, agent)
      if (second.kind !== 'enter') throw new Error('unexpected reject')
      expect(noticeText(second.messages)).toContain('created-10.ts')
      expect(noticeText(second.messages)).toContain('created-11.ts')
      expect(noticeText(second.messages)).not.toContain('additional changed path(s) omitted')
    } finally {
      detach()
      await close()
    }
  })

  it('injects a conservative reminder when a persisted session resumes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-change-awareness-'))
    temporaryRoots.push(root)
    const { ctx, close } = await setup(root)
    const agent = testAgent(root, 'resumed')
    const detach = ctx.agents.register(agent)
    try {
      agentEvents(ctx, agent).emit('agent/session-start', { source: 'resume' })
      expect(agent.injected).toHaveLength(0)
      const rejected = await agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        { messages: [], turn: 1, step: 1, signal: SIGNAL },
        () => Promise.resolve({ kind: 'reject' as const }),
      )
      expect(rejected.kind).toBe('reject')
      const first = await preStep(ctx, agent)
      if (first.kind !== 'enter') throw new Error('unexpected reject')
      expect(noticeText(first.messages)).toContain('resumed from persisted or compacted history')
      const reminder = first.messages.find(message => message.source.kind === plugin.name)
      if (reminder === undefined) throw new Error('missing resume reminder')
      commitNotice(ctx, agent, reminder)
      const second = await preStep(ctx, agent)
      if (second.kind !== 'enter') throw new Error('unexpected reject')
      expect(noticeText(second.messages)).toBe('')
    } finally {
      detach()
      await close()
    }
  })

  it('steers another step when a new file arrives at the turn-stopping boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-change-awareness-'))
    temporaryRoots.push(root)
    const { ctx, close } = await setup(root)
    const agent = testAgent(root, 'late-change')
    const detach = ctx.agents.register(agent)
    try {
      await preStep(ctx, agent) // watcher readiness baseline
      await writeFile(join(root, 'late.ts'), 'created while the model was running\n')

      await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
      expect(agent.steered).toHaveLength(1)
      expect(noticeText(agent.steered)).toContain('created')
      expect(noticeText(agent.steered)).toContain('late.ts')
    } finally {
      detach()
      await close()
    }
  })
})
