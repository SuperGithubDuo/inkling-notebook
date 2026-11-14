-- Inkling Free/Pro entitlements: one row per account that has (or had) a paid plan.
--
-- Security model
--   * Row-level security; a signed-in user can read only their own row.
--   * No client can INSERT/UPDATE/DELETE: only the service role (the future billing webhook,
--     server-side only) writes here. Visitors (anon) get nothing.
--   * No row means Free. The effective plan is computed here, in one place
--     (my_entitlement()), so a stale or half-written row can only ever read as Free.
--   * Nothing here touches notebooks: docs, doc_versions, push_doc() and Storage never
--     consult this table, so an expired or missing subscription can't lock anyone out.

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  -- Mirrors the billing provider's subscription status.
  status text not null default 'none' check (status in ('none', 'active', 'trialing', 'past_due', 'canceled', 'expired')),
  -- Pro applies until this moment (end of the paid period plus any grace the webhook grants). Null: not at all.
  pro_until timestamptz,
  source text check (source in ('stripe', 'manual')),
  external_customer_id text,
  external_subscription_id text unique,
  updated_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

revoke all on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;

drop policy if exists "read own subscription" on public.subscriptions;
create policy "read own subscription" on public.subscriptions for select to authenticated using (user_id = (select auth.uid()));
-- No INSERT/UPDATE/DELETE policy and no grant on purpose: clients can't change their plan.

-- The caller's effective entitlement (null when not signed in). Security invoker: RLS above
-- decides what it can read, so it can never return another account's plan.
-- Version 1 of the contract in src/shared/entitlements.ts.
create or replace function public.my_entitlement() returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'version', 1,
    'user_id', u.uid,
    'plan', case when s.plan = 'pro' and s.status in ('active', 'trialing', 'past_due') and s.pro_until > now() then 'pro' else 'free' end,
    'status', coalesce(s.status, 'none'),
    'pro_until', s.pro_until,
    'checked_at', now()
  )
  from (select auth.uid() as uid) u
  left join public.subscriptions s on s.user_id = u.uid
  where u.uid is not null
$$;

revoke all on function public.my_entitlement() from public, anon;
grant execute on function public.my_entitlement() to authenticated;
