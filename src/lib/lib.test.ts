import { describe, expect, it } from 'vitest'
import { normalizeDesc } from './normalize'
import { CATEGORIES, isCategory } from './categories'
import { classifyByRules } from './rules'
import { detectSign, guessColumns, parseAmount, parseCsv, toTransactions } from './csv'
import { monthOf, spendByCategory, spendByMonthCategory, type Classified } from './aggregate'
import { route } from './router'
import { applyOverrides, setOverride } from './overrides'

describe('normalizeDesc', () => {
  it('去掉前綴、店號、卡號尾碼、城市', () => {
    expect(normalizeDesc('POS PURCHASE APPLE.COM/BILL STORE 5802')).toBe('APPLE.COM/BILL')
    expect(normalizeDesc('tst* trader joe s new york ny')).toBe('TRADER JOE S')
    expect(normalizeDesc('CREDIT CARD PAYMENT THANK YOU XX1645')).toBe('CREDIT CARD PAYMENT THANK YOU')
  })
  it('同店家不同雜訊得到相同鍵', () => {
    expect(normalizeDesc('SQ *BLUE HERON CAFE #1234')).toBe(normalizeDesc('blue heron cafe *9999'))
  })
})

describe('categories', () => {
  it('13 類且可驗證', () => {
    expect(CATEGORIES).toHaveLength(13)
    expect(isCategory('Dining')).toBe(true)
    expect(isCategory('Food')).toBe(false)
  })
})

describe('classifyByRules', () => {
  it('常見店家', () => {
    expect(classifyByRules('STARBUCKS #123')).toBe('Dining')
    expect(classifyByRules('DOORDASH*ORDER')).toBe('Delivery')
    expect(classifyByRules('PAYROLL DIRECT DEP ACME CORP')).toBe('Income')
    expect(classifyByRules('NETFLIX.COM')).toBe('Subscriptions')
  })
  it('無法判斷回傳 null', () => {
    expect(classifyByRules('XYZZY QQQ')).toBeNull()
  })
})

describe('csv', () => {
  const text = 'Posted Date,Description,Amount\n2026-01-03,BLUE HERON CAFE,-12.50\n2026-01-04,PAYROLL,"1,200.00"\n2026-01-05,,5\n'
  it('猜欄位', () => {
    const p = parseCsv(text)
    expect(guessColumns(p.headers)).toEqual({ date: 'Posted Date', description: 'Description', amount: 'Amount', debit: '', credit: '' })
  })
  it('轉成交易並略過空說明', () => {
    const p = parseCsv(text)
    const txs = toTransactions(p, guessColumns(p.headers))
    expect(txs).toHaveLength(2)
    expect(txs[0].amount).toBe(-12.5)
    expect(txs[1].amount).toBe(1200)
  })
  it('金額格式', () => {
    expect(parseAmount('($5.00)')).toBe(-5)
    expect(parseAmount('$1,234.5')).toBe(1234.5)
    expect(parseAmount('abc')).toBeNaN()
  })
})

describe('csv 正負號與分欄', () => {
  const split = 'Date,Description,Debit,Credit\n2026-01-03,CAFE,12.50,\n2026-01-04,PAYROLL,,1200.00\n'
  it('Debit／Credit 分欄：支出為負、收入為正', () => {
    const p = parseCsv(split)
    const m = guessColumns(p.headers)
    expect(m.debit).toBe('Debit')
    expect(m.credit).toBe('Credit')
    expect(toTransactions(p, m).map((t) => t.amount)).toEqual([-12.5, 1200])
  })
  const cc = 'Date,Description,Amount\n2026-01-03,CAFE,12.50\n2026-01-04,GROCERY,40.00\n2026-01-05,PAYMENT THANK YOU,-200.00\n'
  it('信用卡式（支出為正）：自動判斷並翻轉，可手動切換', () => {
    const p = parseCsv(cc)
    const m = guessColumns(p.headers)
    expect(detectSign(p, m)).toBe('expenses-positive')
    expect(toTransactions(p, m).map((t) => t.amount)).toEqual([-12.5, -40, 200])
    expect(toTransactions(p, m, 'expenses-negative').map((t) => t.amount)).toEqual([12.5, 40, -200])
  })
  it('薪資列的符號優先於多數符號', () => {
    const p = parseCsv('Date,Description,Amount\n2026-01-03,PAYROLL ACME,1000\n2026-01-04,A,-1\n2026-01-05,B,-2\n')
    expect(detectSign(p, guessColumns(p.headers))).toBe('expenses-negative')
    const q = parseCsv('Date,Description,Amount\n2026-01-03,PAYROLL ACME,-1000\n2026-01-04,A,1\n')
    expect(detectSign(q, guessColumns(q.headers))).toBe('expenses-positive')
  })
})

describe('aggregate', () => {
  const txs: Classified[] = [
    { id: 1, date: '2026-01-03', desc: 'a', amount: -10, category: 'Dining' },
    { id: 2, date: '2026-01-09', desc: 'b', amount: -5.25, category: 'Dining' },
    { id: 3, date: '2026-02-01', desc: 'c', amount: -20, category: 'Groceries' },
    { id: 4, date: '2026-02-02', desc: 'd', amount: 1000, category: 'Income' },
    { id: 5, date: '2026-02-03', desc: 'e', amount: -3, category: null },
  ]
  it('依類別加總，略過收入', () => {
    expect(spendByCategory(txs)).toEqual({ Dining: 15.25, Groceries: 20, Unclassified: 3 })
  })
  it('依月份', () => {
    expect(spendByMonthCategory(txs)['2026-01']).toEqual({ Dining: 15.25 })
    expect(monthOf('3/7/2026')).toBe('2026-03')
    expect(monthOf('xx')).toBe('unknown')
  })
})

describe('route', () => {
  const base = { deviceModel: 'available' as const, online: true, consent: false }
  it('使用者明細：有模型走裝置端，沒有就用規則，絕不上雲', () => {
    expect(route({ ...base, level: 'user-detail' }).mode).toBe('ONLY_ON_DEVICE')
    const r = route({ ...base, level: 'user-detail', deviceModel: 'unavailable' })
    expect(r.mode).toBe('LOCAL_RULES')
    expect(r.side).toBe('rules')
  })
  it('示範資料：裝置端優先，沒有就改雲端，離線用規則', () => {
    expect(route({ ...base, level: 'public-sample' }).side).toBe('device')
    expect(route({ ...base, level: 'public-sample', deviceModel: 'unavailable' }).side).toBe('cloud')
    expect(route({ ...base, level: 'public-sample', deviceModel: 'unavailable', online: false }).side).toBe('rules')
  })
  it('結構：需同意才送雲端，離線改裝置端固定樣式', () => {
    expect(route({ ...base, level: 'schema-only', consent: true }).side).toBe('cloud')
    expect(route({ ...base, level: 'schema-only', online: false, consent: true }).side).toBe('device')
  })
  it('彙總比例：必須同意且連線', () => {
    expect(route({ ...base, level: 'aggregate', consent: true }).mode).toBe('ONLY_IN_CLOUD')
    expect(route({ ...base, level: 'aggregate' }).mode).toBe('DISABLED')
    expect(route({ ...base, level: 'aggregate', consent: true, online: false }).mode).toBe('DISABLED')
  })
})

describe('overrides', () => {
  const txs = [
    { id: 1, date: '2026-01-01', desc: 'POS PURCHASE JOES DINER #1', amount: -10 },
    { id: 2, date: '2026-01-02', desc: 'JOES DINER XX1234', amount: -20 },
    { id: 3, date: '2026-01-03', desc: 'OTHER PLACE', amount: -5 },
  ]
  it('更正套用到同一個清理後字串的所有列', () => {
    const r = setOverride(txs, {}, 'JOES DINER', 'Entertainment')
    expect(r.affected).toBe(2)
    const cats = applyOverrides(txs, new Map([[1, 'Dining'], [2, 'Dining'], [3, 'Shopping']]), r.overrides)
    expect([cats.get(1), cats.get(2), cats.get(3)]).toEqual(['Entertainment', 'Entertainment', 'Shopping'])
  })
})
