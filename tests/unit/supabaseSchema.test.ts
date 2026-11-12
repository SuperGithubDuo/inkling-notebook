/**
 * Runs the real migration in a real Postgres (PGlite, in-process) and checks the
 * security rules as the roles Supabase uses: a signed-in user (`authenticated`,
 * identified by the JWT's `sub`) and a visitor (`anon`). Supabase's own auth and
 * storage schemas are stubbed with the same shapes the migration relies on.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const PAGE = 'page/notebook-1/page-000001'
let db: PGlite

const SUPABASE_STUB = `
  create role anon nologin; create role authenticated nologin;
  create schema auth; create schema storage;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, unique (bucket_id, name));
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  grant usage on schema public, auth, storage to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  grant all on storage.objects to anon, authenticated;
  insert into auth.users values ('${ALICE}'), ('${BOB}');
`

/** Runs statements as a role, the way PostgREST does for a request. */
async function as<T = any>(user: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${user ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${user ?? ''}', true);`)
    return (await tx.query<T>(sql, params)).rows
  })
}
const push = async (user: string | null, path: string, baseRev: number, content: unknown, opts: { deleted?: boolean; keep?: boolean; device?: string } = {}): Promise<any> =>
  (await as(user, 'select public.push_doc($1, $2, $3::jsonb, $4, $5, $6) as r', [path, baseRev, content === null ? null : JSON.stringify(content), !!opts.deleted, !!opts.keep, opts.device ?? 'dev-a']))[0].r

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SUPABASE_STUB)
  const dir = join(import.meta.dirname, '../../supabase/migrations')
  for (const file of readdirSync(dir).sort()) await db.exec(readFileSync(join(dir, file), 'utf8'))
})

describe('Supabase schema', () => {
  it('can be applied twice (idempotent)', async () => {
    const dir = join(import.meta.dirname, '../../supabase/migrations')
    for (const file of readdirSync(dir).sort()) await db.exec(readFileSync(join(dir, file), 'utf8'))
  })

  it('writes with optimistic revisions and refuses a stale write with the current row', async () => {
    expect(await push(ALICE, PAGE, 0, { v: 1 })).toEqual({ ok: true, rev: 1 })
    expect(await push(ALICE, PAGE, 1, { v: 2 })).toEqual({ ok: true, rev: 2 })
    const stale = await push(ALICE, PAGE, 1, { v: 'stale' })
    expect(stale.ok).toBe(false)
    expect(stale.current).toMatchObject({ path: PAGE, rev: 2, deleted: false, content: { v: 2 } })
    // A first write to something that already exists is stale too.
    expect((await push(ALICE, PAGE, 0, { v: 'again' })).ok).toBe(false)
    expect((await as(ALICE, 'select content from docs where path = $1', [PAGE]))[0].content).toEqual({ v: 2 })
  })

  it('shows each user only their own rows', async () => {
    await push(BOB, 'library', 0, { owner: 'bob' })
    expect((await as(ALICE, 'select path from docs')).map((r) => r.path)).toEqual([PAGE])
    expect((await as(BOB, 'select path from docs')).map((r) => r.path)).toEqual(['library'])
    expect(await as(BOB, 'select * from doc_versions')).toEqual([])
    // The same path is a different document for another user.
    expect(await push(BOB, PAGE, 0, { owner: 'bob' })).toEqual({ ok: true, rev: 1 })
    expect((await as(ALICE, 'select content from docs where path = $1', [PAGE]))[0].content).toEqual({ v: 2 })
  })

  it('gives visitors nothing', async () => {
    await expect(as(null, 'select * from docs')).rejects.toThrow(/permission denied/)
    await expect(as(null, 'select * from doc_versions')).rejects.toThrow(/permission denied/)
    await expect(push(null, PAGE, 0, { v: 1 })).rejects.toThrow(/permission denied/)
  })

  it('allows no direct writes, even to one’s own rows', async () => {
    await expect(as(ALICE, `insert into docs (user_id, path, rev, seq) values ('${ALICE}', 'library', 1, 1)`)).rejects.toThrow(/permission denied/)
    await expect(as(ALICE, `update docs set content = '{}'`)).rejects.toThrow(/permission denied/)
    await expect(as(ALICE, 'delete from docs')).rejects.toThrow(/permission denied/)
    await expect(as(ALICE, 'delete from doc_versions')).rejects.toThrow(/permission denied/)
    await expect(as(ALICE, `insert into doc_versions (user_id, path, rev, content) values ('${ALICE}', 'library', 1, '{}')`)).rejects.toThrow(/permission denied/)
    await expect(as(ALICE, `select nextval('docs_seq')`)).rejects.toThrow(/permission denied/)
  })

  it('validates what is written', async () => {
    await expect(push(ALICE, '../etc/passwd', 0, {})).rejects.toThrow(/check constraint/)
    await expect(push(ALICE, 'library', 0, [1, 2])).rejects.toThrow(/JSON object/)
    await expect(push(ALICE, 'library', 0, null)).rejects.toThrow(/JSON object/)
    await expect(push(ALICE, 'library', -1, {})).rejects.toThrow(/Bad request/)
    await expect(push(ALICE, 'library', 0, { big: 'x'.repeat(9 * 1024 * 1024) })).rejects.toThrow(/too large/)
  })

  it('keeps replaced content: on request, from another device, and otherwise at most every ten minutes', async () => {
    const path = 'note/notebook-1/note-000001'
    await push(ALICE, path, 0, { v: 1 })
    await push(ALICE, path, 1, { v: 2 }) // first replacement: kept
    await push(ALICE, path, 2, { v: 3 }) // same device, within ten minutes: not kept
    await push(ALICE, path, 3, { v: 4 }, { keep: true }) // conflict: kept
    await push(ALICE, path, 4, { v: 5 }, { device: 'dev-b' }) // other device: kept
    const versions = await as(ALICE, 'select rev, content from doc_versions where path = $1 order by rev', [path])
    expect(versions.map((v) => v.content.v)).toEqual([1, 3, 4])
    for (let rev = 5; rev < 40; rev++) await push(ALICE, path, rev, { v: rev + 1 }, { keep: true })
    expect((await as(ALICE, 'select count(*)::int as n from doc_versions where path = $1', [path]))[0].n).toBe(20)
  })

  it('records a deletion as a tombstone that can be undone by a later write', async () => {
    const path = 'page/notebook-1/page-000002'
    await push(ALICE, path, 0, { v: 1 })
    expect(await push(ALICE, path, 1, null, { deleted: true })).toEqual({ ok: true, rev: 2 })
    expect((await as(ALICE, 'select deleted, content from docs where path = $1', [path]))[0]).toEqual({ deleted: true, content: null })
    expect(await push(ALICE, path, 2, { v: 3 })).toEqual({ ok: true, rev: 3 })
  })

  it('orders changes by seq for "what changed since"', async () => {
    const rows = await as(ALICE, 'select seq from docs order by seq')
    const seqs = rows.map((r) => Number(r.seq))
    expect(new Set(seqs).size).toBe(seqs.length)
    const before = Math.max(...seqs)
    await push(ALICE, 'library', 0, { v: 1 })
    expect((await as(ALICE, 'select path from docs where seq > $1', [before])).map((r) => r.path)).toEqual(['library'])
  })

  it('keeps files private to their owner, and immutable', async () => {
    const mine = `${ALICE}/notebook-1/abcdef123456.png`
    await as(ALICE, `insert into storage.objects (bucket_id, name) values ('assets', $1)`, [mine])
    expect((await as(ALICE, 'select name from storage.objects')).map((r) => r.name)).toEqual([mine])
    expect(await as(BOB, 'select name from storage.objects')).toEqual([])
    expect(await as(null, 'select name from storage.objects')).toEqual([])
    await expect(as(BOB, `insert into storage.objects (bucket_id, name) values ('assets', $1)`, [`${ALICE}/notebook-1/zzzzzz123456.png`])).rejects.toThrow(/row-level security/)
    await expect(as(ALICE, `insert into storage.objects (bucket_id, name) values ('assets', $1)`, [`${ALICE}/notebook-1/evil.html`])).rejects.toThrow(/row-level security/)
    await expect(as(null, `insert into storage.objects (bucket_id, name) values ('assets', $1)`, [mine + 'x'])).rejects.toThrow(/row-level security/)
    // No UPDATE/DELETE policy: these touch nothing.
    await as(ALICE, `update storage.objects set name = name || 'x'`)
    await as(ALICE, 'delete from storage.objects')
    await as(BOB, 'delete from storage.objects')
    expect((await as(ALICE, 'select name from storage.objects')).map((r) => r.name)).toEqual([mine])
    expect((await db.query<{ public: boolean }>(`select public from storage.buckets where id = 'assets'`)).rows[0]?.public).toBe(false)
  })
})
