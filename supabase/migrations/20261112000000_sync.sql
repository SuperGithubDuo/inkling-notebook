-- Inkling sync: one row per document (the library, a page, a note) per user.
--
-- Security model
--   * Row-level security on everything; a user can only ever read their own rows.
--   * Clients cannot INSERT/UPDATE/DELETE directly. All writes go through push_doc(),
--     which takes the user from the session (auth.uid()), never from an argument, and
--     only writes if the caller's copy was based on the current revision. A stale
--     write is refused and gets the current row back to merge with.
--   * Replaced content is kept in doc_versions (recovery, conflicts).
--   * Files (images, PDFs) live in a private Storage bucket under <user id>/…; they can
--     be added and read by their owner, never overwritten or deleted by a client.

create sequence if not exists public.docs_seq;

create table if not exists public.docs (
  user_id uuid not null references auth.users (id) on delete cascade,
  path text not null check (path ~ '^(library|(page|note)/[A-Za-z0-9_-]{6,64}/[A-Za-z0-9_-]{6,64})$'),
  rev bigint not null,
  -- Order of writes within the database, for "what changed since".
  seq bigint not null,
  deleted boolean not null default false,
  content jsonb,
  device text,
  updated_at timestamptz not null default now(),
  primary key (user_id, path)
);
create index if not exists docs_user_seq on public.docs (user_id, seq);

create table if not exists public.doc_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  path text not null,
  rev bigint not null,
  content jsonb not null,
  device text,
  created_at timestamptz not null default now()
);
create index if not exists doc_versions_lookup on public.doc_versions (user_id, path, created_at desc);

alter table public.docs enable row level security;
alter table public.doc_versions enable row level security;

revoke all on public.docs, public.doc_versions from anon, authenticated;
revoke all on sequence public.docs_seq from anon, authenticated;
grant select on public.docs, public.doc_versions to authenticated;

drop policy if exists "read own docs" on public.docs;
create policy "read own docs" on public.docs for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "read own versions" on public.doc_versions;
create policy "read own versions" on public.doc_versions for select to authenticated using (user_id = (select auth.uid()));

-- Free-tier guards: one document is at most 8 MB, one account at most 20,000 documents,
-- and 20 kept versions per document.
create or replace function public.push_doc(
  p_path text,
  p_base_rev bigint,
  p_content jsonb,
  p_deleted boolean,
  p_keep_version boolean,
  p_device text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  cur public.docs%rowtype;
  existed boolean;
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_base_rev is null or p_base_rev < 0 or p_deleted is null then
    raise exception 'Bad request' using errcode = '22023';
  end if;
  if not p_deleted and (p_content is null or jsonb_typeof(p_content) <> 'object') then
    raise exception 'A document must be a JSON object' using errcode = '22023';
  end if;
  if pg_column_size(p_content) > 8 * 1024 * 1024 then
    raise exception 'This page is too large to sync (over 8 MB)' using errcode = '54000';
  end if;

  -- One writer per account at a time, so seq order is commit order for that account.
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));

  select * into cur from public.docs d where d.user_id = uid and d.path = p_path for update;
  existed := found;

  if coalesce(cur.rev, 0) <> p_base_rev then
    return jsonb_build_object(
      'ok', false,
      'current', case when existed then jsonb_build_object('path', cur.path, 'rev', cur.rev, 'seq', cur.seq, 'deleted', cur.deleted, 'content', cur.content) end
    );
  end if;

  if not existed and (select count(*) from public.docs d where d.user_id = uid) >= 20000 then
    raise exception 'This account has reached its limit of 20,000 pages' using errcode = '54000';
  end if;

  -- Keep what is being replaced: always when asked (a conflict) or when another device wrote it,
  -- otherwise at most one version every ten minutes.
  if existed and cur.content is not null and (
    coalesce(p_keep_version, false)
    or cur.device is distinct from p_device
    or not exists (
      select 1 from public.doc_versions v
      where v.user_id = uid and v.path = p_path and v.created_at > now() - interval '10 minutes'
    )
  ) then
    insert into public.doc_versions (user_id, path, rev, content, device) values (uid, p_path, cur.rev, cur.content, cur.device);
    delete from public.doc_versions v
    where v.id in (
      select o.id from public.doc_versions o
      where o.user_id = uid and o.path = p_path
      order by o.created_at desc, o.rev desc offset 20
    );
  end if;

  insert into public.docs as d (user_id, path, rev, seq, deleted, content, device, updated_at)
  values (uid, p_path, p_base_rev + 1, nextval('public.docs_seq'), p_deleted, case when p_deleted then null else p_content end, left(p_device, 80), now())
  on conflict (user_id, path) do update
    set rev = excluded.rev, seq = excluded.seq, deleted = excluded.deleted, content = excluded.content, device = excluded.device, updated_at = excluded.updated_at;

  return jsonb_build_object('ok', true, 'rev', p_base_rev + 1);
end;
$$;

revoke all on function public.push_doc(text, bigint, jsonb, boolean, boolean, text) from public, anon;
grant execute on function public.push_doc(text, bigint, jsonb, boolean, boolean, text) to authenticated;

-- Files. 50 MB is the Supabase free plan's per-file limit.
insert into storage.buckets (id, name, public, file_size_limit)
values ('assets', 'assets', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists "read own assets" on storage.objects;
create policy "read own assets" on storage.objects for select to authenticated
  using (bucket_id = 'assets' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "add own assets" on storage.objects;
create policy "add own assets" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'assets'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name ~ '^[0-9a-f-]{36}/[A-Za-z0-9_-]{6,64}/[A-Za-z0-9_-]{6,64}\.(png|jpg|jpeg|gif|webp|pdf)$'
  );
-- No UPDATE or DELETE policy on purpose: a stored file is never changed or removed by a client.
