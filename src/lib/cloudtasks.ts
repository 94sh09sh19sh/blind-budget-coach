// 雲端任務：盲眼分析（問題 → 查詢計畫）與預算建議（類別占比 → 三條建議）。
// 雲端呼叫與裝置端選樣式都是注入的函式；本檔不碰 SDK，單元測試用假的回應。
import { CATEGORIES } from './categories'
import { requestBytes, type CloudCall, type CloudMode } from './ai'
import { PLAN_SCHEMA, matchByKeywords, patternToPlan, validateChoice, validatePlan, type PatternChoice, type QueryPlan } from './plan'
import type { Side, TimelineEntry } from './router'

export interface ColumnInfo { name: string; type: 'date' | 'text' | 'number' }

/** 出境清單：送出前原文列給使用者看；bytes 是將送出內容（system + prompt）的 UTF-8 位元組數。 */
export interface Manifest {
  task: string
  mode: CloudMode
  system: string
  prompt: string
  bytes: number
  notIncluded: string
  schema: object
}

export type LogFn = (e: Omit<TimelineEntry, 'id' | 'at'>) => void

const PLAN_SYSTEM = `You turn a budgeting question into a JSON query plan. You never see the user's transactions; a program on the user's device will run your plan locally.
Plan fields (all optional except aggregate):
- filter.categories: list of categories from the given list
- filter.merchantContains: a short text the merchant name must contain
- filter.dateFrom / filter.dateTo: YYYY-MM-DD
- filter.amountMin / filter.amountMax: absolute amount bounds
- filter.direction: "spend" (default), "income" or "all"
- groupBy: "category", "month" or "merchant"
- aggregate: "sum", "count" or "avg"
- sort: "value_desc", "value_asc" or "label_asc"
- limit: integer 1 to 50 (top N)
Use only these fields. Resolve relative dates such as "last month" using the given today's date.`

export function buildPlanManifest(question: string, columns: ColumnInfo[], today: string, txCount: number): Manifest {
  const prompt = [
    `Today: ${today}`,
    `Columns: ${columns.map((c) => `${c.name} (${c.type})`).join(', ')}`,
    `Categories: ${CATEGORIES.join(', ')}`,
    `Question: ${question.trim()}`,
  ].join('\n')
  return {
    task: 'blind analysis: write query plan',
    mode: 'PREFER_IN_CLOUD',
    system: PLAN_SYSTEM,
    prompt,
    bytes: requestBytes(PLAN_SYSTEM, prompt),
    notIncluded: `Not included: ${txCount} transactions, merchants, dates, amounts`,
    schema: PLAN_SCHEMA,
  }
}

// ---- 盲眼分析 ----

export interface AskOutcome {
  plan: QueryPlan | null
  source: 'cloud' | 'device' | 'rules' | 'none'
  note: string
  cached: boolean
}

export const MAX_CLOUD_CALLS = 10

/** 每個瀏覽階段一個：同一問題快取、雲端呼叫上限。 */
export class AskSession {
  cache = new Map<string, AskOutcome>()
  cloudCalls = 0
  maxCalls: number
  constructor(maxCalls = MAX_CLOUD_CALLS) { this.maxCalls = maxCalls }
  static key(q: string) { return q.trim().toLowerCase().replace(/\s+/g, ' ') }
}

export interface AskDeps {
  /** 沒有就視為雲端不可用 */
  cloud?: CloudCall
  /** 有裝置端模型時，由它從六種固定樣式選一種並填參數；回傳原始 JSON 字串 */
  deviceChoose?: (question: string) => Promise<string>
  log: LogFn
  now?: () => number
}

const tm = (d: AskDeps) => (d.now ?? (() => performance.now()))()

/** 固定樣式：裝置端模型選（ONLY_ON_DEVICE）；沒有就用關鍵字比對。 */
export async function askFixed(session: AskSession, deps: AskDeps, question: string, why: string): Promise<AskOutcome> {
  const key = AskSession.key(question)
  const hit = session.cache.get(key)
  if (hit) return { ...hit, cached: true }
  let out: AskOutcome | null = null
  if (deps.deviceChoose) {
    const t0 = tm(deps)
    let choice: PatternChoice | null = null
    try { choice = validateChoice(JSON.parse(await deps.deviceChoose(question))) } catch { choice = null }
    const plan = choice ? patternToPlan(choice) : null
    deps.log({ task: 'blind analysis: pick fixed pattern', mode: 'ONLY_ON_DEVICE', side: 'device', ms: tm(deps) - t0, bytesSent: 0, reason: why })
    if (plan) out = { plan, source: 'device', note: `Fixed pattern chosen on device. ${why}`, cached: false }
  }
  if (!out) {
    const t0 = tm(deps)
    const choice = matchByKeywords(question)
    const plan = choice ? patternToPlan(choice) : null
    deps.log({ task: 'blind analysis: keyword match', mode: 'LOCAL_RULES', side: 'rules', ms: tm(deps) - t0, bytesSent: 0, reason: why })
    out = plan
      ? { plan, source: 'rules', note: `Fixed pattern chosen by keywords. ${why}`, cached: false }
      : { plan: null, source: 'none', note: 'Could not map that question to one of the six fixed patterns. Try an example question.', cached: false }
  }
  if (out.plan) session.cache.set(key, out)
  return out
}

/** 使用者按同意後才呼叫。驗證失敗重試一次，再失敗或雲端不可用就改用固定樣式。 */
export async function askCloud(session: AskSession, deps: AskDeps, question: string, manifest: Manifest): Promise<AskOutcome> {
  const key = AskSession.key(question)
  const hit = session.cache.get(key)
  if (hit) return { ...hit, cached: true }
  if (!deps.cloud) return askFixed(session, deps, question, 'Cloud is not available; using a fixed pattern.')
  let why = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    if (session.cloudCalls >= session.maxCalls) { why = `Session limit of ${session.maxCalls} cloud calls reached; using a fixed pattern.`; break }
    session.cloudCalls++
    const t0 = tm(deps)
    let side: Side = 'cloud'
    try {
      const r = await deps.cloud({ mode: manifest.mode, system: manifest.system, prompt: manifest.prompt, schema: manifest.schema })
      side = r.source === 'device' ? 'device' : 'cloud'
      let v
      try { v = validatePlan(JSON.parse(r.text)) } catch { v = { ok: false as const, error: 'response was not valid JSON' } }
      deps.log({ task: manifest.task, mode: manifest.mode, side, ms: tm(deps) - t0, bytesSent: manifest.bytes, reason: v.ok ? 'Plan accepted.' : `Plan rejected (${v.error})${attempt === 0 ? '; retrying once' : ''}.` })
      if (v.ok) {
        const out: AskOutcome = { plan: v.plan, source: side === 'cloud' ? 'cloud' : 'device', note: side === 'cloud' ? 'Query plan written by the cloud model; executed locally.' : 'Cloud unreachable; the on-device model wrote the plan.', cached: false }
        session.cache.set(key, out)
        return out
      }
      why = `The plan was invalid (${v.error}); using a fixed pattern.`
    } catch (e) {
      deps.log({ task: manifest.task, mode: manifest.mode, side: 'cloud', ms: tm(deps) - t0, bytesSent: manifest.bytes, reason: `Call failed (${e instanceof Error ? e.message : 'error'}).` })
      why = 'The cloud call failed; using a fixed pattern.'
      break
    }
  }
  return askFixed(session, deps, question, why)
}

// ---- 預算建議 ----

/** 類別占比（整數百分比，最大餘數法讓總和為 100）。 */
export function categoryShares(spend: Record<string, number>): Record<string, number> {
  const entries = Object.entries(spend).filter(([, v]) => v > 0)
  const total = entries.reduce((s, [, v]) => s + v, 0)
  if (total <= 0) return {}
  const raw = entries.map(([k, v]) => ({ k, exact: (v / total) * 100 }))
  const out: Record<string, number> = {}
  let used = 0
  for (const r of raw) { out[r.k] = Math.floor(r.exact); used += out[r.k] }
  const rest = [...raw].sort((a, b) => (b.exact % 1) - (a.exact % 1))
  for (let i = 0; used < 100 && i < rest.length; i++, used++) out[rest[i].k]++
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k]
  return out
}

const ADVICE_SYSTEM = `You are a budgeting coach. You are given only the share of spending per category as whole-number percentages that sum to about 100. You never see transactions, merchants, dates or amounts.
Give exactly three short, practical suggestions for improving this budget. Do not invent amounts or merchants. Each suggestion has a short title and one or two sentences of detail.`

export const ADVICE_SCHEMA = {
  type: 'object',
  properties: {
    tips: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' } }, required: ['title', 'detail'] },
    },
  },
  required: ['tips'],
}

export interface Advice { tips: { title: string; detail: string }[] }

export function validateAdvice(x: unknown): Advice | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null
  const tips = (x as { tips?: unknown }).tips
  if (!Array.isArray(tips) || tips.length !== 3) return null
  const out: Advice['tips'] = []
  for (const t of tips) {
    if (typeof t !== 'object' || t === null) return null
    const { title, detail } = t as { title?: unknown; detail?: unknown }
    if (typeof title !== 'string' || typeof detail !== 'string' || !title.trim() || !detail.trim() || title.length > 120 || detail.length > 600) return null
    out.push({ title: title.trim(), detail: detail.trim() })
  }
  return { tips: out }
}

export function buildAdviceManifest(shares: Record<string, number>, txCount: number): Manifest {
  const prompt = `Share of spending by category (percent):\n${Object.entries(shares).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}%`).join('\n')}`
  return {
    task: 'budget advice from category ratios',
    mode: 'ONLY_IN_CLOUD',
    system: ADVICE_SYSTEM,
    prompt,
    bytes: requestBytes(ADVICE_SYSTEM, prompt),
    notIncluded: `Not included: ${txCount} transactions, merchants, dates, amounts`,
    schema: ADVICE_SCHEMA,
  }
}

export type AdviceOutcome = { ok: true; advice: Advice } | { ok: false; error: string }

/** 使用者按同意後才呼叫；ONLY_IN_CLOUD，沒有備援。驗證失敗重試一次。 */
export async function askAdvice(session: AskSession, deps: AskDeps, manifest: Manifest): Promise<AdviceOutcome> {
  if (!deps.cloud) return { ok: false, error: 'Cloud is not available.' }
  let last = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    if (session.cloudCalls >= session.maxCalls) return { ok: false, error: `Session limit of ${session.maxCalls} cloud calls reached.` }
    session.cloudCalls++
    const t0 = tm(deps)
    try {
      const r = await deps.cloud({ mode: manifest.mode, system: manifest.system, prompt: manifest.prompt, schema: manifest.schema })
      let a: Advice | null = null
      try { a = validateAdvice(JSON.parse(r.text)) } catch { a = null }
      deps.log({ task: manifest.task, mode: manifest.mode, side: 'cloud', ms: tm(deps) - t0, bytesSent: manifest.bytes, reason: a ? 'Advice accepted.' : `Response did not match the expected shape${attempt === 0 ? '; retrying once' : ''}.` })
      if (a) return { ok: true, advice: a }
      last = 'The cloud response did not match the expected shape.'
    } catch (e) {
      deps.log({ task: manifest.task, mode: manifest.mode, side: 'cloud', ms: tm(deps) - t0, bytesSent: manifest.bytes, reason: `Call failed (${e instanceof Error ? e.message : 'error'}).` })
      return { ok: false, error: 'The cloud call failed.' }
    }
  }
  return { ok: false, error: last }
}

