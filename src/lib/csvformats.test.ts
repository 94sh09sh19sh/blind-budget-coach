import { describe, expect, it } from 'vitest'
import { detectSign, guessColumns, parseAmount, parseCsv, toTransactions } from './csv'
import { isoDate, runPlan } from './plan'
import { monthOf } from './aggregate'
import { categoryShares } from './cloudtasks'

// 銀行匯出檔的幾種寫法（2026-11-21 找錯報告第 4、13 項與對照組）。
// 兩家銀行的實際格式是依印象寫的合成檔，不是真的匯出檔。

/** 照 App.tsx 的流程：parseCsv → guessColumns → detectSign → toTransactions */
function load(text: string) {
  const p = parseCsv(text)
  const cols = guessColumns(p.headers)
  return { p, cols, txs: toTransactions(p, cols, detectSign(p, cols)) }
}

describe('說明欄的比對順序', () => {
  it('Details,Posting Date,Description,...：選 Description，不選 Details', () => {
    const { cols, txs } = load('Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\nDEBIT,01/02/2026,"CORNER CAFE",-12.34,DEBIT_CARD,1000.00,,\nDEBIT,01/03/2026,"CITY FRESH GROCERY",-45.10,DEBIT_CARD,954.90,,')
    expect(cols).toEqual({ date: 'Posting Date', description: 'Description', amount: 'Amount', debit: '', credit: '' })
    expect(txs.map((t) => t.desc)).toEqual(['CORNER CAFE', 'CITY FRESH GROCERY'])
  })
  it('desc 優先於 merchant／payee／name，merchant／payee／name 優先於 memo', () => {
    expect(guessColumns(['Date', 'Memo', 'Payee', 'Amount']).description).toBe('Payee')
    expect(guessColumns(['Date', 'Name', 'Transaction Description', 'Amount']).description).toBe('Transaction Description')
    expect(guessColumns(['Date', 'Narrative', 'Amount']).description).toBe('Narrative')
  })
  it('兩份範例的標題結果不變', () => {
    expect(guessColumns(['Transaction Date', 'Merchant', 'Amount']).description).toBe('Merchant')
    expect(guessColumns(['Date', 'Description', 'Amount']).description).toBe('Description')
  })
})

describe('標題列前面的摘要區', () => {
  const summary = [
    'Description,,Summary Amt.',
    'Beginning balance as of 01/01/2026,,"1,234.56"',
    'Total credits,,"2,000.00"',
    'Total debits,,"-1,500.00"',
    'Ending balance as of 01/31/2026,,"1,734.56"',
    '',
    'Date,Description,Amount,Running Bal.',
    '01/02/2026,"CORNER CAFE","-12.34","1,222.22"',
    '01/03/2026,"CITY FRESH GROCERY, NORTH","-45.10","1,177.12"',
  ].join('\n')
  it('跳過摘要區，從真正的標題列開始讀；摘要列不算成交易', () => {
    const { p, cols, txs } = load(summary)
    expect(p.headers).toEqual(['Date', 'Description', 'Amount', 'Running Bal.'])
    expect(cols).toEqual({ date: 'Date', description: 'Description', amount: 'Amount', debit: '', credit: '' })
    expect(txs).toEqual([
      { id: 1, date: '01/02/2026', desc: 'CORNER CAFE', amount: -12.34 },
      { id: 2, date: '01/03/2026', desc: 'CITY FRESH GROCERY, NORTH', amount: -45.1 },
    ])
  })
  it('分號分隔的檔案也一樣', () => {
    const { txs } = load('Account;12345\nPeriod;2026-01\n\nDate;Description;Amount\n2026-01-02;CAFE;-1.50\n2026-01-03;"SHOP; NORTH";-2.00')
    expect(txs.map((t) => [t.desc, t.amount])).toEqual([['CAFE', -1.5], ['SHOP; NORTH', -2]])
  })
  it('第一行就猜得出三欄：照原本的方式讀，不往下找', () => {
    const text = 'Date,Description,Amount\n2026-01-02,DATE NIGHT NAME TOTAL,-1\n2026-01-03,CAFE,-2'
    expect(load(text).txs.map((t) => t.desc)).toEqual(['DATE NIGHT NAME TOTAL', 'CAFE'])
  })
  it('第一行只有說明與金額（沒有日期欄）：往下找不到標題列就照第一行讀', () => {
    const { cols, txs } = load('Description,Amount\nCAFE,-2\nSHOP,-3')
    expect(cols.date).toBe('')
    expect(txs.map((t) => t.desc)).toEqual(['CAFE', 'SHOP'])
  })
  it('沒有標題列的檔案：仍然讀到 0 筆（由讀檔提示說明，見 loadcheck.test.ts）', () => {
    const { txs } = load('"01/02/2026","-12.34","*","","PURCHASE AUTHORIZED ON 12/31 CORNER CAFE"\n"01/03/2026","-45.10","*","","CITY FRESH GROCERY"')
    expect(txs).toHaveLength(0)
  })
})

describe('金額與日期的寫法', () => {
  it('減號在任何位置都是負數', () => {
    const cases: [string, number][] = [['$-12.34', -12.34], ['12.34-', -12.34], ['USD -5.00', -5], ['-$1,234.50', -1234.5], ['−12.00', -12]]
    for (const [s, want] of cases) expect(parseAmount(s), s).toBe(want)
  })
  it('小數點用逗號的寫法不支援：讀成 NaN（略過並計入讀不懂的列），不變成 1234', () => {
    for (const s of ['12,34', '-12,34', '1.234,56', '1,5']) expect(parseAmount(s), s).toBeNaN()
    // 千分位照常
    for (const [s, want] of [['1,234', 1234], ['12,345.67', 12345.67], ['$1,234,567.89', 1234567.89]] as const) expect(parseAmount(s), s).toBe(want)
  })
  it('M/D/YY：兩位數年份當成 20YY', () => {
    expect(isoDate('01/03/26')).toBe('2026-01-03')
    expect(monthOf('1/3/26')).toBe('2026-01')
    expect(isoDate('1/3/2026')).toBe('2026-01-03')
  })
  it('DD/MM 與其他寫法不支援：回傳讀不懂，不當成第 25 月', () => {
    expect(isoDate('25/01/2026')).toBeNull()
    expect(monthOf('25/01/2026')).toBe('unknown')
    expect(isoDate('Jan 3, 2026')).toBeNull()
    expect(monthOf('1/3/202')).toBe('unknown')
  })
  it('原本支援的寫法不變', () => {
    expect(isoDate('2026-01-03T23:59:00Z')).toBe('2026-01-03')
    expect(monthOf('2026-01-03')).toBe('2026-01')
    expect(monthOf('3/7/2026')).toBe('2026-03')
    expect(isoDate('12/31/2025')).toBe('2025-12-31')
  })
})

// 對照組（找錯報告的 checked.test.ts）：修改前就正確的寫法，修改後也要照常
describe('對照組：原本就讀得對的寫法', () => {
  it('分號、Tab、BOM、引號內逗號與換行、空列、CRLF', () => {
    const semi = load('﻿Date;Description;Amount\r\n2026-01-02;"CAFE; NORTH";-12.34\r\n\r\n2026-01-03;"LINE\nTWO";-1.00\r\n').txs
    const tab = load('Date\tDescription\tAmount\n2026-01-02\tCAFE\t-12.34').txs
    expect(semi.map((t) => t.desc)).toEqual(['CAFE; NORTH', 'LINE\nTWO'])
    expect(tab[0].amount).toBe(-12.34)
  })
  it('金額：千分位、括號負數、-$、$、正號', () => {
    expect(parseAmount('1,234.56')).toBe(1234.56)
    expect(parseAmount('(45.00)')).toBe(-45)
    expect(parseAmount('-$12.34')).toBe(-12.34)
    expect(parseAmount('$12.34')).toBe(12.34)
    expect(parseAmount('+3.50')).toBe(3.5)
  })
  it('支出為正的信用卡帳單：自動判斷翻轉正負號', () => {
    const t = load('Date,Description,Amount\n2026-01-02,CAFE,12.34\n2026-01-03,GROCERY,45.00\n2026-01-04,PAYMENT THANK YOU,-57.34').txs
    expect(t.map((x) => x.amount)).toEqual([-12.34, -45, 57.34])
  })
  it('Debit／Credit 分兩欄', () => {
    const t = load('Date,Description,Debit,Credit\n2026-01-02,CAFE,12.34,\n2026-01-05,PAYROLL,,1500.00').txs
    expect(t.map((x) => x.amount)).toEqual([-12.34, 1500])
  })
  it('執行器：空資料、平均不除以零、四捨五入、跨年月份排序', () => {
    expect(runPlan({ aggregate: 'avg' }, []).rows).toEqual([{ label: 'Total', value: 0, count: 0 }])
    const rows = [
      { id: 1, date: '2025-12-31', desc: 'A', amount: -0.1, category: 'Dining' as const },
      { id: 2, date: '2026-01-01', desc: 'A', amount: -0.2, category: 'Dining' as const },
      { id: 3, date: '12/30/2025', desc: 'B', amount: 5, category: 'Shopping' as const },
    ]
    expect(runPlan({ groupBy: 'month', aggregate: 'sum' }, rows).rows.map((x) => x.label)).toEqual(['2025-12', '2026-01'])
    expect(runPlan({ aggregate: 'sum' }, rows).rows[0].value).toBe(0.3)
  })
  it('預算建議的占比總和為 100', () => {
    expect(Object.values(categoryShares({ A: 1, B: 1, C: 1, D: 0.0001 })).reduce((a, b) => a + b, 0)).toBe(100)
  })
})
