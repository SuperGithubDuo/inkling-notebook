# Final AI preparation: operator configuration

The migration remains separate from `main`. Do not run a production workflow until the operator explicitly approves deployment. No production deployment or inference is needed to complete the settings below.

## Approval settings

Configured and read back via GitHub API:

- `production-ai`: required reviewer `SuperGithubDuo` (actual authenticated repository owner, user ID 143859772), self-review allowed, administrator bypass disabled.
- Deployment policy: **only branch `main`**, not a tag named main, protected-branch wildcard, feature branch or migration branch.
- `ai-test`: selected branch rules `main`, `deploy/ai-server-next`, `deploy/ai-preflight`, `deploy/workers-ai-bench`, `ops/cloudflare`. `main` permits existing manual test runs after merge; arbitrary migration/feature refs are not allowed.

## GitHub API permissions

The environment gate reads:

| Endpoint | Minimum fine-grained repository permission |
| --- | --- |
| `GET /repos/{owner}/{repo}/environments/production-ai` (includes reviewers) | Actions: read |
| `GET /repos/{owner}/{repo}/environments/production-ai/deployment-branch-policies` | Actions: read |
| `GET /repos/{owner}/{repo}` (default branch) | Metadata: read (implicit for `GITHUB_TOKEN`) |

`contents: read` permits checkout. `deployments: read` is not needed by these endpoints and was removed. Missing/inaccessible or incomplete responses fail the switch gate. `--report` remains informational only; no deploy job uses it as its approval gate. The secret-free `ai-readiness.yml` exercises these endpoints with the real Actions token, without approval, deployment or inference.

Sources: [environment](https://docs.github.com/en/rest/deployments/environments#get-an-environment), [branch policies](https://docs.github.com/en/rest/deployments/branch-policies#list-deployment-branch-policies), [repository metadata](https://docs.github.com/en/rest/repos/repos#get-a-repository).

## Secrets: manual work still required

No secret values were printed, committed, copied, rotated, deleted or moved. GitHub lists names, not retrievable secret values. Both environment secret lists were empty at inspection. Existing repository secret names are `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `INKLING_ADMIN_TOKEN`, `DEEPINFRA_DEV_API_KEY`, `OPENROUTER_API_KEY`. **`DEEPINFRA_API_KEY` is absent**.

Enter the separate production DeepInfra key directly at:

**Repository → Settings → Environments → production-ai → Environment secrets → Add secret → `DEEPINFRA_API_KEY`**.

Do not paste it in chat, use the dev key, add funds or enable automatic top-up as part of preparation. Provider credit and budget controls must be confirmed by the operator before an approved switch. Obtain the written DeepInfra product-use confirmation already called out in AI-PROVIDERS.md if not done.

### Audited consumers

| Workflow | Credentials consumed | Environment |
| --- | --- | --- |
| ai-provider-switch | Cloudflare pair, admin, production DeepInfra key | production-ai |
| beta-server | Cloudflare pair, admin | production-ai |
| ai-routing-smoke | Cloudflare pair, admin | production-ai |
| ai-preflight | Cloudflare pair; privacy job also admin + dev DeepInfra | ai-test |
| ai-server-next | Cloudflare pair, admin, dev DeepInfra | ai-test |
| workers-ai-bench | Cloudflare pair | ai-test |
| cloudflare-diagnostics | Cloudflare pair | ai-test |
| beta-server-ops | admin | none, intentional immediate emergency access |

No workflow consumer of `OPENROUTER_API_KEY` was found. CI/Pages/Release do not consume these credentials (Release can still call the public inference endpoint).

### Safe isolation sequence (do not remove repository secrets yet)

1. Create separately scoped Cloudflare tokens in Cloudflare, not copies of the same broad token. Current [Cloudflare permissions](https://developers.cloudflare.com/workers/authorization/workers/) support account-owned tokens limited to **Specified Workers**. Use Editor for production `inkling-ai-beta`, Editor for existing test Workers, and per-Worker Admin only for temporary Workers that tests delete. Bindings inherit the implementing Worker's permissions. Do not give the test token production write permission.
2. The read-only preflight needs production settings read access: give that token only Metadata Read-Only for production, or split the preflight to use a separate read-only credential. Test Workers on the same account still share Workers AI free usage; token scoping is not an inference-budget boundary. A separate test account avoids that sharing but is an operator decision, not something this preparation provisions.
3. Creating arbitrary temporary Workers requires product-level Admin. For isolation, pre-provision the known temporary Worker names and scope to them, or use an existing separate test account. Do not grant account-wide write just to get a dry run green.
4. Add `CLOUDFLARE_ACCOUNT_ID` and the correctly scoped `CLOUDFLARE_API_TOKEN` at each environment, and `DEEPINFRA_DEV_API_KEY` at `ai-test`. Use an independent test admin token (`INKLING_ADMIN_TOKEN` at `ai-test`) and update only the test Worker's runtime secret in a separately approved test operation. Environment entries override repository entries.
5. Keep repository `INKLING_ADMIN_TOKEN` until emergency workflow access is deliberately redesigned. Moving it straight to main-only `production-ai` would break push-based emergency access and add an approval delay; do not do that silently. A separate restricted operations environment is possible but requires an explicit operational choice and workflow update.
6. Validate every consumer with its environment-specific credentials. **Only after validation and operator authorization**, remove/revoke the old broadly privileged repository deployment credentials. Adding environment copies alone does not close the historical-workflow bypass. Old commits can still access repository secrets today. Current `main` still has push-based production deploy workflows until this migration is merged.

Therefore production/test secrets are **not fully isolated yet**. Existing Cloudflare token scope cannot be determined from GitHub secret metadata; do not assume it is narrow.

## Verification boundaries

- Local tests exercise failure/cancellation conditions and recovery shell using fakes; they do not redeploy production or prove recovery after runner loss. Cancellation cleanup is best effort on the same runner/job. An approved manual `workers-ai` switch remains the independent operator recovery path; every recovery must be read back.
- Production health/status was read without a tutor request: the existing Workers AI model and 900-Neuron installation allowance remain served. The earlier successful preflight run `42387049596` recorded `provider=workers-ai` from Cloudflare, all four synthetic test requests answered, and both summaries clean. That is historical live evidence, not a newly rerun paid test.
- The previous full live comparison run `42383423242` concluded failure (3 quality tests failed, 16 passed); this task does not rerun or relabel it as success. The operator must assess the existing report before launch. Provider integration works; quality approval is a separate acceptance decision.
- The full comparison workflow still assumes an initially empty persistent test ledger in one bridge check and shares the account's free allowance. Do not rerun it casually; compare counter deltas and reserve test budget before another benchmark. No benchmark was requested or rerun here.
- Existing dependency audit reports six moderate desktop packaging-chain findings; beta-server dependencies report zero. No dependency upgrades or force-fixes are bundled into deployment preparation. Build emits existing chunk-size/dynamic-import warnings.
