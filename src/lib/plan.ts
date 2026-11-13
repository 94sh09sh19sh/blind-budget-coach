// 盲眼分析的查詢計畫：JSON 結構、嚴格驗證器、白名單執行器、六種固定樣式。全部是純函式，不碰網路與模型。
import { CATEGORIES, isCategory, type Category } from './categories'
import { monthOf, type Classified } from './aggregate'
import { normalizeDesc } from './normalize'

export type Direction = 'spend' | 'income' | 'all'
export type GroupBy = 'category' | 'month' | 'merchant'
export type Agg = 'sum' | 'count' | 'avg'
export type SortKey = 'value_desc' | 'value_asc' | 'label_asc'

export interface QueryPlan {
  filter?: {
    categories?: Category[]
    merchantContains?: string
    dateFrom?: string // YYYY-MM-DD
    dateTo?: string
    amountMin?: number // 以金額絕對值比較
    amountMax?: number
    direction?: Direction
  }
  groupBy?: GroupBy
  aggregate: Agg
  sort?: SortKey
  limit?: number
}

/** 雲端認為問題超出能力範圍時回的結構：只有一個原因字串，不可附帶其他欄位。 */
export interface UnsupportedPlan { unsupportedReason: string }

export type Validation = { ok: true; plan: QueryPlan } | { ok: true; unsupported: string; plan?: undefined } | { ok: false; error: string }

const FILTER_KEYS = ['categories', 'merchantContains', 'dateFrom', 'dateTo', 'amountMin', 'amountMax', 'direction']
const PLAN_KEYS = ['filter', 'groupBy', 'aggregate', 'sort', 'limit']
const MAX_TEXT = 40

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

function validIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(s + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/**
 * 嚴格驗證：未知欄位、型別不對、值超出白名單一律拒絕。
 *
 * unsupportedReason 的處理（2026-11-13 公開網址實測後調整）：
 * - 空字串、只有空白、null：模型在回應結構裡順手多帶的空欄位，當成沒有這個欄位，其餘照常嚴格驗證。
 *   只剩這個空欄位、沒有任何計畫欄位時仍然拒絕。
 * - 有內容而且是唯一的欄位：模型明說做不到，回傳 unsupported（呼叫端不退回固定樣式、不給數字）。
 * - 有內容但同時帶了計畫欄位：仍然拒絕（呼叫端重試一次）。實測看過這種回應：計畫本身合法，但附了一句互相矛盾的理由；
 *   不能判斷哪一邊才是模型的本意，而「模型說做不到」的題目不可用它順手給的近似計畫硬答，所以不採用。
 * - 非字串（數字、物件、陣列、布林）或超過 300 字：拒絕。
 */
export function validatePlan(input: unknown): Validation {
  if (!isObj(input)) return { ok: false, error: 'plan must be an object' }
  let x: Record<string, unknown> = input
  if (input.unsupportedReason !== undefined) {
    const r = input.unsupportedReason
    if (r === null || (typeof r === 'string' && r.trim() === '')) {
      x = Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'unsupportedReason'))
      if (Object.keys(x).length === 0) return { ok: false, error: 'response had an empty unsupportedReason and no plan' }
    } else {
      if (typeof r !== 'string' || r.length > 300) return { ok: false, error: 'unsupportedReason must be a short string' }
      if (Object.keys(input).length !== 1) return { ok: false, error: 'response had both an unsupportedReason and plan fields' }
      return { ok: true, unsupported: r.trim() }
    }
  }
  for (const k of Object.keys(x)) if (!PLAN_KEYS.includes(k)) return { ok: false, error: `unknown key: ${k}` }
  if (x.aggregate !== 'sum' && x.aggregate !== 'count' && x.aggregate !== 'avg') return { ok: false, error: 'aggregate must be sum, count or avg' }
  const plan: QueryPlan = { aggregate: x.aggregate }
  if (x.groupBy !== undefined) {
    if (x.groupBy !== 'category' && x.groupBy !== 'month' && x.groupBy !== 'merchant') return { ok: false, error: 'bad groupBy' }
    plan.groupBy = x.groupBy
  }
  if (x.sort !== undefined) {
    if (x.sort !== 'value_desc' && x.sort !== 'value_asc' && x.sort !== 'label_asc') return { ok: false, error: 'bad sort' }
    plan.sort = x.sort
  }
  if (x.limit !== undefined) {
    if (typeof x.limit !== 'number' || !Number.isInteger(x.limit) || x.limit < 1 || x.limit > 50) return { ok: false, error: 'limit must be an integer 1..50' }
    plan.limit = x.limit
  }
  if (x.filter !== undefined) {
    const f = x.filter
    if (!isObj(f)) return { ok: false, error: 'filter must be an object' }
    for (const k of Object.keys(f)) if (!FILTER_KEYS.includes(k)) return { ok: false, error: `unknown filter key: ${k}` }
    const out: NonNullable<QueryPlan['filter']> = {}
    if (f.categories !== undefined) {
      if (!Array.isArray(f.categories) || f.categories.length === 0 || f.categories.length > CATEGORIES.length || !f.categories.every(isCategory))
        return { ok: false, error: 'categories must be a non-empty list of known categories' }
      out.categories = f.categories as Category[]
    }
    if (f.merchantContains !== undefined) {
      if (typeof f.merchantContains !== 'string' || f.merchantContains.trim().length === 0 || f.merchantContains.length > MAX_TEXT)
        return { ok: false, error: 'merchantContains must be a short non-empty string' }
      out.merchantContains = f.merchantContains.trim()
    }
    for (const k of ['dateFrom', 'dateTo'] as const) {
      if (f[k] !== undefined) {
        if (!validIsoDate(f[k])) return { ok: false, error: `${k} must be YYYY-MM-DD` }
        out[k] = f[k] as string
      }
    }
    if (out.dateFrom && out.dateTo && out.dateFrom > out.dateTo) return { ok: false, error: 'dateFrom is after dateTo' }
    for (const k of ['amountMin', 'amountMax'] as const) {
      if (f[k] !== undefined) {
        const v = f[k]
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e9) return { ok: false, error: `${k} must be a non-negative number` }
        out[k] = v
      }
    }
    if (out.amountMin !== undefined && out.amountMax !== undefined && out.amountMin > out.amountMax) return { ok: false, error: 'amountMin is above amountMax' }
    if (f.direction !== undefined) {
      if (f.direction !== 'spend' && f.direction !== 'income' && f.direction !== 'all') return { ok: false, error: 'bad direction' }
      out.direction = f.direction
    }
    plan.filter = out
  }
  return { ok: true, plan }
}

/** 給雲端結構化輸出用的 JSON Schema（與驗證器一致；驗證器仍是最後一道關，aggregate 必填由驗證器檢查）。 */
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    filter: {
      type: 'object',
      properties: {
        categories: { type: 'array', items: { type: 'string', enum: [...CATEGORIES] } },
        merchantContains: { type: 'string' },
        dateFrom: { type: 'string', description: 'YYYY-MM-DD' },
        dateTo: { type: 'string', description: 'YYYY-MM-DD' },
        amountMin: { type: 'number' },
        amountMax: { type: 'number' },
        direction: { type: 'string', enum: ['spend', 'income', 'all'] },
      },
    },
    groupBy: { type: 'string', enum: ['category', 'month', 'merchant'] },
    aggregate: { type: 'string', enum: ['sum', 'count', 'avg'] },
    sort: { type: 'string', enum: ['value_desc', 'value_asc', 'label_asc'] },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    unsupportedReason: { type: 'string', description: 'Only when the question cannot be answered with the fields above; then omit every other field. Leave this field out when the plan answers the question.' },
  },
}

/** 取 YYYY-MM-DD；支援 YYYY-MM-DD 與 M/D/YYYY，其他回傳 null。 */
export function isoDate(s: string): string | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return null
}

export interface ResultRow { label: string; value: number; count: number }
export interface PlanResult { rows: ResultRow[]; matched: number; aggregate: Agg; groupBy?: GroupBy; direction: Direction }

/** 白名單執行器：只做篩選、分組、彙總、排序、取前 N，沒有 eval，沒有動態欄位。 */
export function runPlan(plan: QueryPlan, txs: Classified[]): PlanResult {
  const f = plan.filter ?? {}
  const dir: Direction = f.direction ?? 'spend'
  const needle = f.merchantContains?.toUpperCase()
  const matched = txs.filter((t) => {
    if (dir === 'spend' && (t.amount >= 0 || t.category === 'Income' || t.category === 'Transfers')) return false
    if (dir === 'income' && t.amount <= 0) return false
    if (f.categories && (!t.category || !f.categories.includes(t.category))) return false
    if (needle && !t.desc.toUpperCase().includes(needle)) return false
    if (f.dateFrom || f.dateTo) {
      const d = isoDate(t.date)
      if (!d) return false
      if (f.dateFrom && d < f.dateFrom) return false
      if (f.dateTo && d > f.dateTo) return false
    }
    const a = Math.abs(t.amount)
    if (f.amountMin !== undefined && a < f.amountMin) return false
    if (f.amountMax !== undefined && a > f.amountMax) return false
    return true
  })
  const val = (t: Classified) => (dir === 'spend' ? -t.amount : t.amount)
  const groups = new Map<string, Classified[]>()
  for (const t of matched) {
    const k = !plan.groupBy ? 'Total' : plan.groupBy === 'category' ? (t.category ?? 'Unclassified') : plan.groupBy === 'month' ? monthOf(t.date) : normalizeDesc(t.desc)
    groups.set(k, [...(groups.get(k) ?? []), t])
  }
  let rows: ResultRow[] = [...groups].map(([label, g]) => {
    const sum = g.reduce((s, t) => s + val(t), 0)
    const value = plan.aggregate === 'sum' ? sum : plan.aggregate === 'count' ? g.length : sum / g.length
    return { label, value: Math.round(value * 100) / 100, count: g.length }
  })
  if (!plan.groupBy && rows.length === 0) rows = [{ label: 'Total', value: 0, count: 0 }]
  const sort = plan.sort ?? (plan.groupBy === 'month' ? 'label_asc' : 'value_desc')
  rows.sort((a, b) => (sort === 'label_asc' ? a.label.localeCompare(b.label) : sort === 'value_asc' ? a.value - b.value : b.value - a.value))
  if (plan.limit) rows = rows.slice(0, plan.limit)
  return { rows, matched: matched.length, aggregate: plan.aggregate, groupBy: plan.groupBy, direction: dir }
}

// ---- 六種固定查詢樣式（斷網或沒同意時用） ----

export type PatternId = 'top_categories' | 'monthly_spend' | 'top_merchants' | 'category_total' | 'category_average' | 'count_over'

export interface PatternChoice {
  pattern: PatternId
  category?: Category
  amount?: number
  text?: string
}

export const PATTERNS: { id: PatternId; label: string; example: string }[] = [
  { id: 'top_categories', label: 'Top spending categories', example: 'What are my top spending categories?' },
  { id: 'monthly_spend', label: 'Spending per month', example: 'How much do I spend each month?' },
  { id: 'top_merchants', label: 'Top merchants by spending', example: 'Which merchants cost me the most?' },
  { id: 'category_total', label: 'Total spent in one category (or at one named merchant)', example: 'How much did I spend on Groceries?' },
  { id: 'category_average', label: 'Average purchase in one category', example: 'What is my average purchase on Dining?' },
  { id: 'count_over', label: 'Count of purchases above an amount', example: 'How many transactions were over $100?' },
]

export const EXAMPLE_QUESTIONS = PATTERNS.map((p) => p.example)

export function patternToPlan(c: PatternChoice): QueryPlan | null {
  switch (c.pattern) {
    case 'top_categories': return { groupBy: 'category', aggregate: 'sum', sort: 'value_desc', limit: 5 }
    case 'monthly_spend': return { groupBy: 'month', aggregate: 'sum', sort: 'label_asc' }
    case 'top_merchants': return { groupBy: 'merchant', aggregate: 'sum', sort: 'value_desc', limit: 10 }
    case 'category_total':
      if (c.category) return { filter: { categories: [c.category] }, aggregate: 'sum' }
      if (c.text && c.text.trim()) return { filter: { merchantContains: c.text.trim().slice(0, MAX_TEXT) }, aggregate: 'sum' }
      return null
    case 'category_average': return c.category ? { filter: { categories: [c.category] }, aggregate: 'avg' } : null
    case 'count_over': return typeof c.amount === 'number' && c.amount >= 0 ? { filter: { amountMin: c.amount }, aggregate: 'count' } : null
  }
}

const CAT_WORDS: [Category, RegExp][] = [
  ['Groceries', /grocer|supermarket/i], ['Dining', /dining|restaurant|eating out|cafe|coffee/i], ['Delivery', /deliver/i],
  ['Transport', /transport|taxi|rideshare|fuel|gas station|commut/i], ['Utilities', /utilit|electric|water bill|internet/i],
  ['Housing', /housing|rent|mortgage/i], ['Subscriptions', /subscri|streaming|membership/i], ['Shopping', /shopping|retail|clothes|electronics/i],
  ['Health', /health|medical|pharmac|doctor/i], ['Entertainment', /entertain|movie|game|concert/i], ['Travel', /travel|flight|hotel|airline/i],
  ['Income', /income|salary|paycheck|payroll/i], ['Transfers', /transfer/i],
]

/** 沒有裝置端模型時的關鍵字比對；比不到就回 null。 */
export function matchByKeywords(question: string): PatternChoice | null {
  const q = question.trim()
  if (!q) return null
  const over = /(?:over|above|more than|greater than|exceed\w*|>)\s*\$?\s*(\d+(?:\.\d+)?)/i.exec(q)
  if (over && /(how many|count|number of)/i.test(q)) return { pattern: 'count_over', amount: Number(over[1]) }
  if (/(per|each|every|by) month|monthly|month by month/i.test(q)) return { pattern: 'monthly_spend' }
  const cat = CAT_WORDS.find(([, re]) => re.test(q))?.[0]
  if (cat && /average|avg|typical|per purchase/i.test(q)) return { pattern: 'category_average', category: cat }
  if (cat && /(how much|total|spend|spent|cost)/i.test(q)) return { pattern: 'category_total', category: cat }
  if (/merchant|store|shop|where|vendor/i.test(q) && /(most|top|biggest|highest|cost)/i.test(q)) return { pattern: 'top_merchants' }
  if (/categor|most|biggest|top/i.test(q) && !cat) return { pattern: 'top_categories' }
  const at = /\b(?:at|on|to)\s+([A-Za-z0-9&' .-]{2,30})\??$/i.exec(q)
  if (at && /(how much|total|spend|spent)/i.test(q)) return { pattern: 'category_total', text: at[1].trim() }
  return null
}

/** 裝置端選樣式用的結構化輸出（單一 JSON 物件）。 */
export const PATTERN_SCHEMA = {
  type: 'object',
  properties: {
    pattern: { type: 'string', enum: PATTERNS.map((p) => p.id) },
    category: { type: 'string', enum: [...CATEGORIES] },
    amount: { type: 'number' },
    text: { type: 'string' },
  },
  required: ['pattern'],
}

export const PATTERN_SYSTEM = `You route a user's budgeting question to exactly one of six fixed query patterns and fill its parameters.
Patterns:
${PATTERNS.map((p) => `- ${p.id}: ${p.label}`).join('\n')}
Fill "category" only for category_total or category_average, "amount" only for count_over, and "text" (a merchant name) only for category_total when the user names a merchant instead of a category.
Categories: ${CATEGORIES.join(', ')}.`

/** 驗證裝置端回的選擇；不合法回 null。 */
export function validateChoice(x: unknown): PatternChoice | null {
  if (!isObj(x) || typeof x.pattern !== 'string' || !PATTERNS.some((p) => p.id === x.pattern)) return null
  for (const k of Object.keys(x)) if (!['pattern', 'category', 'amount', 'text'].includes(k)) return null
  const c: PatternChoice = { pattern: x.pattern as PatternId }
  if (x.category !== undefined) { if (!isCategory(x.category)) return null; c.category = x.category }
  if (x.amount !== undefined) { if (typeof x.amount !== 'number' || !Number.isFinite(x.amount) || x.amount < 0) return null; c.amount = x.amount }
  if (x.text !== undefined) { if (typeof x.text !== 'string' || x.text.length > MAX_TEXT) return null; c.text = x.text }
  return patternToPlan(c) ? c : null
}
