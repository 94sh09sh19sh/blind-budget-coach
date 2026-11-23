import { describe, expect, it } from 'vitest'
import { EXAMPLE_QUESTIONS, describeChoice, isoDate, matchByKeywords, patternToPlan, runPlan, usesCategory, validateChoice, validatePlan } from './plan'
import { AskSession, MAX_CLOUD_CALLS, describeCloudError, askAdvice, askCloud, askFixed, buildAdviceManifest, buildPlanManifest, categoryShares, limitReached, localDate, validateAdvice } from './cloudtasks'
import appSrc from '../App.tsx?raw'
import type { Classified } from './aggregate'
import type { CloudCall } from './ai'
import type { TimelineEntry } from './router'
import sample60 from '../../public/samples/sample-statement-2.csv?raw'
import { detectSign, guessColumns, parseCsv, toTransactions } from './csv'
import { classifyByRules } from './rules'

const tx = (id: number, date: string, desc: string, amount: number, category: Classified['category']): Classified => ({ id, date, desc, amount, category })
const DATA: Classified[] = [
  tx(1, '2026-01-05', 'CITY FRESH GROCERY #1', -50, 'Groceries'),
  tx(2, '2026-01-20', 'CITY FRESH GROCERY #2', -30, 'Groceries'),
  tx(3, '2026-02-03', 'JOES DINER', -20, 'Dining'),
  tx(4, '2026-02-10', 'JOES DINER', -40, 'Dining'),
  tx(5, '2026-02-15', 'PAYROLL ACME', 1000, 'Income'),
  tx(6, '2026-02-20', 'ONLINE TRANSFER', -200, 'Transfers'),
  tx(7, '2/25/2026', 'MYSTERY SHOP', -10, null),
]

describe('validatePlan', () => {
  it('接受合法計畫', () => {
    const r = validatePlan({ filter: { categories: ['Dining'], dateFrom: '2026-01-01', dateTo: '2026-02-28', amountMin: 5, direction: 'spend' }, groupBy: 'month', aggregate: 'sum', sort: 'label_asc', limit: 5 })
    expect(r.ok).toBe(true)
  })
  const bad: [string, unknown][] = [
    ['非物件', 'drop table'],
    ['陣列', []],
    ['缺 aggregate', { groupBy: 'month' }],
    ['aggregate 不在白名單', { aggregate: 'median' }],
    ['未知頂層欄位', { aggregate: 'sum', sql: 'select 1' }],
    ['未知 filter 欄位', { aggregate: 'sum', filter: { regex: '.*' } }],
    ['groupBy 不合法', { aggregate: 'sum', groupBy: 'day' }],
    ['類別不存在', { aggregate: 'sum', filter: { categories: ['Food'] } }],
    ['類別空陣列', { aggregate: 'sum', filter: { categories: [] } }],
    ['日期格式錯', { aggregate: 'sum', filter: { dateFrom: '1/2/2026' } }],
    ['日期不存在', { aggregate: 'sum', filter: { dateFrom: '2026-02-30' } }],
    ['起訖顛倒', { aggregate: 'sum', filter: { dateFrom: '2026-03-01', dateTo: '2026-01-01' } }],
    ['金額負數', { aggregate: 'sum', filter: { amountMin: -1 } }],
    ['金額上下界顛倒', { aggregate: 'sum', filter: { amountMin: 10, amountMax: 5 } }],
    ['金額不是數字', { aggregate: 'sum', filter: { amountMin: '5' } }],
    ['limit 太大', { aggregate: 'sum', limit: 500 }],
    ['limit 非整數', { aggregate: 'sum', limit: 2.5 }],
    ['sort 不合法', { aggregate: 'sum', sort: 'random' }],
    ['direction 不合法', { aggregate: 'sum', filter: { direction: 'sideways' } }],
    ['merchantContains 空字串', { aggregate: 'sum', filter: { merchantContains: '  ' } }],
    ['merchantContains 太長', { aggregate: 'sum', filter: { merchantContains: 'x'.repeat(41) } }],
  ]
  it.each(bad)('拒絕：%s', (_n, x) => {
    expect(validatePlan(x).ok).toBe(false)
  })
})

describe('runPlan', () => {
  it('預設只算支出，排除收入與轉帳', () => {
    const r = runPlan({ aggregate: 'sum' }, DATA)
    expect(r.rows[0].value).toBe(150) // 50+30+20+40+10
    expect(r.matched).toBe(5)
  })
  it('依類別分組、排序、取前 N', () => {
    const r = runPlan({ groupBy: 'category', aggregate: 'sum', sort: 'value_desc', limit: 2 }, DATA)
    expect(r.rows.map((x) => x.label)).toEqual(['Groceries', 'Dining'])
    expect(r.rows[0].value).toBe(80)
  })
  it('依月份分組，兩種日期格式', () => {
    const r = runPlan({ groupBy: 'month', aggregate: 'sum' }, DATA)
    expect(r.rows.map((x) => [x.label, x.value])).toEqual([['2026-01', 80], ['2026-02', 70]])
  })
  it('日期區間與店家字串', () => {
    expect(runPlan({ filter: { dateFrom: '2026-02-01', dateTo: '2026-02-12' }, aggregate: 'count' }, DATA).rows[0].value).toBe(2)
    expect(runPlan({ filter: { merchantContains: 'joes' }, aggregate: 'sum' }, DATA).rows[0].value).toBe(60)
  })
  it('金額區間用絕對值，avg 與 count', () => {
    expect(runPlan({ filter: { amountMin: 30 }, aggregate: 'count' }, DATA).rows[0].value).toBe(3)
    expect(runPlan({ filter: { categories: ['Dining'] }, aggregate: 'avg' }, DATA).rows[0].value).toBe(30)
  })
  it('direction income 與 all', () => {
    expect(runPlan({ filter: { direction: 'income' }, aggregate: 'sum' }, DATA).rows[0].value).toBe(1000)
    expect(runPlan({ filter: { direction: 'all' }, aggregate: 'count' }, DATA).rows[0].value).toBe(7)
  })
  it('計畫點名 Income 或 Transfers 時才算進去；只點名 Income 且沒寫方向時算收入', () => {
    expect(runPlan({ filter: { categories: ['Income'] }, aggregate: 'sum' }, DATA).rows[0]).toEqual({ label: 'Total', value: 1000, count: 1 })
    expect(runPlan({ filter: { categories: ['Transfers'] }, aggregate: 'sum' }, DATA).rows[0]).toEqual({ label: 'Total', value: 200, count: 1 })
    // 明寫 spend 時照字面：收入是正數，不算
    expect(runPlan({ filter: { categories: ['Income'], direction: 'spend' }, aggregate: 'sum' }, DATA).rows[0].count).toBe(0)
    // 沒點名時照舊排除收入與轉帳
    expect(runPlan({ filter: { categories: ['Dining', 'Transfers'] }, aggregate: 'sum' }, DATA).rows[0].value).toBe(260)
    expect(runPlan({ groupBy: 'category', aggregate: 'sum' }, DATA).rows.map((r) => r.label)).not.toContain('Transfers')
  })
  it('固定樣式的 Income 帶 direction income', () => {
    expect(patternToPlan({ pattern: 'category_total', category: 'Income' })).toEqual({ filter: { categories: ['Income'], direction: 'income' }, aggregate: 'sum' })
    expect(patternToPlan({ pattern: 'category_average', category: 'Income' })).toEqual({ filter: { categories: ['Income'], direction: 'income' }, aggregate: 'avg' })
    expect(patternToPlan({ pattern: 'category_total', category: 'Groceries' })).toEqual({ filter: { categories: ['Groceries'] }, aggregate: 'sum' })
  })
  it('沒有符合的列回 0', () => {
    expect(runPlan({ filter: { merchantContains: 'zzz' }, aggregate: 'sum' }, DATA).rows).toEqual([{ label: 'Total', value: 0, count: 0 }])
  })
  it('isoDate', () => {
    expect(isoDate('2/5/2026')).toBe('2026-02-05')
    expect(isoDate('foo')).toBeNull()
  })
})

describe('問收入與轉帳（60 筆範例，規則分類）', () => {
  const p = parseCsv(sample60)
  const cols = guessColumns(p.headers)
  const data: Classified[] = toTransactions(p, cols, detectSign(p, cols)).map((t) => ({ ...t, category: classifyByRules(t.desc) }))
  const ask = (q: string) => runPlan(patternToPlan(matchByKeywords(q)!)!, data).rows[0]
  it('固定樣式：收入是兩筆薪資合計 4,577.49', () => {
    expect(ask('How much income did I get?')).toEqual({ label: 'Total', value: 4577.49, count: 2 })
    expect(ask('What is my total salary?')).toEqual({ label: 'Total', value: 4577.49, count: 2 })
  })
  it('固定樣式：轉出的轉帳合計', () => {
    expect(ask('How much did I transfer?')).toEqual({ label: 'Total', value: 1366.32, count: 3 })
  })
  it('雲端計畫只寫 categories: ["Income"]、沒寫 direction：同樣是 4,577.49', () => {
    expect(runPlan({ filter: { categories: ['Income'] }, aggregate: 'sum' }, data).rows[0]).toEqual({ label: 'Total', value: 4577.49, count: 2 })
  })
})

describe('固定樣式', () => {
  it('六個範例問題都能用關鍵字比對並產生合法計畫', () => {
    expect(EXAMPLE_QUESTIONS).toHaveLength(6)
    for (const q of EXAMPLE_QUESTIONS) {
      const c = matchByKeywords(q)
      expect(c, q).not.toBeNull()
      const plan = patternToPlan(c!)
      expect(plan, q).not.toBeNull()
      expect(validatePlan(plan).ok, q).toBe(true)
    }
  })
  it('範例問題各自對到不同樣式', () => {
    expect(new Set(EXAMPLE_QUESTIONS.map((q) => matchByKeywords(q)!.pattern)).size).toBe(6)
  })
  it('關鍵字比對：金額、店家名稱、比不到', () => {
    expect(matchByKeywords('how many purchases were above $250.50?')).toEqual({ pattern: 'count_over', amount: 250.5 })
    expect(matchByKeywords('How much did I spend at Joes Diner?')).toEqual({ pattern: 'category_total', text: 'Joes Diner' })
    expect(matchByKeywords('tell me a joke')).toBeNull()
    expect(matchByKeywords('')).toBeNull()
  })
  it('validateChoice 拒絕不合法的選擇', () => {
    expect(validateChoice({ pattern: 'category_total', category: 'Dining' })).not.toBeNull()
    expect(validateChoice({ pattern: 'category_total' })).toBeNull() // 缺參數
    expect(validateChoice({ pattern: 'drop_all' })).toBeNull()
    expect(validateChoice({ pattern: 'count_over', amount: -5 })).toBeNull()
    expect(validateChoice({ pattern: 'top_categories', extra: 1 })).toBeNull()
    expect(validateChoice('top_categories')).toBeNull()
  })
})

function mkDeps(over: Partial<Parameters<typeof askCloud>[1]> = {}) {
  const logs: Omit<TimelineEntry, 'id' | 'at'>[] = []
  return { logs, deps: { log: (e: Omit<TimelineEntry, 'id' | 'at'>) => { logs.push(e) }, now: () => 0, ...over } }
}
const GOOD = JSON.stringify({ groupBy: 'category', aggregate: 'sum', limit: 3 })
const QUESTION = 'Which categories cost me the most last month?'
const COLS = [{ name: 'Date', type: 'date' as const }, { name: 'Description', type: 'text' as const }, { name: 'Amount', type: 'number' as const }]

describe('出境清單', () => {
  const m = buildPlanManifest(QUESTION, COLS, '2026-11-12', 60)
  it('只含問題、欄位名稱與型別、類別清單、今天日期', () => {
    expect(m.prompt).toContain('Today: 2026-11-12')
    expect(m.prompt).toContain('Date (date), Description (text), Amount (number)')
    expect(m.prompt).toContain('Groceries')
    expect(m.prompt).toContain(QUESTION)
    expect(m.notIncluded).toBe('Not included: 60 transactions, merchants, dates, amounts')
  })
  it('位元組數是 UTF-8 長度', () => {
    expect(m.bytes).toBe(new TextEncoder().encode(m.system + m.prompt + JSON.stringify(m.schema)).length)
    const z = buildPlanManifest('咖啡花了多少', COLS, '2026-11-12', 1)
    expect(z.bytes).toBeGreaterThan((z.system + z.prompt).length)
  })
  it('預算建議只含整數百分比', () => {
    const shares = categoryShares({ Groceries: 80, Dining: 60, Shopping: 10 })
    expect(Object.values(shares).reduce((a, b) => a + b, 0)).toBe(100)
    const a = buildAdviceManifest(shares, 7)
    expect(a.mode).toBe('ONLY_IN_CLOUD')
    expect(a.prompt).toMatch(/Groceries: 53%/)
    expect(a.prompt).not.toMatch(/\d\.\d/)
  })
})

describe('雲端錯誤說明', () => {
  it('不回傳原始例外字串', () => {
    expect(describeCloudError(new Error('429 RESOURCE_EXHAUSTED key=SECRET'))).toBe('the free daily or per-minute limit was reached')
    expect(describeCloudError(new Error('App Check token invalid (403)'))).toContain('App Check')
    expect(describeCloudError(new Error('weird SECRET text'))).toBe('an unexpected error')
  })
  it('SDK 的 HTTP 錯誤依狀態碼分開，不一律說成網路失敗', () => {
    const sdk = (status: string, msg: string) => new Error(`Error fetching from https://firebasevertexai.googleapis.com/v1beta/projects/p/models/m:generateContent: [${status}] ${msg}`)
    expect(describeCloudError(sdk('503 Service Unavailable', 'The model is overloaded.'))).toBe('the cloud service returned a server error')
    expect(describeCloudError(sdk('500 Internal Server Error', 'x'))).toBe('the cloud service returned a server error')
    expect(describeCloudError(sdk('400 Bad Request', 'Invalid JSON payload'))).toBe('the cloud service rejected the request as invalid')
    expect(describeCloudError(sdk('429 Too Many Requests', 'quota'))).toBe('the free daily or per-minute limit was reached')
    expect(describeCloudError(sdk('403 Forbidden', 'App Check token is invalid'))).toBe('the request was refused (App Check or API key problem)')
    expect(describeCloudError(sdk('400 Bad Request', 'API key not valid'))).toBe('the request was refused (App Check or API key problem)')
    expect(describeCloudError(new TypeError('Failed to fetch'))).toBe('the network request failed')
  })
  it('失敗時使用者看到的訊息不含原始字串', async () => {
    const cloud: CloudCall = async () => { throw new Error('403 key=SECRET') }
    const { deps, logs } = mkDeps({ cloud })
    const q = 'top spending categories'
    const r = await askCloud(new AskSession(), deps, q, buildPlanManifest(q, COLS, '2026-11-12', 60))
    expect(r.note).not.toContain('SECRET')
    expect(logs[0].reason).not.toContain('SECRET')
  })
})

describe('超出能力範圍', () => {
  it('只有 unsupportedReason：驗證通過且不帶計畫', () => {
    const r = validatePlan({ unsupportedReason: 'needs two periods compared' })
    expect(r).toEqual({ ok: true, unsupported: 'needs two periods compared' })
  })
  it('空字串、只有空白、null 的 unsupportedReason 當成沒有這個欄位：合法計畫照常通過', () => {
    const plan = { groupBy: 'month', aggregate: 'sum', sort: 'label_asc', limit: 50 }
    const expected = validatePlan(plan)
    expect(expected.ok).toBe(true)
    for (const empty of ['', '   ', '\n\t', null]) {
      const r = validatePlan({ ...plan, unsupportedReason: empty })
      expect(r).toEqual(expected)
      expect(r.ok && r.plan && 'unsupportedReason' in r.plan).toBe(false)
    }
  })
  it('空欄位不放寬其他檢查：未知鍵、不合法的值仍然被拒', () => {
    expect(validatePlan({ aggregate: 'sum', unsupportedReason: '', foo: 1 }).ok).toBe(false)
    expect(validatePlan({ aggregate: 'median', unsupportedReason: null }).ok).toBe(false)
    expect(validatePlan({ aggregate: 'sum', limit: 99, unsupportedReason: ' ' }).ok).toBe(false)
    expect(validatePlan({ groupBy: 'month', unsupportedReason: '' }).ok).toBe(false)
  })
  it('只剩空的 unsupportedReason、沒有計畫：被拒，且說明沒有計畫', () => {
    for (const empty of ['', '  ', null]) {
      const r = validatePlan({ unsupportedReason: empty })
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toContain('no plan')
    }
  })
  it('有內容的 unsupportedReason 加其他計畫欄位：被拒（不用模型自己說做不到的題目的近似計畫硬答）', () => {
    // 2026-11-13 公開網址實測看到的回應形狀：合法計畫加一句互相矛盾的理由
    const seen = {
      groupBy: 'month', aggregate: 'sum', sort: 'label_asc', limit: 50,
      unsupportedReason: 'Cannot group by month and sort by label or return full time series directly with this exact structure without aggregate.',
    }
    const r = validatePlan(seen)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('both an unsupportedReason and plan fields')
    expect(validatePlan({ unsupportedReason: 'x', aggregate: 'sum' }).ok).toBe(false)
    expect(validatePlan({ unsupportedReason: 'x', filter: {} }).ok).toBe(false)
  })
  it('unsupportedReason 不是字串、或超過 300 字：被拒', () => {
    for (const bad of [5, true, {}, [], ['x']]) expect(validatePlan({ unsupportedReason: bad }).ok).toBe(false)
    expect(validatePlan({ unsupportedReason: 'x'.repeat(301) }).ok).toBe(false)
    expect(validatePlan({ unsupportedReason: 'x'.repeat(300) }).ok).toBe(true)
  })
  it('有內容的 unsupportedReason 前後空白會去掉', () => {
    expect(validatePlan({ unsupportedReason: '  needs two periods  ' })).toEqual({ ok: true, unsupported: 'needs two periods' })
  })
  it('雲端回「計畫加空的 unsupportedReason」：一次就採用，只呼叫一次', async () => {
    const text = JSON.stringify({ groupBy: 'month', aggregate: 'sum', sort: 'label_asc', unsupportedReason: '' })
    const cloud: CloudCall = async () => ({ text, source: 'cloud' })
    const { deps, logs } = mkDeps({ cloud })
    const s = new AskSession()
    const q = 'How much do I spend each month?'
    const r = await askCloud(s, deps, q, buildPlanManifest(q, COLS, '2026-11-13', 60))
    expect(s.cloudCalls).toBe(1)
    expect(r.source).toBe('cloud')
    expect(r.plan).toEqual({ groupBy: 'month', aggregate: 'sum', sort: 'label_asc' })
    expect(logs).toHaveLength(1)
    expect(logs[0].reason).toBe('Plan accepted.')
  })
  it('雲端回「計畫加有內容的 unsupportedReason」：第一次被拒並重試；第二次乾淨就採用', async () => {
    const mixed = JSON.stringify({ groupBy: 'month', aggregate: 'sum', sort: 'label_asc', limit: 50, unsupportedReason: 'Cannot do this.' })
    const clean = JSON.stringify({ groupBy: 'month', aggregate: 'sum', sort: 'label_asc', limit: 50 })
    let n = 0
    const cloud: CloudCall = async () => ({ text: n++ === 0 ? mixed : clean, source: 'cloud' })
    const { deps, logs } = mkDeps({ cloud })
    const s = new AskSession()
    const q = 'How much do I spend each month?'
    const r = await askCloud(s, deps, q, buildPlanManifest(q, COLS, '2026-11-13', 60))
    expect(s.cloudCalls).toBe(2)
    expect(r.source).toBe('cloud')
    expect(r.plan).not.toBeNull()
    expect(logs[0].reason).toContain('Plan rejected')
    expect(logs[0].reason).toContain('both an unsupportedReason and plan fields')
    expect(logs[1].reason).toBe('Plan accepted.')
  })
  it('系統提示與回應結構都說明：能回答時不要輸出 unsupportedReason', () => {
    const m = buildPlanManifest('x', COLS, '2026-11-13', 1)
    expect(m.system).toContain('leave out unsupportedReason entirely')
    expect(m.system).toContain('Do not combine unsupportedReason with plan fields')
    expect(JSON.stringify(m.schema)).toContain('Leave this field out when the plan answers the question')
  })
  it('雲端回報超出能力：不退回固定樣式，不給數字', async () => {
    const cloud: CloudCall = async () => ({ text: '{"unsupportedReason":"It compares two years."}', source: 'cloud' })
    const { deps } = mkDeps({ cloud, deviceChoose: async () => JSON.stringify({ pattern: 'monthly_spend' }) })
    const q = 'compare this year to last year'
    const r = await askCloud(new AskSession(), deps, q, buildPlanManifest(q, COLS, '2026-11-12', 60))
    expect(r.plan).toBeNull()
    expect(r.unsupported).toBe(true)
    expect(r.note).toContain('It compares two years.')
  })
})

describe('askCloud', () => {
  const m = buildPlanManifest(QUESTION, COLS, '2026-11-12', 60)
  it('合法回應：採用、記入時間線與位元組', async () => {
    const cloud: CloudCall = async () => ({ text: GOOD, source: 'cloud' })
    const { deps, logs } = mkDeps({ cloud })
    const r = await askCloud(new AskSession(), deps, QUESTION, m)
    expect(r.source).toBe('cloud')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ mode: 'PREFER_IN_CLOUD', side: 'cloud', bytesSent: m.bytes })
  })
  it('第一次不合法、第二次合法：重試一次', async () => {
    let n = 0
    const cloud: CloudCall = async () => ({ text: n++ === 0 ? '{"aggregate":"median"}' : GOOD, source: 'cloud' })
    const { deps, logs } = mkDeps({ cloud })
    const s = new AskSession()
    const r = await askCloud(s, deps, QUESTION, m)
    expect(r.source).toBe('cloud')
    expect(s.cloudCalls).toBe(2)
    expect(logs).toHaveLength(2)
  })
  it('兩次都不合法：改用固定樣式（關鍵字）', async () => {
    const cloud: CloudCall = async () => ({ text: 'not json', source: 'cloud' })
    const { deps } = mkDeps({ cloud })
    const s = new AskSession()
    const r = await askCloud(s, deps, 'what are my top spending categories?', buildPlanManifest('what are my top spending categories?', COLS, '2026-11-12', 60))
    expect(s.cloudCalls).toBe(2)
    expect(r.source).toBe('rules')
    expect(r.plan).not.toBeNull()
  })
  it('雲端丟錯：不重試，改用固定樣式；裝置端模型有就用它', async () => {
    const cloud: CloudCall = async () => { throw new Error('offline') }
    const { deps, logs } = mkDeps({ cloud, deviceChoose: async () => JSON.stringify({ pattern: 'monthly_spend' }) })
    const s = new AskSession()
    const r = await askCloud(s, deps, QUESTION, m)
    expect(s.cloudCalls).toBe(1)
    expect(r.source).toBe('device')
    expect(logs.map((l) => l.mode)).toEqual(['PREFER_IN_CLOUD', 'ONLY_ON_DEVICE'])
  })
  it('同一問題快取：第二次不再呼叫', async () => {
    let n = 0
    const cloud: CloudCall = async () => { n++; return { text: GOOD, source: 'cloud' } }
    const { deps } = mkDeps({ cloud })
    const s = new AskSession()
    await askCloud(s, deps, QUESTION, m)
    const r = await askCloud(s, deps, '  which categories cost me the most last MONTH? ', m)
    expect(n).toBe(1)
    expect(r.cached).toBe(true)
  })
  it('每階段上限 10 次，超過就用固定樣式', async () => {
    const cloud: CloudCall = async () => ({ text: GOOD, source: 'cloud' })
    const { deps } = mkDeps({ cloud })
    const s = new AskSession()
    for (let i = 0; i < MAX_CLOUD_CALLS; i++) await askCloud(s, deps, `question number ${i} top categories`, m)
    expect(s.cloudCalls).toBe(10)
    const r = await askCloud(s, deps, 'one more top categories please', m)
    expect(s.cloudCalls).toBe(10)
    expect(r.source).toBe('rules')
    expect(r.note).toMatch(/limit/)
  })
  it('上限的說明寫「每次載入頁面」；預算建議到上限也回同一句', async () => {
    const cloud: CloudCall = async () => ({ text: GOOD, source: 'cloud' })
    const { deps } = mkDeps({ cloud })
    const s = new AskSession()
    expect(limitReached(s)).toBe(false)
    s.cloudCalls = MAX_CLOUD_CALLS
    expect(limitReached(s)).toBe(true)
    const r = await askCloud(s, deps, 'top categories please', m)
    expect(r.note).toBe('Fixed pattern chosen by keywords: top spending categories. The limit of 10 cloud calls per page load was reached; using a fixed pattern.')
    expect(await askAdvice(s, deps, buildAdviceManifest({ Groceries: 60, Dining: 40 }, 10))).toEqual({ ok: false, error: 'The limit of 10 cloud calls per page load was reached.' })
  })
  it('App.tsx：到上限時不開出境清單、預算建議按鈕停用並寫原因', () => {
    expect(appSrc).toContain("if (cloudOk && !session.current.cache.has(AskSession.key(q)) && !atLimit) {")
    expect(appSrc).toContain('disabled={!ready || !cloudOk || askBusy || limitHit} onClick={prepareAdvice}>Review what would be sent</button>')
    expect(appSrc).toContain('{ready && cloudOk && limitHit && <p className="fine">{limitText}</p>}')
    expect(appSrc).toContain("const limitText = `${cloudLimitReason(MAX_CLOUD_CALLS)}. Reloading the page starts a new count.`")
  })
  it('雲端一直沒回應：到等待上限就當作失敗，改用固定樣式，不重試', async () => {
    const cloud: CloudCall = () => new Promise(() => {})
    const { deps, logs } = mkDeps({ cloud, timeoutMs: 10 })
    const s = new AskSession()
    const q = 'what are my top spending categories?'
    const r = await askCloud(s, deps, q, buildPlanManifest(q, COLS, '2026-11-12', 60))
    expect(s.cloudCalls).toBe(1)
    expect(r.source).toBe('rules')
    expect(r.plan).not.toBeNull()
    expect(r.note).toContain('no response within the time limit')
    expect(logs[0].reason).toContain('no response within the time limit')
  })
  it('沒有雲端函式：直接固定樣式', async () => {
    const { deps, logs } = mkDeps()
    const r = await askCloud(new AskSession(), deps, EXAMPLE_QUESTIONS[0], m)
    expect(r.source).toBe('rules')
    expect(logs.every((l) => l.bytesSent === 0)).toBe(true)
  })
  it('askFixed 比不到時回 none', async () => {
    const { deps } = mkDeps()
    const r = await askFixed(new AskSession(), deps, 'tell me a joke', 'x')
    expect(r.plan).toBeNull()
    expect(r.source).toBe('none')
  })
})

describe('usesCategory：答案有沒有用到類別', () => {
  it('只有 category_total 與 category_average 帶類別才算', () => {
    expect(usesCategory({ pattern: 'category_total', category: 'Income' })).toBe(true)
    expect(usesCategory({ pattern: 'category_average', category: 'Dining' })).toBe(true)
  })
  it('沒帶類別、只有商家文字、或是不用類別的樣式（即使多填了 category）都不算', () => {
    expect(usesCategory({ pattern: 'category_total', text: 'Joes Diner' })).toBe(false)
    expect(usesCategory({ pattern: 'monthly_spend' })).toBe(false)
    expect(usesCategory({ pattern: 'monthly_spend', category: 'Income' })).toBe(false)
    expect(usesCategory({ pattern: 'top_categories', category: 'Transfers' })).toBe(false)
    expect(usesCategory({ pattern: 'top_merchants', category: 'Dining' })).toBe(false)
    expect(usesCategory({ pattern: 'count_over', amount: 100, category: 'Dining' })).toBe(false)
  })
})

describe('describeChoice：說明這個選擇答的是什麼', () => {
  it('不帶參數的三個樣式', () => {
    expect(describeChoice({ pattern: 'top_categories' })).toBe('top spending categories')
    expect(describeChoice({ pattern: 'monthly_spend' })).toBe('spending per month')
    expect(describeChoice({ pattern: 'top_merchants' })).toBe('top merchants by spending')
  })
  it('category_total：Income、Transfers、其他類別', () => {
    expect(describeChoice({ pattern: 'category_total', category: 'Income' })).toBe('total income')
    expect(describeChoice({ pattern: 'category_total', category: 'Transfers' })).toBe('total in Transfers')
    expect(describeChoice({ pattern: 'category_total', category: 'Groceries' })).toBe('total spent on Groceries')
  })
  it('category_total：用商家文字時加引號；有類別時以類別為準（與 patternToPlan 一致）', () => {
    expect(describeChoice({ pattern: 'category_total', text: 'Joes Diner' })).toBe('total spent at "Joes Diner"')
    expect(describeChoice({ pattern: 'category_total', text: '  Joes Diner ' })).toBe('total spent at "Joes Diner"')
    expect(describeChoice({ pattern: 'category_total', category: 'Dining', text: 'Joes Diner' })).toBe('total spent on Dining')
  })
  it('category_average 與 count_over', () => {
    expect(describeChoice({ pattern: 'category_average', category: 'Dining' })).toBe('average purchase in Dining')
    expect(describeChoice({ pattern: 'count_over', amount: 100 })).toBe('purchases over 100')
    expect(describeChoice({ pattern: 'count_over', amount: 250.5 })).toBe('purchases over 250.5')
  })
  it('缺參數的選擇（validateChoice 不會放行，只是不丟錯）', () => {
    expect(describeChoice({ pattern: 'category_total' })).toBe('total spent')
    expect(describeChoice({ pattern: 'category_average' })).toBe('average purchase')
    expect(describeChoice({ pattern: 'count_over' })).toBe('purchases over an amount')
  })
  it('六個範例問題的關鍵字選擇各有不同的說明', () => {
    expect(EXAMPLE_QUESTIONS.map((q) => describeChoice(matchByKeywords(q)!))).toEqual([
      'top spending categories', 'spending per month', 'top merchants by spending', 'total spent on Groceries', 'average purchase in Dining', 'purchases over 100',
    ])
  })
})

describe('askFixed：說明列寫出樣式；模型選的樣式沒帶類別、問題卻有類別字眼時改用關鍵字', () => {
  const p = parseCsv(sample60)
  const cols = guessColumns(p.headers)
  const data: Classified[] = toTransactions(p, cols, detectSign(p, cols)).map((t) => ({ ...t, category: classifyByRules(t.desc) }))
  const WHY = 'You chose not to send anything; using a fixed pattern.'
  const ask = (q: string, device?: object | string) => {
    const { deps, logs } = mkDeps(device === undefined ? {} : { deviceChoose: async () => (typeof device === 'string' ? device : JSON.stringify(device)) })
    return askFixed(new AskSession(), deps, q, WHY).then((out) => ({ out, logs }))
  }

  it('沒有裝置端模型：關鍵字選的，說明列寫出樣式', async () => {
    const { out, logs } = await ask('How much income did I get?')
    expect(out.source).toBe('rules')
    expect(out.note).toBe(`Fixed pattern chosen by keywords: total income. ${WHY}`)
    expect(runPlan(out.plan!, data).rows).toEqual([{ label: 'Total', value: 4577.49, count: 2 }])
    expect(logs.map((l) => [l.mode, l.side, l.reason])).toEqual([['LOCAL_RULES', 'rules', WHY]])
  })
  for (const q of ['How much income did I get?', 'What is my total income?', 'How much salary did I receive?']) {
    it(`模型選 monthly_spend、問題是「${q}」：改用關鍵字，記兩列時間線`, async () => {
      const { out, logs } = await ask(q, { pattern: 'monthly_spend' })
      expect(out.source).toBe('rules')
      expect(out.cached).toBe(false)
      expect(out.note).toBe(`Fixed pattern chosen by keywords: total income. The question names Income and the on-device model picked a pattern without a category. ${WHY}`)
      expect(runPlan(out.plan!, data).rows).toEqual([{ label: 'Total', value: 4577.49, count: 2 }])
      // 模型確實被呼叫了，那一列照原樣記；再多一列本機規則
      expect(logs).toEqual([
        { task: 'blind analysis: pick fixed pattern', mode: 'ONLY_ON_DEVICE', side: 'device', ms: 0, bytesSent: 0, reason: WHY },
        { task: 'blind analysis: keyword match', mode: 'LOCAL_RULES', side: 'rules', ms: 0, bytesSent: 0, reason: 'The question names Income; the on-device pick (spending per month) has no category.' },
      ])
    })
  }
  it('模型選 monthly_spend 卻順手填了 category: Income（本機實測模型常這樣回）：樣式不用類別，照樣改用關鍵字', async () => {
    const { out, logs } = await ask('How much income did I get?', '{"pattern": "monthly_spend", "category": "Income", "amount": 0, "text": ""}')
    expect(out.source).toBe('rules')
    expect(out.note).toBe(`Fixed pattern chosen by keywords: total income. The question names Income and the on-device model picked a pattern without a category. ${WHY}`)
    expect(runPlan(out.plan!, data).rows).toEqual([{ label: 'Total', value: 4577.49, count: 2 }])
    expect(logs.map((l) => `${l.mode}/${l.side}`)).toEqual(['ONLY_ON_DEVICE/device', 'LOCAL_RULES/rules'])
    expect(logs[1].reason).toBe('The question names Income; the on-device pick (spending per month) has no category.')
  })
  it('模型選 monthly_spend 並把類別填錯（問轉帳卻填 Income）：照樣改用關鍵字的 Transfers', async () => {
    const { out } = await ask('How much did I transfer?', { pattern: 'monthly_spend', category: 'Income', amount: 0, text: '' })
    expect(out.source).toBe('rules')
    expect(out.note).toContain('Fixed pattern chosen by keywords: total in Transfers.')
    expect(runPlan(out.plan!, data).rows).toEqual([{ label: 'Total', value: 1366.32, count: 3 }])
  })
  it('模型選 top_categories、問轉帳：改用關鍵字，Transfers 合計 1,366.32', async () => {
    const { out, logs } = await ask('How much did I transfer?', { pattern: 'top_categories' })
    expect(out.source).toBe('rules')
    expect(out.note).toContain('Fixed pattern chosen by keywords: total in Transfers. The question names Transfers')
    expect(runPlan(out.plan!, data).rows).toEqual([{ label: 'Total', value: 1366.32, count: 3 }])
    expect(logs[1].reason).toBe('The question names Transfers; the on-device pick (top spending categories) has no category.')
  })
  it('模型的選擇用到的類別與問題點名的不同（問轉帳卻選 category_total 加 Income）：改用關鍵字，記兩列時間線', async () => {
    const { out, logs } = await ask('How much did I transfer?', { pattern: 'category_total', category: 'Income' })
    expect(out.source).toBe('rules')
    expect(out.cached).toBe(false)
    expect(out.note).toBe(`Fixed pattern chosen by keywords: total in Transfers. The question names Transfers and the on-device model picked total income. ${WHY}`)
    expect(runPlan(out.plan!, data).rows).toEqual([{ label: 'Total', value: 1366.32, count: 3 }])
    expect(logs).toEqual([
      { task: 'blind analysis: pick fixed pattern', mode: 'ONLY_ON_DEVICE', side: 'device', ms: 0, bytesSent: 0, reason: WHY },
      { task: 'blind analysis: keyword match', mode: 'LOCAL_RULES', side: 'rules', ms: 0, bytesSent: 0, reason: 'The question names Transfers; the on-device pick was total income.' },
    ])
  })
  it('模型選的類別與問題點名的不同：category_average 與其他類別也一樣', async () => {
    const { out } = await ask('How much income did I get?', { pattern: 'category_total', category: 'Dining' })
    expect(out.source).toBe('rules')
    expect(out.note).toBe(`Fixed pattern chosen by keywords: total income. The question names Income and the on-device model picked total spent on Dining. ${WHY}`)
    const avg = await ask('What is my average purchase on Dining?', { pattern: 'category_average', category: 'Groceries' })
    expect(avg.out.source).toBe('rules')
    expect(avg.out.note).toBe(`Fixed pattern chosen by keywords: average purchase in Dining. The question names Dining and the on-device model picked average purchase in Groceries. ${WHY}`)
  })
  it('模型的選擇帶類別、與問題點名的類別相同：照模型的，不覆蓋', async () => {
    const { out, logs } = await ask('How much income did I get?', { pattern: 'category_total', category: 'Income' })
    expect(out.source).toBe('device')
    expect(out.note).toBe(`Fixed pattern chosen on device: total income. ${WHY}`)
    expect(runPlan(out.plan!, data).rows).toEqual([{ label: 'Total', value: 4577.49, count: 2 }])
    expect(logs.map((l) => l.side)).toEqual(['device'])
  })
  it('模型沒帶類別、問題也沒有類別字眼：照模型的', async () => {
    const { out, logs } = await ask('How much do I spend each month?', { pattern: 'monthly_spend' })
    expect(out.source).toBe('device')
    expect(out.note).toBe(`Fixed pattern chosen on device: spending per month. ${WHY}`)
    expect(logs.map((l) => l.side)).toEqual(['device'])
  })
  it('模型用商家文字、關鍵字也只比到商家文字（沒有類別）：照模型的', async () => {
    const { out } = await ask('How much did I spend at Joes Diner?', { pattern: 'category_total', text: 'Joes Diner' })
    expect(out.source).toBe('device')
    expect(out.note).toBe(`Fixed pattern chosen on device: total spent at "Joes Diner". ${WHY}`)
  })
  it('模型沒帶類別、關鍵字比不到：照模型的', async () => {
    const { out, logs } = await ask('What did I buy on my birthday?', { pattern: 'top_merchants' })
    expect(out.source).toBe('device')
    expect(out.note).toBe(`Fixed pattern chosen on device: top merchants by spending. ${WHY}`)
    expect(logs.map((l) => l.side)).toEqual(['device'])
  })
  it('模型回的不是合法選擇：退回關鍵字，說明列也寫出樣式', async () => {
    const { out, logs } = await ask('How much income did I get?', 'not json')
    expect(out.source).toBe('rules')
    expect(out.note).toBe(`Fixed pattern chosen by keywords: total income. ${WHY}`)
    expect(logs.map((l) => l.side)).toEqual(['device', 'rules'])
    expect(logs[1].reason).toBe(WHY)
  })
  it('改用關鍵字的結果進固定樣式快取：同一題再問回傳同一句說明並標示已快取', async () => {
    const { deps } = mkDeps({ deviceChoose: async () => JSON.stringify({ pattern: 'monthly_spend' }) })
    const s = new AskSession()
    const first = await askFixed(s, deps, 'How much income did I get?', WHY)
    const second = await askFixed(s, deps, 'how much income did I get?', WHY)
    expect(second.cached).toBe(true)
    expect(second.note).toBe(first.note)
    expect(second.source).toBe('rules')
  })
  it('雲端失敗退回固定樣式時也一樣：裝置端選了沒類別的樣式、問題有類別，就改用關鍵字', async () => {
    const cloud: CloudCall = async () => { throw new Error('offline') }
    const { deps, logs } = mkDeps({ cloud, deviceChoose: async () => JSON.stringify({ pattern: 'monthly_spend' }) })
    const q = 'How much income did I get?'
    const r = await askCloud(new AskSession(), deps, q, buildPlanManifest(q, COLS, '2026-11-23', 60))
    expect(r.source).toBe('rules')
    expect(r.note).toContain('Fixed pattern chosen by keywords: total income. The question names Income')
    expect(r.note).toContain('The cloud call failed')
    expect(logs.map((l) => `${l.mode}/${l.side}`)).toEqual(['PREFER_IN_CLOUD/cloud', 'ONLY_ON_DEVICE/device', 'LOCAL_RULES/rules'])
  })
})

describe('askAdvice', () => {
  const tips = { tips: [1, 2, 3].map((i) => ({ title: `T${i}`, detail: `D${i}` })) }
  const m = buildAdviceManifest({ Groceries: 60, Dining: 40 }, 10)
  it('合法回應', async () => {
    const { deps, logs } = mkDeps({ cloud: async () => ({ text: JSON.stringify(tips), source: 'cloud' }) })
    const r = await askAdvice(new AskSession(), deps, m)
    expect(r.ok).toBe(true)
    expect(logs[0]).toMatchObject({ mode: 'ONLY_IN_CLOUD', bytesSent: m.bytes })
  })
  it('驗證失敗重試一次後回錯', async () => {
    const { deps } = mkDeps({ cloud: async () => ({ text: '{"tips":[]}', source: 'cloud' }) })
    const s = new AskSession()
    const r = await askAdvice(s, deps, m)
    expect(r.ok).toBe(false)
    expect(s.cloudCalls).toBe(2)
  })
  it('雲端一直沒回應：到等待上限回錯', async () => {
    const { deps } = mkDeps({ cloud: () => new Promise(() => {}), timeoutMs: 10 })
    const r = await askAdvice(new AskSession(), deps, m)
    expect(r).toEqual({ ok: false, error: 'The cloud call failed: no response within the time limit.' })
  })
  it('沒有雲端函式：停用', async () => {
    const { deps } = mkDeps()
    expect((await askAdvice(new AskSession(), deps, m)).ok).toBe(false)
  })
  it('validateAdvice 只收剛好三條', () => {
    expect(validateAdvice(tips)).not.toBeNull()
    expect(validateAdvice({ tips: tips.tips.slice(0, 2) })).toBeNull()
    expect(validateAdvice({ tips: [{ title: 1, detail: 'x' }, ...tips.tips.slice(0, 2)] })).toBeNull()
  })
})

import { CLOUD_CONFIGURED, PLACEHOLDER, firebaseConfig, isPlaceholderConfig } from '../firebase'
import { firebaseCloudCall } from './ai'

describe('雲端設定判斷', () => {
  it('佔位值或空值都視為未設定', () => {
    expect(isPlaceholderConfig(firebaseConfig)).toBe(true)
    expect(isPlaceholderConfig({ a: 'x', b: PLACEHOLDER })).toBe(true)
    expect(isPlaceholderConfig({ a: 'x', b: '' })).toBe(true)
    expect(isPlaceholderConfig({ a: 'x', b: 'y' })).toBe(false)
  })
  it('佔位設定下真的雲端呼叫直接丟錯，不送請求', async () => {
    expect(CLOUD_CONFIGURED).toBe(false)
    await expect(firebaseCloudCall({ mode: 'ONLY_IN_CLOUD', system: 's', prompt: 'p', schema: {} })).rejects.toThrow(/not configured/)
  })
})

describe('出境清單的 Today: 日期（小問題：原本用 UTC）', () => {
  it('localDate 用使用者所在時區的年月日', () => {
    expect(localDate(new Date(2026, 0, 3, 0, 5))).toBe('2026-01-03')
    expect(localDate(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31')
  })
  it('App.tsx 的 today() 用 localDate，不用 toISOString', () => {
    expect(appSrc).toContain('const today = () => localDate(new Date())')
    expect(appSrc).not.toContain('toISOString().slice(0, 10)')
  })
})

describe('改欄位對應後清掉類別（小問題）', () => {
  it('Columns 的選單與按鈕都經 changeCols；說明或金額欄一換就清掉類別', () => {
    const cols = appSrc.slice(appSrc.indexOf('<details className="columns">'), appSrc.indexOf('</details>', appSrc.indexOf('<details className="columns">')))
    expect(cols).not.toContain('setCols(')
    expect(cols.match(/changeCols\(/g)?.length).toBe(5)
    const f = appSrc.slice(appSrc.indexOf('function changeCols('), appSrc.indexOf('async function loadSample('))
    expect(f).toContain('next.description === cols.description && next.amount === cols.amount && next.debit === cols.debit && next.credit === cols.credit')
    expect(f).toContain('if (!same) { setCats(new Map())')
  })
})
