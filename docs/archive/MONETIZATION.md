# Free and Pro: the plan (not built yet)

The 7 November beta is free and asks for no payment. This note records what's prepared in the code and how payment would be added once demand is validated.

## Principles

- **The notebook is free, forever.** Nothing a student writes, imports or exports is ever locked behind a payment, and letting Pro lapse never hides or deletes content.
- **Pro sells what costs us money or saves real time:** cloud AI beyond a free allowance, and sync. It doesn't sell artificial limits on core features.
- **Validate before charging.** Ask beta testers what they would pay for (see `LAUNCH.md`) before building any of this.

## Suggested editions

| | Free | Pro (later) |
|---|---|---|
| Notebooks, handwriting, shapes, images | ✓ unlimited | ✓ |
| Rich-text notes, links, search, graph | ✓ | ✓ |
| PDF import, annotation, export | ✓ | ✓ |
| Automatic backups, restore | ✓ | ✓ |
| AI Tutor with Ollama or your own key | ✓ | ✓ |
| Cloud AI Tutor, no setup | Small daily allowance | Larger allowance |
| Sync between devices | – | ✓ (not built) |
| Search inside handwriting | – | ✓ (not built) |

## What's in the code

`src/shared/entitlements.ts`:
- `Feature`, the list of features, each marked `core` or not.
- `Entitlements`, the edition plus a flag per feature. In the beta, `BETA_ENTITLEMENTS` grants everything.
- `can(entitlements, feature)`. **Core features always return true, whatever the grant says**, so a bug or an expired licence can never lock someone's notes.
- `EntitlementSource`, where entitlements come from. Today it's `betaSource`; later it's a signed-licence source.

Nothing in the app checks entitlements yet. When a Pro feature is built, its entry point calls `can(…, 'feature')`; core notebook code never does.

## Adding payments later (Stripe)

1. **Accounts.** Add sign-in (e.g. email magic link) on the Inkling API, the same Cloudflare Worker that runs the AI beta.
2. **Checkout.** The app opens Stripe Checkout in the browser (`shell.openExternal`); card details never pass through Inkling. A Stripe Customer Portal link handles cancellation and invoices.
3. **Webhook.** The Worker receives Stripe's `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted` events. It verifies Stripe's signature and stores the subscription state per account.
4. **Licence.** On sign-in, or each day, the app fetches a licence: a small JSON with the edition, features and validity, signed by the server (Ed25519). The app verifies it with a public key built into the app, so a licence can't be forged locally. Licences stay valid offline until `validUntil` plus a grace period.
5. **Allowance.** The AI server reads the same subscription state to set each user's daily allowance. The per-installation ledger that already exists becomes per user.
6. **Taxes and refunds.** Use Stripe Tax, or a merchant of record such as Paddle or Lemon Squeezy, to handle VAT and sales tax, which matters for a worldwide student product. Write a refund policy before launch.

Not needed for any of this: the app store, a separate subscription server, or storing card data.
