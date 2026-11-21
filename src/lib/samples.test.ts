import { describe, expect, it } from 'vitest'
import sample60 from '../../public/samples/sample-statement-2.csv?raw'
import sample247 from '../../public/samples/sample-statement-1.csv?raw'
import { detectSign, guessColumns, parseCsv, toTransactions } from './csv'
import { classifyByRules } from './rules'
import { normalizeDesc } from './normalize'
import { spendByCategory, type Classified } from './aggregate'
import { EXAMPLE_QUESTIONS, matchByKeywords, patternToPlan, runPlan } from './plan'
import { classifyAll, type ClassifyEvent } from './ondevice'

// 範例資料的鎖定測試：讀檔、規則分類、範例問題的結果、裝置端流程送進模型的字串，改程式時都不可以變。
// 數字取自 2026-11-21 的 a62787a（與公開網址 11-19 部署的版本只差一行註解）。

/** 照 App.tsx 的流程：parseCsv → guessColumns → detectSign → toTransactions */
function load(text: string) {
  const p = parseCsv(text)
  const cols = guessColumns(p.headers)
  const sign = detectSign(p, cols)
  return { p, cols, sign, txs: toTransactions(p, cols, sign) }
}

/** 照 App.tsx 的 runRules：本機規則分類 */
const byRules = (txs: ReturnType<typeof load>['txs']): Classified[] => txs.map((t) => ({ ...t, category: classifyByRules(t.desc) }))

/** 讀檔結果的指紋（FNV-1a），逐列的日期、說明、金額只要有一個字不同就會變 */
function fingerprint(x: unknown): string {
  let h = 0x811c9dc5
  for (const ch of JSON.stringify(x)) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16)
}

describe('60 筆範例（sample-statement-2.csv）', () => {
  const { p, cols, sign, txs } = load(sample60)
  const data = byRules(txs)

  it('讀檔：60 列全部成為交易，欄位與正負號判斷不變', () => {
    expect(p.headers).toEqual(['Transaction Date', 'Merchant', 'Amount'])
    expect(p.rows).toHaveLength(60)
    expect(cols).toEqual({ date: 'Transaction Date', description: 'Merchant', amount: 'Amount', debit: '', credit: '' })
    expect(sign).toBe('expenses-negative')
    expect(txs).toHaveLength(60)
    expect(fingerprint(txs)).toBe('efe28217')
  })

  it('規則分類：56／60 列有類別，逐列結果不變', () => {
    expect(data.filter((t) => t.category).length).toBe(56)
    expect(data.map((t) => t.category)).toEqual([
      'Groceries', 'Subscriptions', 'Housing', 'Groceries', 'Groceries', 'Delivery', 'Groceries', 'Travel', 'Groceries', 'Dining',
      null, 'Dining', 'Groceries', 'Income', 'Health', 'Subscriptions', 'Shopping', 'Groceries', 'Entertainment', 'Dining',
      'Shopping', 'Dining', 'Transfers', 'Income', 'Groceries', 'Delivery', 'Dining', 'Dining', 'Subscriptions', 'Groceries',
      'Subscriptions', 'Dining', 'Groceries', 'Delivery', null, 'Health', 'Transfers', 'Transport', 'Dining', 'Housing',
      'Delivery', 'Dining', 'Dining', 'Transfers', 'Delivery', 'Transport', 'Entertainment', 'Delivery', 'Groceries', 'Utilities',
      'Health', 'Groceries', null, 'Groceries', 'Groceries', 'Shopping', 'Delivery', null, 'Shopping', 'Transport',
    ])
    expect(spendByCategory(data)).toEqual({
      Groceries: 978.32, Subscriptions: 51.92, Housing: 2274.12, Delivery: 179.97, Travel: 169.93, Dining: 310.6,
      Unclassified: 239.16, Health: 142.64, Shopping: 235.41, Entertainment: 57.43, Transport: 134.37, Utilities: 91.89,
    })
  })

  it('六個範例問題（關鍵字比對的固定樣式）在規則分類下的結果不變', () => {
    const rows = EXAMPLE_QUESTIONS.map((q) => runPlan(patternToPlan(matchByKeywords(q)!)!, data).rows.map((r) => [r.label, r.value, r.count]))
    expect(rows).toEqual([
      [['Housing', 2274.12, 2], ['Groceries', 978.32, 14], ['Dining', 310.6, 10], ['Unclassified', 239.16, 4], ['Shopping', 235.41, 4]],
      [['2026-01', 2228.9, 19], ['2026-02', 1810.24, 17], ['2026-03', 826.62, 19]],
      [['OAKWOOD APARTMENTS RENT', 2274.12, 2], ['SUNRISE FARMERS MARKET', 211.21, 3], ['NORTHSIDE HARDWARE', 210.99, 3], ['GREENFIELD MARKET', 210.93, 3],
        ['VALLEY SUPERMARKET', 179.2, 2], ['GADGETHUB ELECTRONICS', 174.82, 2], ['GETAWAY BOOKING', 169.93, 1], ['LUCKY DRAGON ASIAN MARKET', 157.66, 2],
        ['HARVEST FOODS', 138.7, 2], ['JOES DINER', 124.35, 3]],
      [['Total', 978.32, 14]],
      [['Total', 31.06, 10]],
      [['Total', 7, 7]],
    ])
  })

  it('裝置端流程：34 個不重複字串，2 個由薪資入帳規則判、32 個送進模型（每個問一次）', async () => {
    expect(new Set(txs.map((t) => normalizeDesc(t.desc))).size).toBe(34)
    const asked: string[] = []
    const ev: ClassifyEvent[] = []
    await classifyAll(async (prompt) => { asked.push(prompt); return JSON.stringify('Shopping') }, txs.map((t) => t.desc), (e) => ev.push(e))
    expect(asked).toHaveLength(32)
    expect(new Set(asked).size).toBe(32)
    expect(ev).toHaveLength(34)
    expect(ev.filter((e) => e.rule).map((e) => e.key).sort()).toEqual(['DIRECT DEP BRIGHTWAVE LLC', 'PAYROLL DIRECT DEP ACME CORP'])
    expect(fingerprint(asked)).toBe('46b96765')
  })
})

describe('247 筆範例（sample-statement-1.csv）', () => {
  const { p, cols, sign, txs } = load(sample247)
  const data = byRules(txs)
  it('讀檔：247 列全部成為交易，欄位與正負號判斷不變', () => {
    expect(p.rows).toHaveLength(247)
    expect(cols).toEqual({ date: 'Date', description: 'Description', amount: 'Amount', debit: '', credit: '' })
    expect(sign).toBe('expenses-negative')
    expect(txs).toHaveLength(247)
    expect(fingerprint(txs)).toBe('d945cc98')
  })
  it('規則分類：各類別列數', () => {
    const by: Record<string, number> = {}
    for (const t of data) by[String(t.category)] = (by[String(t.category)] ?? 0) + 1
    // 2026-11-21 找錯第 7 項：BRIGHTCALL WIRELESS 4 列由 Transfers 改為 Utilities（原為 Utilities 11、Transfers 14），其他列不變
    expect(by).toEqual({
      Groceries: 35, Subscriptions: 19, Dining: 48, Delivery: 16, Health: 13, Utilities: 15, Income: 9,
      Transport: 25, Shopping: 23, Housing: 3, Entertainment: 19, null: 5, Transfers: 10, Travel: 7,
    })
    expect(data.filter((t) => /WIRELESS/.test(t.desc)).map((t) => [t.id, t.category])).toEqual([[81, 'Utilities'], [85, 'Utilities'], [143, 'Utilities'], [180, 'Utilities']])
    expect(data.filter((t) => t.category === 'Transfers').every((t) => !/WIRELESS/.test(t.desc))).toBe(true)
  })
})
