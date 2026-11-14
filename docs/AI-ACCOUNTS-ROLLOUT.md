# Account-based AI: rollout runbook

Status as of 14 Nov 2026. Nothing here has been run against production yet. Every step needs the operator's approval.

## Where production is

| Piece | State | Evidence |
|---|---|---|
| Web app (GitHub Pages) | **Live with #23**: signed-in browsers send `Authorization: Bearer <access token>` | "Website and web app" run 43614526024 deployed `8be522c` at 16:15 UTC; Supabase is configured in that build |
| AI Worker `inkling-ai-beta` | **Pre-#22 code** (`fa46e27`, "switch provider" run 43535497011): no account verification, and its CORS preflight allows only `content-type, x-inkling-install, x-inkling-notice` | Last production deploy; `beta-server.yml` hasn't deployed since 4 Nov |
| Supabase migration `20261114000000_entitlements.sql` | **Unknown**: no workflow applies migrations, and this sandbox can't reach Supabase | Check it with step 2 |
| Desktop app | No release since #23; sends no token | `release.yml` not run |

**Live problem.** In a browser, a signed-in user who accepts notice 5 sends an `Authorization` header. The old Worker's preflight doesn't allow that header, so the browser blocks the request and the tutor says it "couldn't reach Inkling's AI server". Anonymous web users, desktop users, notebooks and sync are not affected. Step 1 fixes it.

## Budget today (`wrangler.deepinfra.jsonc`)

DeepInfra Qwen 3.8 27B at list price ($0.20 per million input tokens, $2.50 per million output). Hard caps: **$0.25 per rolling 24 hours, $5 per UTC month**, with monthly pacing ×1.5. Per installation: $0.01 a day and $0.15 a month. Per network: $0.05 a day. Concurrency is 1 per installation, 4 per network and 8 overall. Rate limits are 6 a minute per installation and 20 per network. Every request reserves its worst case before the model is called. Older apps (notice < 4) go to the Workers AI bridge on the Free plan, which can't bill.

Measured cost per answer (`beta-server/scripts/cost-model.mjs`, DeepInfra list price): $0.00059 measured mix, **$0.00078 app-size**, $0.0015 long conversation.

## Recommended limits

| | Daily | Monthly | ≈ answers per day / month (app-size) | Worst case (long conversations) |
|---|---|---|---|---|
| Anonymous (unchanged) | $0.01 | $0.15 | 13 / 190 | 7 / 100 |
| **Free account** = anonymous (no new setting) | $0.01 | $0.15 | 13 / 190 | 7 / 100 |
| **Pro**: `PRO_DAILY_USD=0.10`, `PRO_MONTHLY_USD=1.00` | $0.10 | $1.00 | 128 / 1,280 | 66 / 666 |

Why these amounts:
- **Free accounts stay at the anonymous level.** Free accounts cost nothing to create (an email code), so giving them more would only invite more sign-ups to farm.
- **Pro's AI cost is at most $1.00 a month.** $4.99 minus Stripe's 2.9% + $0.30 is about $4.55 net. A Pro user at full use therefore still leaves about $3.55 (≈ 71%) before tax and other costs. The daily $0.10 stops one heavy day from using the month's allowance.

**Raise the global caps together with Pro, never before Pro has subscribers.**
- `GLOBAL_MONTHLY_USD = 5 + 1.00 × paying subscribers` (rounded up at each review).
- `GLOBAL_DAILY_USD ≥ GLOBAL_MONTHLY_USD / 20`.

With today's $0.25 a day, two heavy Pro users would use most of everyone's day. Keep `PRO_*` unset until Stripe is live: unset, Pro gets exactly the Free allowance.

**Shared networks (fixed in this branch).** A verified Pro account with `PRO_*` configured has its own network pool (`ownNetwork`, `beta-server/src/ledger.ts`). A school's shared $0.05 a day no longer blocks it, and its use doesn't take from that pool. It is still bounded by its own daily and monthly caps, one answer at a time per account, its own per-minute limit, and the global caps. Free accounts stay in the shared pool, because free accounts are free to make. While `PRO_*` is unset, nothing changes.

## Deployment sequence

Run each step only after the previous one checks out. Steps 1, 3 and 5 are Worker deploys. Do them with *Actions → AI server - switch provider (production) → target `deepinfra`*: it checks the configuration, deploys, verifies, and rolls back to `wrangler.jsonc` by itself if verification fails.

### 1. Fix the live CORS problem (no behaviour change)
1. Merge this PR.
2. Run the switch-provider workflow on `main`, target `deepinfra`. Change no settings: Supabase settings stay unset, so accounts stay off.
3. Check:
```bash
curl -si -X OPTIONS https://inkling-ai-beta.shenjonas9.workers.dev/v1/tutor -H 'origin: https://supergithubduo.github.io' -H 'access-control-request-method: POST' | grep -i access-control-allow-headers
```
   The answer must include `authorization`.
```bash
curl -s https://inkling-ai-beta.shenjonas9.workers.dev/admin/summary -H "Authorization: Bearer $INKLING_ADMIN_TOKEN" | jq '{accounts, globalUsed, globalLimit, monthUsed, monthLimit}'
```
   `accounts` must be `"off"`, and the limits must be unchanged.
4. In the web app, signed in: ask one question. It should be answered, with the allowance shown per computer and no plan badge.

### 2. Apply the Supabase migration (schema only; no existing table or row changes)
1. In the Supabase dashboard, open *SQL editor*, paste `supabase/migrations/20261114000000_entitlements.sql` and run it. It is idempotent: running it twice is harmless.
2. Check, in the SQL editor:
```sql
select to_regclass('public.subscriptions') as tbl, to_regprocedure('public.my_entitlement()') as fn,
  (select relrowsecurity from pg_class where oid = 'public.subscriptions'::regclass) as rls,
  has_table_privilege('authenticated', 'public.subscriptions', 'insert') as client_insert,
  has_table_privilege('anon', 'public.subscriptions', 'select') as anon_select,
  has_function_privilege('anon', 'public.my_entitlement()', 'execute') as anon_exec,
  has_function_privilege('authenticated', 'public.my_entitlement()', 'execute') as auth_exec;
```
   Expect: `tbl` and `fn` present, `rls = true`, `client_insert = false`, `anon_select = false`, `anon_exec = false`, `auth_exec = true`.
3. Check that visitors (anon) are refused, from a terminal:
```bash
curl -s -X POST https://tfsnxihtmsdufjiyfkmv.supabase.co/rest/v1/rpc/my_entitlement -H 'apikey: sb_publishable_UL1qBPOQnEYay-5u4ZE5Pw_IzBaZIDz' -H 'content-type: application/json' -d '{}'
```
   This must be a permission error, not `PGRST202` (function not found).

### 3. Staging check of account verification (Workers AI Free, costs nothing)
```bash
cd beta-server
npx wrangler deploy -c wrangler.jsonc --name inkling-ai-accounts-test \
  --var SUPABASE_URL:https://tfsnxihtmsdufjiyfkmv.supabase.co --var SUPABASE_ANON_KEY:sb_publishable_UL1qBPOQnEYay-5u4ZE5Pw_IzBaZIDz
```
Take a test account's access token from the signed-in web app's console: `JSON.parse(localStorage['sb-tfsnxihtmsdufjiyfkmv-auth-token']).access_token`. Set `T` to that token, `S` to the test Worker's URL, and `I` to any `inst_` + 32 letters. Then run the checks in [Tests](#tests) items 1–6, and delete the test Worker:
```bash
npx wrangler delete --name inkling-ai-accounts-test
```

### 4. Turn account verification on in production
1. Add these to `vars` in `wrangler.deepinfra.jsonc` (public values; never the service-role key):
```jsonc
"SUPABASE_URL": "https://tfsnxihtmsdufjiyfkmv.supabase.co",
"SUPABASE_ANON_KEY": "sb_publishable_UL1qBPOQnEYay-5u4ZE5Pw_IzBaZIDz",
```
   Leave `wrangler.jsonc` (the rollback) without them, so a rollback means accounts off, which is safe.
2. Merge, then run the switch-provider workflow (`deepinfra`).
3. Check: `/admin/summary` shows `accounts: "on"`. Signed in on the web, AI settings show **Free plan** and an allowance "on your account". The curl for item 1 in [Tests](#tests) gives 401.

### 5. Pro limits: only with Stripe, not now
Set `PRO_DAILY_USD=0.10` and `PRO_MONTHLY_USD=1.00`, and raise the global caps by the formula above, in the same deploy that opens checkout.

## Tests

Automated (CI, `npx vitest run`):
- `tests/unit/entitlements.test.ts`: RLS and privileges, fake Pro, unauthorized requests, simultaneous requests, exhaustion, expiry, Free↔Pro switching, global and monthly caps, Pro's own network pool.
- `tests/unit/accountAi.test.ts`, `accountSignOut.test.ts`, and the `web.e2e` other-tab sign-out step.

Live checks for step 3 (staging) and step 4 (production). Set `S`, `T` and `I` as in step 3, and expect the results shown:

| # | Check | Command | Expect |
|---|---|---|---|
| 1 | Bad token is refused | `curl -s $S/v1/status -H "x-inkling-install: $I" -H 'authorization: Bearer a.b.c'` | 401, `scope: account` |
| 2 | Real token: Free | same with `Bearer $T` | 200, `quota.plan: "free"`, `installLimit` = the installation allowance |
| 3 | Cross-device | repeat item 2 with a different `$I` after one answer | same `installUsed` (one account counter) |
| 4 | Expired token | a token older than 1 hour | 401 |
| 5 | Pro, then expiry (test user only, SQL editor, after approval) | `insert into public.subscriptions (user_id, plan, status, pro_until) values ('<test uid>', 'pro', 'active', now() + interval '1 day');` → item 2 shows `plan: "pro"` within 60 s; then `update public.subscriptions set pro_until = now() - interval '1 minute' where user_id = '<test uid>';` → `plan: "free"` within 60 s; then `delete from public.subscriptions where user_id = '<test uid>';` | as described |
| 6 | Abuse | `for i in $(seq 1 12); do curl -s -o /dev/null -w '%{http_code} ' -H "x-inkling-install: $I" -H "authorization: Bearer $T" $S/v1/status; done`, then 2 simultaneous `/v1/tutor` requests with `$T` | status checks never call the model; the second answer is refused as `busy` (one at a time per account) |

## Rollback

| Problem | Action | Effect on users |
|---|---|---|
| Account verification misbehaves (step 4) | Remove the two `SUPABASE_*` vars and redeploy (switch-provider, `deepinfra`), or run the workflow with target `workers-ai` | Tokens ignored; everyone gets the per-computer allowance; nothing else changes |
| The Worker misbehaves at all | *Actions → AI server emergency switch → pause* (stops answers), then switch-provider `workers-ai` | AI paused or on Workers AI; notebooks, sync and export are unaffected |
| The migration | Leave it: it adds a table and a function that nothing else reads. To remove it: `drop function public.my_entitlement(); drop table public.subscriptions;` (only while accounts are off) | None |
| Web app | Re-run an earlier "Website and web app" run on `001d1f8` | Web back to notice 4; no tokens |

Never delete `docs`, `doc_versions` or Storage objects as part of any rollback. Notebooks don't depend on any of this.
