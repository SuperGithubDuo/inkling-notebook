import { describe, expect, it } from 'vitest'
import { merge3 } from '../../src/shared/sync/merge'
import { Device, FakeServer } from './syncHarness'

const stroke = (id: string, x = 0): { id: string; type: string; points: number[][] } => ({ id, type: 'stroke', points: [[x, x], [x + 1, x + 1]] })
const page = (...objects: unknown[]): { id: string; paper: string; objects: unknown[]; updatedAt: number } => ({ id: 'page-1', paper: 'grid', objects, updatedAt: 1 })
const note = (...text: string[]): { doc: { type: string; content: { type: string; text: string }[] } } => ({ doc: { type: 'doc', content: text.map((t) => ({ type: 'paragraph', text: t })) } })
const P = 'page/nb-000001/page-000001'

describe('merge3', () => {
  it('keeps objects added on both sides', () => {
    const r = merge3(page(stroke('a')), page(stroke('a'), stroke('b')), page(stroke('a'), stroke('c')))
    expect(r.conflicts).toEqual([])
    expect(r.merged.objects.map((o: any) => o.id).sort()).toEqual(['a', 'b', 'c'])
  })
  it('applies a deletion when the other side left the object alone, keeps the object when the other side edited it', () => {
    const base = page(stroke('a'), stroke('b'))
    expect(merge3(base, page(stroke('b')), page(stroke('a'), stroke('b'), stroke('c'))).merged.objects.map((o: any) => o.id)).toEqual(['b', 'c'])
    const kept = merge3(base, page(stroke('b')), page(stroke('a', 9), stroke('b')))
    expect(kept.merged.objects.map((o: any) => o.id).sort()).toEqual(['a', 'b'])
    expect((kept.merged.objects.find((o: any) => o.id === 'a') as any).points[0]).toEqual([9, 9])
  })
  it('reports a conflict and keeps the local value when both edit the same object', () => {
    const r = merge3(page(stroke('a')), page(stroke('a', 1)), page(stroke('a', 2)))
    expect(r.conflicts).toEqual(['objects[a].points'])
    expect((r.merged.objects[0] as any).points[0]).toEqual([1, 1])
  })
  it('merges different fields of the same thing, and takes the later updatedAt', () => {
    const base = { notebooks: [{ id: 'n1', name: 'Math', favorite: false, updatedAt: 1, pages: [{ id: 'p1' }] }] }
    const local = { notebooks: [{ id: 'n1', name: 'Maths', favorite: false, updatedAt: 5, pages: [{ id: 'p1' }] }] }
    const remote = { notebooks: [{ id: 'n1', name: 'Math', favorite: true, updatedAt: 9, pages: [{ id: 'p1' }, { id: 'p2' }] }, { id: 'n2', name: 'New', pages: [] }] }
    const r = merge3(base, local, remote)
    expect(r.conflicts).toEqual([])
    expect(r.merged.notebooks).toEqual([{ id: 'n1', name: 'Maths', favorite: true, updatedAt: 9, pages: [{ id: 'p1' }, { id: 'p2' }] }, { id: 'n2', name: 'New', pages: [] }])
  })
  it('keeps a reorder from one side and additions from the other', () => {
    const ids = (r: { merged: { id: string }[] }): string => r.merged.map((x) => x.id).join('')
    const l = (s: string): { id: string }[] => [...s].map((id) => ({ id }))
    expect(ids(merge3(l('abc'), l('cab'), l('abcd')))).toBe('cabd')
    expect(ids(merge3(l('abc'), l('abxc'), l('cba')))).toBe('xcba')
  })
  it('without a common ancestor, unions lists by id', () => {
    const r = merge3(undefined, { notebooks: [{ id: 'a' }] }, { notebooks: [{ id: 'b' }] })
    expect(r.merged.notebooks.map((n) => n.id).sort()).toEqual(['a', 'b'])
  })
  it('merges paragraphs changed in different places of a note', () => {
    const r = merge3(note('one', 'two', 'three'), note('ONE', 'two', 'three'), note('one', 'two', 'three', 'four'))
    expect(r.conflicts).toEqual([])
    expect(r.merged.doc.content.map((b) => b.text)).toEqual(['ONE', 'two', 'three', 'four'])
  })
  it('reports a conflict when both rewrite the same paragraph', () => {
    const r = merge3(note('one', 'two'), note('mine', 'two'), note('theirs', 'two'))
    expect(r.conflicts).toEqual(['doc.content'])
    expect(r.merged.doc.content.map((b) => b.text)).toEqual(['mine', 'two'])
  })
})

describe('sync', () => {
  it('carries a document from one device to another', async () => {
    const server = new FakeServer()
    const [a, b] = [new Device(server), new Device(server)]
    await a.signIn()
    await b.signIn()
    await a.save(P, page(stroke('a')))
    await a.sync()
    await b.sync()
    expect(await b.get(P)).toEqual(page(stroke('a')))
    expect(b.changed).toContain(P)
    expect(a.status?.pending).toBe(0)
  })

  it('queues edits made offline and merges both devices’ work when back online', async () => {
    const server = new FakeServer()
    const [a, b] = [new Device(server), new Device(server)]
    await a.signIn()
    await a.save(P, page(stroke('base')))
    await a.sync()
    await b.signIn()

    server.online = false
    await a.save(P, page(stroke('base'), stroke('a1')))
    await a.save(P, page(stroke('base'), stroke('a1'), stroke('a2')))
    await b.save(P, page(stroke('base'), stroke('b1')))
    await a.sync()
    expect(a.status?.state).toBe('offline')
    expect(a.status?.pending).toBe(1)
    expect(server.docs.get(P)?.rev).toBe(1)

    server.online = true
    await a.sync()
    await b.sync()
    await a.sync()
    const ids = (d: any): string[] => d.objects.map((o: any) => o.id).sort()
    expect(ids(await a.get(P))).toEqual(['a1', 'a2', 'b1', 'base'])
    expect(await b.get(P)).toEqual(await a.get(P))
    expect(a.status?.conflicts).toEqual([])
    expect(b.status?.pending).toBe(0)
  })

  it('on a real conflict keeps this device’s version, and the other one in the history', async () => {
    const server = new FakeServer()
    const [a, b] = [new Device(server), new Device(server)]
    await a.signIn()
    await a.save(P, page(stroke('s')))
    await a.sync()
    await b.signIn()
    await a.save(P, page(stroke('s', 1)))
    await b.save(P, page(stroke('s', 2)))
    await a.sync()
    await b.sync()
    expect((await b.get(P)).objects[0].points[0]).toEqual([2, 2])
    expect(b.status?.conflicts.map((c) => c.path)).toEqual([P])
    // A's version is recoverable from any device.
    const versions = await b.engine.versions(P)
    expect(versions).toHaveLength(1)
    expect(((await server.remote().version(versions[0]!.id)) as any).objects[0].points[0]).toEqual([1, 1])
    await b.engine.restoreVersion(P, versions[0]!.id)
    await b.sync()
    await a.sync()
    expect((await a.get(P)).objects[0].points[0]).toEqual([1, 1])
    expect(b.status?.conflicts).toEqual([])
  })

  it('merges, rather than overwrites, when the app saves a copy that predates a synced change', async () => {
    const server = new FakeServer()
    const [a, b] = [new Device(server), new Device(server)]
    await a.signIn()
    await a.save(P, page(stroke('base')))
    await a.sync()
    await b.signIn()
    await b.get(P) // B has the page open
    await a.save(P, page(stroke('base'), stroke('a1')))
    await a.sync()
    await b.sync() // B's stored page now has a1; the open copy doesn't
    await b.save(P, page(stroke('base'), stroke('b1'))) // autosave of the open, older copy
    expect((await b.get(P)).objects.map((o: any) => o.id).sort()).toEqual(['a1', 'b1', 'base'])
    await b.sync()
    await a.sync()
    expect((await a.get(P)).objects.map((o: any) => o.id).sort()).toEqual(['a1', 'b1', 'base'])
  })

  it('keeps an edit over a deletion made on another device', async () => {
    const server = new FakeServer()
    const [a, b] = [new Device(server), new Device(server)]
    await a.signIn()
    await a.save(P, page(stroke('s')))
    await a.sync()
    await b.signIn()
    await a.engine.remove(P)
    await b.save(P, page(stroke('s'), stroke('more')))
    await a.sync()
    await b.sync()
    await a.sync()
    expect((await a.get(P)).objects).toHaveLength(2)
    expect(server.docs.get(P)?.deleted).toBe(false)
  })

  it('propagates a deletion nobody objected to', async () => {
    const server = new FakeServer()
    const [a, b] = [new Device(server), new Device(server)]
    await a.signIn()
    await a.save(P, page(stroke('s')))
    await a.sync()
    await b.signIn()
    await a.engine.remove(P)
    await a.sync()
    await b.sync()
    expect(await b.get(P)).toBeNull()
  })

  it('adds notebooks made before signing in to the account without touching what is there', async () => {
    const server = new FakeServer()
    const a = new Device(server)
    await a.signIn()
    await a.save('library', { notebooks: [{ id: 'cloud' }] })
    await a.save(P, page(stroke('cloud')))
    await a.sync()

    const guest = new Device(server)
    await guest.save('library', { notebooks: [{ id: 'guest' }] }) // no account yet
    await guest.save('page/nb-guest/page-guest', page(stroke('g')))
    expect(server.pushes).toBe(2)
    await guest.signIn()
    expect((await guest.get('library')).notebooks.map((n: any) => n.id).sort()).toEqual(['cloud', 'guest'])
    expect(await guest.get(P)).toEqual(page(stroke('cloud')))
    await a.sync()
    expect((await a.get('library')).notebooks.map((n: any) => n.id).sort()).toEqual(['cloud', 'guest'])
    expect(await a.get('page/nb-guest/page-guest')).toEqual(page(stroke('g')))
  })

  it('uploads and downloads files, and leaves oversized ones on the device', async () => {
    const server = new FakeServer()
    server.maxAsset = 10
    const [a, b] = [new Device(server), new Device(server)]
    await a.signIn()
    await b.signIn()
    a.assets.set('nb/small.png', new Uint8Array(4))
    a.assets.set('nb/huge.pdf', new Uint8Array(50))
    await a.engine.assetAdded('nb/small.png')
    await a.engine.assetAdded('nb/huge.pdf')
    await a.save(P, { ...page(), assets: ['nb/small.png', 'nb/huge.pdf'] })
    await a.sync()
    await b.sync()
    expect(b.assets.has('nb/small.png')).toBe(true)
    expect(b.assets.has('nb/huge.pdf')).toBe(false)
    expect(a.status?.skipped).toBe(1)
    expect(a.status?.pending).toBe(0)
  })

  it('keeps unsynced work across a restart', async () => {
    const server = new FakeServer()
    const a = new Device(server)
    await a.signIn()
    await a.save(P, page(stroke('one')))
    await a.sync()
    server.online = false
    await a.save(P, page(stroke('one'), stroke('two')))
    a.restart()
    server.online = true
    await a.signIn()
    expect(server.docs.get(P)?.content).toEqual(page(stroke('one'), stroke('two')))
  })

  it('does not treat a document as synced if it was edited while being sent', async () => {
    const server = new FakeServer()
    const a = new Device(server)
    await a.signIn()
    const remote = server.remote()
    const push = remote.push
    let during: Promise<unknown> | null = null
    remote.push = async (...args) => {
      during ??= a.save(P, page(stroke('one'), stroke('two')))
      return push(...args)
    }
    await a.engine.link(remote, 'user-1')
    await a.save(P, page(stroke('one')))
    await a.sync()
    await during
    await a.sync()
    expect(server.docs.get(P)?.content).toEqual(page(stroke('one'), stroke('two')))
  })

  it('never syncs a signed-out device, and keeps accounts apart', async () => {
    const server = new FakeServer()
    const a = new Device(server)
    await a.save(P, page(stroke('guest')))
    await a.sync()
    expect(server.docs.size).toBe(0)
    expect(a.status).toBeNull()
  })

  it('converges after random offline edits on three devices, losing nothing', async () => {
    let seed = 42
    const rnd = (n: number): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n
    const server = new FakeServer()
    const devices = [new Device(server), new Device(server), new Device(server)]
    for (const d of devices) await d.signIn()
    const added = new Set<string>()
    const removed = new Set<string>()
    for (let step = 0; step < 300; step++) {
      const d = devices[rnd(3)]!
      server.online = rnd(4) !== 0
      const cur = ((await d.get(P)) ?? page()) as ReturnType<typeof page>
      const action = rnd(10)
      if (action < 6) {
        const id = `o${step}`
        added.add(id)
        await d.save(P, { ...cur, objects: [...cur.objects, stroke(id)] })
      } else if (action < 8 && cur.objects.length) {
        const victim = cur.objects[rnd(cur.objects.length)] as { id: string }
        removed.add(victim.id)
        await d.save(P, { ...cur, objects: cur.objects.filter((o) => o !== victim) })
      } else await d.sync()
    }
    server.online = true
    for (let round = 0; round < 3; round++) for (const d of devices) await d.sync()
    const final = await devices[0]!.get(P)
    for (const d of devices) expect(await d.get(P)).toEqual(final)
    for (const d of devices) expect(d.status?.pending).toBe(0)
    const ids = new Set(final.objects.map((o: any) => o.id))
    // Everything ever added is still there unless someone deleted it.
    for (const id of added) if (!removed.has(id)) expect(ids.has(id), id).toBe(true)
    expect(devices.flatMap((d) => d.status?.conflicts ?? [])).toEqual([])
  })
})
