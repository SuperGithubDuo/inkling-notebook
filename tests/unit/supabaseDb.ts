/**
 * The real migrations in a real Postgres (PGlite, in-process), queried as the roles
 * Supabase uses: a signed-in user (`authenticated`, identified by the JWT's `sub`) and
 * a visitor (`anon`). Supabase's own auth and storage schemas are stubbed with the
 * same shapes the migrations rely on. `db.query` directly is the service role.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

export const ALICE = '11111111-1111-4111-8111-111111111111'
export const BOB = '22222222-2222-4222-8222-222222222222'

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

export const MIGRATIONS = join(import.meta.dirname, '../../supabase/migrations')

export async function applyMigrations(db: PGlite): Promise<void> {
  for (const file of readdirSync(MIGRATIONS).sort()) await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
}

export async function startSupabaseDb(): Promise<{ db: PGlite; as: <T = any>(user: string | null, sql: string, params?: unknown[]) => Promise<T[]> }> {
  const db = new PGlite()
  await db.exec(SUPABASE_STUB)
  await applyMigrations(db)
  /** Runs statements as a role, the way PostgREST does for a request. */
  const as = async <T = any,>(user: string | null, sql: string, params: unknown[] = []): Promise<T[]> =>
    db.transaction(async (tx) => {
      await tx.exec(`set local role ${user ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${user ?? ''}', true);`)
      return (await tx.query<T>(sql, params)).rows
    })
  return { db, as }
}
