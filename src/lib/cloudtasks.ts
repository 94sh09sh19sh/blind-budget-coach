// 雲端任務：盲眼分析（問題 → 查詢計畫）與預算建議（類別占比 → 三條建議）。
// 雲端呼叫與裝置端選樣式都是注入的函式；本檔不碰 SDK，單元測試用假的回應。
import { CATEGORIES } from './categories'
import { requestBytes, type CloudCall, type CloudMode, type CloudRequest, type CloudResult } from './ai'
import { PLAN_SCHEMA, matchByKeywords, patternToPlan, validateChoice, validatePlan, type PatternChoice, type QueryPlan } from './plan'
import type { Side, TimelineEntry } from './router'

export interface ColumnInfo { name: string; type: 'date' | 'text' | 'number' }

/** 出境清單：送出前原文列給使用者看；bytes 是將送出內容（system + prompt + 回應結構）的 UTF-8 位元組數，不含 HTTP 標頭與 SDK 的 JSON 外框。 */
export interface Manifest {
  task: string
  mode: CloudMode
  system: string
  prompt: string
  bytes: number
  notIncluded: string
  schema: object
}

/** 把雲端例外轉成使用者看得懂的短句，不顯示原始例外字串（可能含網址或設定）。 */
export function describeCloudError(e: unknown): string {
  const m = e instanceof Error ? e.message : ''
  if (/429|quota|rate.?limit|resource.?exhausted/i.test(m)) return 'the free daily or per-minute limit was reached'
  if (/app.?check|appcheck|401|403|permission|unauthenticated|api.?key/i.test(m)) return 'the request was refused (App Check or API key problem)'
  if (/404|not found/i.test(m)) return 'the model was not found'
  if (/timed out/i.test(m)) return 'no response within the time limit'
  // SDK 的 HTTP 錯誤訊息開頭一律是「Error fetching from <網址>: [狀態碼 …]」，要先看狀態碼，不然都會被下一行的 fetch 判成網路失敗
  if (/\[5\d\d\b/.test(m)) return 'the cloud service returned a server error'
  if (/\[400\b/.test(m)) return 'the cloud service rejected the request as invalid'
  if (/network|fetch|offline|failed to load|timeout/i.test(m)) return 'the network request failed'
  return 'an unexpected error'
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
Use only these fields. Resolve relative dates such as "last month" using the given today's date.
If the question cannot be answered exactly with these fields (for example comparing two periods, percentage changes, forecasts, or anything that needs more than one query), do not approximate it with a different query. Return only {"unsupportedReason": "<one short sentence>"}.
If the question can be answered with these fields, return only the plan and leave out unsupportedReason entirely. Do not combine unsupportedReason with plan fields.`

/** 出境清單的 Today: 用的日期：使用者所在時區的 YYYY-MM-DD（不用 toISOString，那是 UTC 日期） */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

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
    bytes: requestBytes(PLAN_SYSTEM, prompt, PLAN_SCHEMA),
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
  /** 雲端明確回報超出能力範圍（此時不退回固定樣式，避免給出看似合理的錯數字） */
  unsupported?: boolean
}

export const MAX_CLOUD_CALLS = 10

/** 每次載入頁面一個（重新整理或 Erase 都換新的）：同一問題快取、雲端呼叫上限。 */
export class AskSession {
  cache = new Map<string, AskOutcome>()
  /** 固定樣式的結果另放一份：不能擋住出境清單（選了不送之後，同一題還要能改選送出） */
  fixedCache = new Map<string, AskOutcome>()
  cloudCalls = 0
  maxCalls: number
  constructor(maxCalls = MAX_CLOUD_CALLS) { this.maxCalls = maxCalls }
  static key(q: string) { return q.trim().toLowerCase().replace(/\s+/g, ' ') }
}

/** 雲端呼叫已到上限：不再開出境清單，改走本機固定樣式 */
export const limitReached = (s: AskSession) => s.cloudCalls >= s.maxCalls

/** 到上限時的說明（介面與時間線共用）。上限每次載入頁面歸零。 */
export const cloudLimitReason = (max: number) => `The limit of ${max} cloud calls per page load was reached`

export interface AskDeps {
  /** 沒有就視為雲端不可用 */
  cloud?: CloudCall
  /** 有裝置端模型時，由它從六種固定樣式選一種並填參數；回傳原始 JSON 字串 */
  deviceChoose?: (question: string) => Promise<string>
  log: LogFn
  /** 每次雲端呼叫送出之前呼叫（App 用它先在帳本寫一列，答案回來前關掉頁面也留得下紀錄） */
  beforeCloud?: (manifest: Manifest) => void
  now?: () => number
  /** 一次雲端呼叫最多等多久（毫秒）；沒給就用 CLOUD_TIMEOUT_MS */
  timeoutMs?: number
  /** 裝置端選固定樣式最多等多久（毫秒）；沒給就用 DEVICE_CHOOSE_TIMEOUT_MS */
  deviceTimeoutMs?: number
}

/** 裝置端選固定樣式的等待上限（與分類單筆的上限相同）。模型卡住時逾時就退回關鍵字比對，不讓範例問題一直停用。 */
export const DEVICE_CHOOSE_TIMEOUT_MS = 60_000

/** 一次雲端呼叫的等待上限。正常 2～12 秒；超過就當作失敗，不讓介面一直等。 */
export const CLOUD_TIMEOUT_MS = 45_000

const tm = (d: AskDeps) => (d.now ?? (() => performance.now()))()

/** 雲端呼叫加等待上限：逾時就丟錯，由呼叫端照「呼叫失敗」處理（盲眼分析退回固定樣式，預算建議顯示錯誤）。 */
function callCloud(deps: AskDeps, cloud: CloudCall, req: CloudRequest): Promise<CloudResult> {
  const ms = deps.timeoutMs ?? CLOUD_TIMEOUT_MS
  return new Promise<CloudResult>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cloud call timed out')), ms)
    cloud(req).then(
      (r) => { clearTimeout(timer); resolve(r) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/** 固定樣式：裝置端模型選（ONLY_ON_DEVICE）；沒有就用關鍵字比對。 */
export async function askFixed(session: AskSession, deps: AskDeps, question: string, why: string): Promise<AskOutcome> {
  const key = AskSession.key(question)
  // 固定樣式結果連同「為什麼用固定樣式」一起當鍵：雲端失敗退回時，不能顯示先前『選了不送』的說明
  const fkey = `${key}|${why}`
  const hit = session.cache.get(key) ?? session.fixedCache.get(fkey)
  if (hit) return { ...hit, cached: true }
  let out: AskOutcome | null = null
  let kwWhy = why
  if (deps.deviceChoose) {
    const t0 = tm(deps)
    const limit = deps.deviceTimeoutMs ?? DEVICE_CHOOSE_TIMEOUT_MS
    let choice: PatternChoice | null = null
    let timedOut = false
    try {
      choice = validateChoice(JSON.parse(await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => { timedOut = true; reject(new Error('device model timed out')) }, limit)
        deps.deviceChoose!(question).then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
      })))
    } catch { choice = null }
    if (timedOut) kwWhy = `The on-device model did not answer within ${Math.round(limit / 1000)} s. ${why}`
    const plan = choice ? patternToPlan(choice) : null
    deps.log({ task: 'blind analysis: pick fixed pattern', mode: 'ONLY_ON_DEVICE', side: 'device', ms: tm(deps) - t0, bytesSent: 0, reason: kwWhy })
    if (plan) out = { plan, source: 'device', note: `Fixed pattern chosen on device. ${why}`, cached: false }
  }
  if (!out) {
    const t0 = tm(deps)
    const choice = matchByKeywords(question)
    const plan = choice ? patternToPlan(choice) : null
    deps.log({ task: 'blind analysis: keyword match', mode: 'LOCAL_RULES', side: 'rules', ms: tm(deps) - t0, bytesSent: 0, reason: kwWhy })
    out = plan
      ? { plan, source: 'rules', note: `Fixed pattern chosen by keywords. ${kwWhy}`, cached: false }
      : { plan: null, source: 'none', note: 'Could not map that question to one of the six fixed patterns. Try an example question.', cached: false }
  }
  if (out.plan) session.fixedCache.set(fkey, out)
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
    if (limitReached(session)) { why = `${cloudLimitReason(session.maxCalls)}; using a fixed pattern.`; break }
    session.cloudCalls++
    const t0 = tm(deps)
    let side: Side = 'cloud'
    deps.beforeCloud?.(manifest)
    try {
      const r = await callCloud(deps, deps.cloud, { mode: manifest.mode, system: manifest.system, prompt: manifest.prompt, schema: manifest.schema })
      side = r.source === 'device' ? 'device' : 'cloud'
      let v
      try { v = validatePlan(JSON.parse(r.text)) } catch { v = { ok: false as const, error: 'response was not valid JSON' } }
      // SDK 回報裝置端：PREFER_IN_CLOUD 的雲端呼叫失敗（請求本文可能已送出），才改由裝置端模型回答；原因寫明，帳本照樣記這一列
      const via = side === 'device' ? 'The cloud call failed, so the SDK let the on-device model answer. ' : ''
      deps.log({ task: manifest.task, mode: manifest.mode, side, ms: tm(deps) - t0, bytesSent: manifest.bytes, reason: via + (!v.ok ? `Plan rejected (${v.error})${attempt === 0 ? '; retrying once' : ''}.` : v.plan ? 'Plan accepted.' : 'Question reported as out of scope.') })
      if (v.ok && !v.plan) {
        const out: AskOutcome = { plan: null, source: side === 'cloud' ? 'cloud' : 'device', note: `This question is outside what this app can answer exactly: ${v.unsupported} Try asking for one total, average, count or ranking at a time.`, cached: false, unsupported: true }
        session.cache.set(key, out)
        return out
      }
      if (v.ok) {
        const out: AskOutcome = { plan: v.plan, source: side === 'cloud' ? 'cloud' : 'device', note: side === 'cloud' ? 'Query plan written by the cloud model; executed locally.' : 'Cloud unreachable; the on-device model wrote the plan.', cached: false }
        session.cache.set(key, out)
        return out
      }
      why = `The plan was invalid (${v.error}); using a fixed pattern.`
    } catch (e) {
      deps.log({ task: manifest.task, mode: manifest.mode, side: 'cloud', ms: tm(deps) - t0, bytesSent: manifest.bytes, reason: `Call failed: ${describeCloudError(e)}.` })
      why = `The cloud call failed (${describeCloudError(e)}); using a fixed pattern.`
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
    bytes: requestBytes(ADVICE_SYSTEM, prompt, ADVICE_SCHEMA),
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
    if (limitReached(session)) return { ok: false, error: `${cloudLimitReason(session.maxCalls)}.` }
    session.cloudCalls++
    const t0 = tm(deps)
    deps.beforeCloud?.(manifest)
    try {
      const r = await callCloud(deps, deps.cloud, { mode: manifest.mode, system: manifest.system, prompt: manifest.prompt, schema: manifest.schema })
      let a: Advice | null = null
      try { a = validateAdvice(JSON.parse(r.text)) } catch { a = null }
      deps.log({ task: manifest.task, mode: manifest.mode, side: 'cloud', ms: tm(deps) - t0, bytesSent: manifest.bytes, reason: a ? 'Advice accepted.' : `Response did not match the expected shape${attempt === 0 ? '; retrying once' : ''}.` })
      if (a) return { ok: true, advice: a }
      last = 'The cloud response did not match the expected shape.'
    } catch (e) {
      deps.log({ task: manifest.task, mode: manifest.mode, side: 'cloud', ms: tm(deps) - t0, bytesSent: manifest.bytes, reason: `Call failed: ${describeCloudError(e)}.` })
      return { ok: false, error: `The cloud call failed: ${describeCloudError(e)}.` }
    }
  }
  return { ok: false, error: last }
}

