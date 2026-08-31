import { describe, expect, it } from 'vitest'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { ObservationStore, sameObservation } from '../src/observations.js'

const target = (path: string) => ({ targetKey: FsTargetKey(path), displayPath: path })

describe('ObservationStore', () => {
  it('isolates acknowledged versions by agent session', () => {
    const store = new ObservationStore()
    const first = {}
    const second = {}
    store.observe(target('src/a.ts'), { kind: 'present', version: FsVersion('v1') }, { agent: { session: first } })
    store.observe(target('src/a.ts'), { kind: 'present', version: FsVersion('v2') }, { agent: { session: second } })

    expect(store.get(first, 'src/a.ts')?.observation).toEqual({ kind: 'present', version: 'v1' })
    expect(store.get(second, 'src/a.ts')?.observation).toEqual({ kind: 'present', version: 'v2' })
  })

  it('keeps confirmed absence distinct from unseen state', () => {
    const store = new ObservationStore()
    const owner = {}
    store.observe(target('missing.ts'), { kind: 'absent' }, { agent: { session: owner } })

    expect(store.get(owner, 'missing.ts')?.observation).toEqual({ kind: 'absent' })
    expect(store.get(owner, 'unseen.ts')).toBeUndefined()
  })

  it('compares opaque provider versions without interpreting them', () => {
    expect(sameObservation(
      { kind: 'present', version: FsVersion('same') },
      { kind: 'present', version: FsVersion('same') },
    )).toBe(true)
    expect(sameObservation(
      { kind: 'present', version: FsVersion('old') },
      { kind: 'present', version: FsVersion('new') },
    )).toBe(false)
    expect(sameObservation({ kind: 'absent' }, { kind: 'absent' })).toBe(true)
  })
})

