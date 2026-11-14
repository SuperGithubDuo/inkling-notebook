/**
 * Free/Pro entitlements: the contract returned by Supabase's my_entitlement()
 * (supabase/migrations/20261114000000_entitlements.sql). The server derives it
 * from the verified account; a client copy is for display only and is never
 * trusted for AI requests.
 */
import { z } from 'zod'

export const PLANS = ['free', 'pro'] as const
export type Plan = (typeof PLANS)[number]

export const entitlementSchema = z.object({
  version: z.literal(1),
  user_id: z.uuid(),
  plan: z.enum(PLANS),
  status: z.enum(['none', 'active', 'trialing', 'past_due', 'canceled', 'expired']),
  pro_until: z.string().nullable(),
  checked_at: z.string()
})
export type Entitlement = z.infer<typeof entitlementSchema>

/** Never behind a plan: a missing, expired or unreadable entitlement must not block any of these. */
export const CORE_FEATURES = ['notebooks', 'handwriting', 'pdf_import', 'pdf_annotation', 'offline', 'sync', 'backup', 'export', 'existing_notes'] as const
/** Pro-only grants (none ship yet besides a larger AI allowance, which the AI server enforces itself). */
export const PRO_FEATURES = ['ai_pro_allowance'] as const
export type Feature = (typeof CORE_FEATURES)[number] | (typeof PRO_FEATURES)[number]

export function canUse(feature: Feature, entitlement: Entitlement | null | undefined): boolean {
  return (CORE_FEATURES as readonly string[]).includes(feature) || entitlement?.plan === 'pro'
}
