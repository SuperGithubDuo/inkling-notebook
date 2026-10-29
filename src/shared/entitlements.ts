/**
 * Editions and what they include. Groundwork only: in the beta every built
 * feature is available and nothing is checked against a payment.
 *
 * Rules this interface keeps:
 * - Core notebook features are free in every edition, forever: nobody's
 *   handwriting, PDFs or notes are ever locked behind a payment, and
 *   lapsing from Pro never hides or deletes content.
 * - Paid features are additions (more AI, sync, extras) that sit outside the
 *   core notebook code and ask `can(feature)` at their entry point.
 * - Where entitlements come from is hidden behind `EntitlementSource`: today
 *   a fixed beta grant; later a signed licence from the payment backend
 *   (see docs/MONETIZATION.md). The app never trusts an unsigned claim.
 */
export type Edition = 'beta' | 'free' | 'pro'

export const FEATURES = {
  // Core: always included.
  notebooks: { label: 'Notebooks, handwriting, shapes and images', core: true },
  notes: { label: 'Rich-text notes, links and search', core: true },
  pdf: { label: 'PDF import, annotation and export', core: true },
  backups: { label: 'Automatic backups and restore', core: true },
  localAi: { label: 'AI Tutor with your own local model (Ollama) or key', core: true },
  // Candidates for Pro (not built or not limited yet).
  cloudAi: { label: 'AI Tutor in the cloud, no setup', core: false },
  cloudAiPlus: { label: 'A larger daily cloud AI allowance', core: false },
  sync: { label: 'Sync between devices', core: false },
  handwritingSearch: { label: 'Search inside handwriting', core: false }
} as const

export type Feature = keyof typeof FEATURES

export interface Entitlements {
  edition: Edition
  features: Record<Feature, boolean>
  /** Where the grant came from, shown in About. */
  source: 'beta' | 'free' | 'licence'
  /** Licence expiry (ISO), for paid editions. */
  validUntil?: string
}

const all = (on: boolean): Record<Feature, boolean> => Object.fromEntries(Object.entries(FEATURES).map(([k, f]) => [k, f.core || on])) as Record<Feature, boolean>

/** Everything built so far, for every beta tester. */
export const BETA_ENTITLEMENTS: Entitlements = { edition: 'beta', features: all(true), source: 'beta' }
/** What a free edition would include: the core, plus a small cloud AI allowance. */
export const FREE_ENTITLEMENTS: Entitlements = { edition: 'free', features: { ...all(false), cloudAi: true }, source: 'free' }

export function can(e: Entitlements, feature: Feature): boolean {
  // Core features never depend on the grant.
  return FEATURES[feature].core || e.features[feature] === true
}

/** Supplies the current entitlements; a licence-backed source replaces the beta one later. */
export interface EntitlementSource {
  current(): Entitlements
  /** Re-reads the grant (e.g. after a purchase or at startup). */
  refresh(): Promise<Entitlements>
}

export const betaSource: EntitlementSource = {
  current: () => BETA_ENTITLEMENTS,
  refresh: async () => BETA_ENTITLEMENTS
}
