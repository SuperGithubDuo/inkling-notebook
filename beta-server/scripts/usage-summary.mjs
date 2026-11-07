#!/usr/bin/env node
/** Render /admin/summary JSON from stdin; no credentials or network access. */
import { readFileSync } from 'node:fs'

const s = JSON.parse(readFileSync(0, 'utf8'))
const knownUnit = s.unit === 'usd' || s.unit === 'neurons'
const valid = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const amount = (value) => !knownUnit ? 'usage unit unavailable' : !valid(value) ? 'unavailable' : s.unit === 'neurons' ? `${value} Neurons` : `$${(value / 1_000_000).toFixed(2)}`
const percent = (used, limit) => knownUnit && valid(used) && valid(limit) && limit > 0 ? ` (${Math.floor(100 * used / limit)}%)` : ''
const remaining = valid(s.monthLimit) && valid(s.monthUsed) ? `${amount(Math.max(0, s.monthLimit - s.monthUsed))} remaining` : 'remaining unavailable'
const budget = valid(s.monthLimit) ? `${amount(s.monthLimit)} budget` : 'budget unavailable'
console.log(`${s.day} UTC: ${amount(s.globalUsed)} of ${amount(s.globalLimit)} used in the last 24 h${percent(s.globalUsed, s.globalLimit)}, ${amount(s.todayUsed)} today, ${s.answers} answers today, ${s.installations} installations, ${s.networks} networks, ${s.answering} answering now, paused=${s.paused}, upstream exhausted=${s.upstreamExhausted}; ${s.month}: ${amount(s.monthUsed)} used, ${budget}, ${remaining}${percent(s.monthUsed, s.monthLimit)}, ${s.monthAnswers} answers this month`)
