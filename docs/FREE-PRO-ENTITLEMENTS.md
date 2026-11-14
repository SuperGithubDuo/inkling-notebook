# Free and Pro entitlements

Status: design proposal; not active in production.

Parent roadmap: GitHub issue #19. First implementation work: issue #20.

## Product invariants

1. A student's notebooks are never a subscription feature. Creating, opening, editing, searching, importing/exporting PDFs, offline use, backup/restore, and existing account sync remain available on Free.
2. A missing, expired, malformed, or unavailable entitlement must never block core notebook access.
3. Pro is an account entitlement, not a client-side setting or device-local flag.
4. AI is never unlimited. Every request remains subject to per-account plan limits and hard global, network, concurrency, and dollar-spend limits.
5. Do not activate checkout or collect payment until webhook, entitlement, quota, cancellation, refund, and recovery paths are verified.

## Current architecture to preserve

- Web and desktop share the renderer and `src/shared/sync/engine.ts`; web auth/sync uses Supabase and IndexedDB, desktop uses the existing account bridge and local files.
- The AI service is a Cloudflare Worker in `beta-server/`. It currently enforces anonymous installation/network allowances and, on the DeepInfra path, global daily/monthly dollar caps.
- The current cloud AI request schema is in `src/shared/ai.ts`. Do not trust a plan, quota, user ID, or price supplied in the request body.
- Existing cloud AI consent and data notices must remain accurate. Pro status does not grant consent to send notebook content.

## Proposed architecture

### 1. Subscription source of truth

Use Stripe for checkout and customer self-service, Supabase for the account-linked subscription/entitlement projection, and the Cloudflare Worker as the enforcement point for AI usage.

A server-only webhook handler must:
- Verify Stripe signatures against the raw request body.
- Handle relevant checkout, subscription update/delete, invoice payment success/failure, refund and dispute events.
- Be idempotent using Stripe event IDs and a unique database constraint.
- Tolerate duplicate and out-of-order events by reconciling the current Stripe subscription state rather than blindly trusting event arrival order.
- Never accept a client request to set its own plan.
- Record only necessary billing metadata; never store card details.

Supabase RLS: a signed-in user may read their own effective entitlement, but cannot insert/update/delete subscription or entitlement rows. Only the trusted webhook/service role may write them. The service-role key must never ship to web, desktop, or the AI Worker client bundle.

### 2. Entitlement contract

Define a typed, versioned contract shared by web and desktop, with at least:
- account subject
- edition: `free` or `pro`
- feature grants (only for non-core premium features)
- AI quota policy identifier
- status / reason (active, grace, expired, unavailable)
- issued-at and expires-at timestamps
- schema version

The server derives this contract from verified auth identity and subscription state. The client may cache a signed response for display and bounded offline continuity, but the client cache is never authoritative for AI requests.

### 3. AI request enforcement

For account-authenticated requests:
- Verify the Supabase access token server-side; derive the account ID from verified claims.
- Look up or securely cache the account's effective plan and quota policy.
- Atomically reserve worst-case request cost against account, network, and global daily/monthly budgets before calling DeepInfra.
- Settle the reservation using actual usage; retain conservative charges when usage is unknown.
- Fail closed for paid AI when auth/entitlement/quota state cannot be verified, with a clear retry message. Existing notebook operations remain unaffected.
- Preserve a deliberate compatibility path for older anonymous beta clients, with their existing conservative limits, until a migration/release policy retires it.

Do not simply multiply today's anonymous allowance for Pro. First measure real token/cost distributions for chat, markup, practice, answer checks, image-heavy prompts, and long conversations.

### 4. Core vs premium feature boundary

Core (always available): notebook library, pages, handwriting, text notes, PDF import/annotation/export, offline access, backup/restore, search/navigation, and current account sync.

Potential Pro features (ship only after built and tested): higher cloud AI allowance; advanced AI flashcard generation, practice-test generation, study guides, and personalized weak-topic review.

Existing tutor capabilities must be audited before creating new tiers. Avoid charging twice for functionality already present in the current AI Tutor.

### 5. Billing lifecycle

- Checkout opens Stripe-hosted Checkout; Inkling never handles card details.
- Customer Portal handles payment-method updates, invoices and cancellation.
- Define grace behavior for failed renewal, cancellation at period end, refunds, disputes and chargebacks.
- Cancellation or payment failure removes Pro-only AI grants at the effective time, but never deletes or locks user content.
- Clearly disclose renewal price, cadence, cancellation and refund terms before purchase.

## Rollout gates

1. Implement and test typed entitlements and core-feature invariants.
2. Add Supabase subscription/entitlement schema and RLS tests.
3. Add verified, idempotent webhook processing and reconciliation.
4. Add Worker account authentication and per-account AI quota reservations while preserving global caps and anonymous legacy compatibility.
5. Add UI for plan/usage and billing management.
6. Only then enable Stripe Checkout in production.

## Required tests

- Client cannot self-upgrade by editing local storage, IndexedDB, headers, or request JSON.
- User A cannot read or modify User B's subscription/entitlement.
- Invalid/expired tokens and missing entitlements cannot obtain Pro AI quota.
- Duplicate and out-of-order Stripe events converge to the actual subscription state.
- Renewal success/failure, cancellation, refund, dispute, webhook replay and service outage are covered.
- Concurrent AI requests cannot exceed account/network/global reservations.
- Global daily/monthly hard caps still hold under Pro load.
- Expired/missing entitlement never prevents opening, editing, exporting, backing up, or syncing notebooks.
- Offline cache expiry has a bounded grace and cannot be used to obtain extra server-side AI quota.

## Open decisions before charging

- Exact Free and Pro AI quotas based on measured cost and expected adoption.
- Whether $4.99/month includes tax or is shown before tax; jurisdictional handling.
- Refund policy, support contact, age/parental-consent policy and legal review.
- Whether Stripe Tax or a merchant of record is appropriate for international student customers.
