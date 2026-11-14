# Account-based AI: rollout runbook

Status as of 14 Nov 2026: steps 1 and 2 are done (by the operator); steps 3–5 are not started. Every remaining step needs the operator's approval.

## Where production is

| Piece | State | Evidence |
|---|---|---|
| Web app (GitHub Pages) | **Live with #23**: signed-in browsers send `Authorization: Bearer <access token>` | "Website and web app" run 43614526024 deployed `8be522c` at 16:15 UTC; Supabase is configured in that build |
| AI Worker `inkling-ai-beta` | **Updated** (step 1): current code on DeepInfra; the CORS preflight allows `authorization`. Signed-in Inkling Web AI Tutor tested against the live DeepInfra backend. No `SUPABASE_*` settings, so account verification is off: tokens are accepted by the browser check but ignored, and everyone gets the per-computer allowance | Operator, 14 Nov 2026 |
| Supabase migration `20261114000000_entitlements.sql` | **Applied** by hand (SQL editor), verified by the operator; migration history to reconcile (step 2) | Operator, 14 Nov 2026 |
| Desktop app | No release since #23; sends no token | `release.yml` not run |

**Resolved: signed-in web requests blocked by CORS.** The Worker that ran until step 1 (`fa46e27`, before #22) didn't allow the `Authorization` header that #23's web app sends when signed in, so browsers blocked those requests. Step 1 fixed it; anonymous web users, desktop users, notebooks and sync were never affected.

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

Run each step only after the previous one checks out. Steps 4 and 5 are production Worker deploys. Do them with *Actions → AI server - switch provider (production) → target `deepinfra`*: it checks the configuration, deploys, verifies, and rolls back to `wrangler.jsonc` by itself if verification fails. Step 3 deploys only the separate staging Worker.

### 1. Fix the live CORS problem: **done** (operator, 14 Nov 2026)
The updated Worker was deployed to production with no setting changes, and a signed-in Inkling Web AI Tutor question was answered by the live DeepInfra backend. Nothing to repeat.

### 2. Apply the Supabase migration: **done** (operator, 14 Nov 2026)
Applied by hand in the SQL editor. The operator checked: the table and function exist, RLS is on, signed-in users can't write, visitors can't read or call, and `my_entitlement()` is security invoker.

**Reconcile the migration history.** What is known:

| | Local file (`supabase/migrations/`) | Remote history (`supabase_migrations.schema_migrations`) | Database |
|---|---|---|---|
| Sync schema | `20261112000000_sync.sql` | `20261113000414 inkling_sync` | applied (the app syncs) |
| Entitlements | `20261114000000_entitlements.sql` | not recorded (SQL editor) | applied and verified |

So the two disagree twice: the sync schema is recorded under a different version than the local file, and the entitlements schema isn't recorded at all. Until they agree, **don't run `supabase db push`**. It would try to apply both local files, and the CLI may refuse because remote version `20261113000414` has no local file. (Both files are idempotent, so a re-run wouldn't damage data, but the history would still be wrong.)

**Entitlements** (verified, so it can be recorded). After `supabase link --project-ref tfsnxihtmsdufjiyfkmv`, which asks for the database password:
```bash
supabase migration list --linked     # read-only: expect 20261114000000 under Local only
supabase migration repair --status applied 20261114000000 --linked   # writes one history row; runs no SQL from the file
```
Before the repair, confirm that the file you pasted is the repo's: `sha256sum supabase/migrations/20261114000000_entitlements.sql`.

**Sync schema: don't mark anything applied yet.** First check what `20261113000414` actually contains. This is read-only, in the SQL editor:
```sql
select version, name, array_length(statements, 1) as statements from supabase_migrations.schema_migrations order by version;
select statements from supabase_migrations.schema_migrations where version = '20261113000414';
```
Compare it with `supabase/migrations/20261112000000_sync.sql`.
- **If it is the same schema:** the cleanest fix is a separate PR that renames the local file to `20261113000414_inkling_sync.sql`, so local and remote agree without touching the database. The file order stays the same: sync before entitlements.
- **If it differs:** stop and review the differences before any repair or push. Never run `migration repair --status applied 20261112000000` without that check.

From now on, apply migrations with `supabase db push --linked` (which records them) once `supabase migration list --linked` shows local and remote in agreement, not with the SQL editor.

### 3. Staging check of account verification
A temporary Worker, `inkling-ai-accounts-test`, defined in `beta-server/wrangler.accounts-staging.jsonc`. It runs the same code as `main`, against production Supabase with its public values only.

**Why it can't touch production** (`tests/unit/stagingConfig.test.ts` checks the file):

| Risk | Why it can't happen |
|---|---|
| Production deploys, vars or secrets | Its own script name. Every command below passes `-c wrangler.accounts-staging.jsonc`, so none can fall back to `inkling-ai-beta`. Never run a `wrangler` command in `beta-server/` without `-c` during this check: the default file is production. |
| Production ledger, quotas, pause | Its Durable Object binding has no `script_name`, so it gets its own namespace and storage. Production's ledger (`ledger`, `ledger-workers-ai-bridge`) can't be reached. |
| Spending | Workers AI only (no `INFERENCE_PROVIDER`, no DeepInfra key), `ACCOUNT_PLAN: "free"`. The Workers Free plan refuses rather than bills. |
| The account's shared free Neurons (production's bridge for older apps uses them) | `GLOBAL_DAILY_NEURONS: "400"`: at most 4% of the daily 10,000. |
| Browsers, routes | `WEB_ORIGINS: ""`, no routes: only reachable at its own workers.dev address. |
| Subscriptions | It can only read, with the user's own token under RLS. The Pro row in test 5 is written by you in the SQL editor, after approval. |
| Notebooks | It never touches `docs`, `doc_versions` or Storage. |

**From GitHub Actions (no Cloudflare access needed on your computer):** *Actions → AI accounts staging (inkling-ai-accounts-test)* (`.github/workflows/ai-accounts-staging.yml`). It replaces the Before, Deploy and After steps below; the tests below are unchanged.
- **`check`** (read-only): the config guard, the Workers Free check, production's deployments and secret names, and the staging Worker's summary if it exists.
- **`deploy`**: needs `confirm` = `deploy inkling-ai-accounts-test`. It deploys the committed staging config, sets the staging `ADMIN_TOKEN`, then checks that the Worker reports accounts `"on"`, a 400-Neuron cap, an anonymous 200 and a bad-token 401.
- **`delete`**: needs `confirm` = `delete inkling-ai-accounts-test`.

Every action records production (`inkling-ai-beta`) before and after, and fails with "PRODUCTION CHANGED" if its deployments or secret names differ. It runs only from `main`, in the `ai-test` environment.

Setup:
1. Create a new secret `INKLING_STAGING_ADMIN_TOKEN` (`openssl rand -base64 36`) in the `ai-test` environment or the repository. It must not be the production token; the workflow refuses the production value.
2. Make sure `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are visible to the `ai-test` environment. The run stops if they aren't.
3. Keep the same 32+ character value locally, for the tests' `summary` helper (`A=...`).

**Risk:** `CLOUDFLARE_API_TOKEN` is account-wide (*Workers Scripts: Edit* can't be limited to one Worker), so this workflow could change production if its code were wrong. The guards and `tests/unit/stagingWorkflow.test.ts` keep every write pointed at the staging name, and the before/after comparison would show a change. Full isolation would need a separate Cloudflare account on Workers Free with its own token.

**Before** (when running from your computer instead). Confirm the Cloudflare account is still on Workers **Free**. Then record production's state (all read-only):
```bash
cd beta-server
npx wrangler deployments list --name inkling-ai-beta > /tmp/prod-deployments-before.txt
npx wrangler secret list --name inkling-ai-beta > /tmp/prod-secrets-before.txt
curl -s https://inkling-ai-beta.shenjonas9.workers.dev/admin/summary -H "Authorization: Bearer $INKLING_ADMIN_TOKEN" | jq '{paused, accounts, globalUsed, globalLimit}'
```

**Deploy** (with approval):
```bash
npx wrangler deploy -c wrangler.accounts-staging.jsonc   # prints https://inkling-ai-accounts-test.<subdomain>.workers.dev
openssl rand -base64 36 | tr -d '\n' > /tmp/staging-admin
npx wrangler secret put ADMIN_TOKEN -c wrangler.accounts-staging.jsonc < /tmp/staging-admin
```

**Setup.** Use a dedicated test account. Sign in to the web app with it, accept the AI notice, and in the browser console run `JSON.parse(localStorage['sb-tfsnxihtmsdufjiyfkmv-auth-token'])`: copy `access_token` (valid for 1 hour) and `user.id`. Then:
```bash
S=https://inkling-ai-accounts-test.<subdomain>.workers.dev
A=$(cat /tmp/staging-admin); T='<access_token>'; UID='<user.id>'
newid() { echo "inst_$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')"; }
I1=$(newid); I2=$(newid)
st()  { curl -s -w '\nHTTP %{http_code}\n' "$S/v1/status" -H "x-inkling-install: $1" -H 'x-inkling-notice: 5' ${2:+-H "authorization: Bearer $2"}; }
ask() { curl -sN "$S/v1/tutor" -H 'content-type: application/json' -H "x-inkling-install: $1" -H 'x-inkling-notice: 5' ${2:+-H "authorization: Bearer $2"} \
          -d '{"task":"chat","turns":[{"role":"user","parts":[{"text":"Reply with exactly: OK"}]}]}' | grep -o 'event: done\|"scope":"[a-z_]*"' | head -1; }
summary() { curl -s "$S/admin/summary" -H "Authorization: Bearer $A" | jq '{accounts, globalUsed, globalLimit, answering, overshoot}'; }
```
Run `summary` first: it must show `accounts: "on"`. If it shows `"misconfigured"` or `"off"`, stop.

A short answer costs about 15–25 Neurons. Before each answer the server reserves room for about 116: Free (150) allows about 2 short answers a day, Pro (300) about 9, and the staging cap (400) about 13 in total.

**1. Anonymous requests**
| Command | Expect |
|---|---|
| `st $I1` | `HTTP 200`, `quota.installLimit: 150`, no `plan` |
| `ask $I1` | `event: done` |
| `st $I1` | `installUsed` > 0, still no `plan` |

**2. Valid Free account**
| Command | Expect |
|---|---|
| `st $I1 $T` | `HTTP 200`, `quota.plan: "free"`, `installLimit: 150`, `installUsed: 0` (separate from the anonymous use on `$I1`) |
| `ask $I1 $T` | `event: done` |
| `st $I1 $T` | `installUsed` > 0 |

**3. Invalid or expired tokens** (nothing is reserved, and the model is never called)
| Command | Expect |
|---|---|
| `st $I1 a.b.c` | `HTTP 401`, `"scope":"account"` (refused without contacting Supabase) |
| `st $I1 "${T%.*}.AAAA"` (signature changed) | `HTTP 401` (refused by Supabase) |
| `curl -s -w '%{http_code}' "$S/v1/status" -H "x-inkling-install: $I1" -H 'authorization: Basic eDp5'` | `401` |
| `ask $I1 a.b.c` | `"scope":"account"` |
| Last of all, after test 6: run `st $I1 $T` with the same `T` more than 60 minutes after copying it | `HTTP 401` (expired) |
| `summary` | `globalUsed` unchanged by these requests |

**4. Cross-device usage** (one account, two installations)
| Command | Expect |
|---|---|
| `st $I2 $T` | the same `installUsed` as `st $I1 $T` (one counter per account) |
| `ask $I2 $T`, then `st $I1 $T` | `installUsed` grew, seen from the other device |
| `ask $I1 $T` (repeat until refused, at most 3 times) | `"scope":"install_quota"`; the message says "on your account" |
| `ask $I2 $T` | also `install_quota` (the account is used up on every device) |
| `ask $(newid)` | `event: done`: anonymous use on another installation is unaffected |

**5. Temporary Pro entitlement** (needs your approval: one row for the test account only)
1. In the SQL editor:
   `insert into public.subscriptions (user_id, plan, status, pro_until, source) values ('<UID>', 'pro', 'active', now() + interval '2 hours', 'manual');`
2. Wait 65 s (the server keeps a verified result for up to a minute).
3. Check:

| Command | Expect |
|---|---|
| `st $I1 $T` | `plan: "pro"`, `installLimit: 300`, `installUsed` the same as at the end of test 4 (switching plans resets nothing) |
| `ask $I1 $T` | `event: done` (room again, up to Pro's 300) |
| `ask $I1 $T & ask $I2 $T; wait` | one `event: done` and one `"scope":"busy"` (one answer at a time per account, across devices) |

4. Expire it:
   `update public.subscriptions set pro_until = now() - interval '1 minute' where user_id = '<UID>';`
   Wait 65 s, then:

| Command | Expect |
|---|---|
| `st $I1 $T` | `plan: "free"`, `installLimit: 150` |
| `ask $I1 $T` | `"scope":"install_quota"` (back to Free, with the day's use kept) |

5. Remove the row:
   `delete from public.subscriptions where user_id = '<UID>';`
   Then `select count(*) from public.subscriptions where user_id = '<UID>';` must return 0.

**6. Global spending limit** (the staging cap, 400 Neurons)
```bash
for n in $(seq 1 25); do r=$(ask "$(newid)"); echo "$n $r"; [ "$r" = '"scope":"global_quota"' ] && break; done
summary
ask "$(newid)" "$T"
```
| Expect |
|---|
| `event: done` for the first few (fewer the more tests 1–5 used), then `"scope":"global_quota"` |
| `summary`: `globalUsed` ≤ 400, `overshoot.count: 0`, `answering: 0` |
| The signed-in request is also `global_quota`: accounts never bypass the cap (if `T` is over an hour old by now, copy a fresh one first, or the answer is `401`) |

**After: check production is unchanged, then delete the staging Worker**
```bash
npx wrangler deployments list --name inkling-ai-beta | diff /tmp/prod-deployments-before.txt - && echo "production deployments unchanged"
npx wrangler secret list --name inkling-ai-beta | diff /tmp/prod-secrets-before.txt - && echo "production secrets unchanged"
npx wrangler delete -c wrangler.accounts-staging.jsonc   # the prompt must name inkling-ai-accounts-test
rm /tmp/staging-admin
```
Stop and report if a production diff isn't empty, if any step shows `plan: "pro"` without the row, or if `accounts` isn't `"on"`.

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

Live checks: step 3 above (tests 1–6), and in production after step 4: tests 1–3 against `inkling-ai-beta` (they spend nothing but one short answer).

## Rollback

| Problem | Action | Effect on users |
|---|---|---|
| Account verification misbehaves (step 4) | Remove the two `SUPABASE_*` vars and redeploy (switch-provider, `deepinfra`), or run the workflow with target `workers-ai` | Tokens ignored; everyone gets the per-computer allowance; nothing else changes |
| The Worker misbehaves at all | *Actions → AI server emergency switch → pause* (stops answers), then switch-provider `workers-ai` | AI paused or on Workers AI; notebooks, sync and export are unaffected |
| The migration | Leave it: it adds a table and a function that nothing else reads. To remove it: `drop function public.my_entitlement(); drop table public.subscriptions;` (only while accounts are off) | None |
| Web app | Re-run an earlier "Website and web app" run on `001d1f8` | Web back to notice 4; no tokens |

Never delete `docs`, `doc_versions` or Storage objects as part of any rollback. Notebooks don't depend on any of this.
