import { describe, expect, it } from 'vitest'
import appSrc from '../App.tsx?raw'
import sample60 from '../../public/samples/sample-statement-2.csv?raw'
import sample247 from '../../public/samples/sample-statement-1.csv?raw'
import { detectSign, guessColumns, parseCsv, toTransactions } from './csv'
import { NEEDED_COLUMNS, dataPeriod, emptyAnswerNote, loadError, loadWarning, looksBinary } from './loadcheck'
import { runPlan, type QueryPlan } from './plan'
import { classifyByRules } from './rules'
import { normalizeDesc } from './normalize'
import { spendByCategory, type Classified } from './aggregate'
import { buildAdviceManifest, buildPlanManifest, categoryShares, type ColumnInfo } from './cloudtasks'

// 找錯報告第 1、13 項：自己的 CSV 讀到 0 筆時要說原因；部分列讀不懂時要提示。

/** 照 App.tsx 的 load()：先算出交易，再決定要不要換掉畫面上的資料 */
function check(text: string, fileName = 'mybank.csv', kept = false) {
  const p = parseCsv(text)
  const cols = guessColumns(p.headers)
  const txs = toTransactions(p, cols, detectSign(p, cols))
  return { p, cols, txs, error: loadError({ fileName, text, parsed: p, cols, txs, kept }), warning: loadWarning(p, cols, txs) }
}

describe('讀到 0 筆時的說明', () => {
  it('沒有標題列的檔案：檔名、列數、找到的欄位名稱、看起來沒有標題列、需要的三欄', () => {
    const { error } = check([
      '"01/02/2026","-12.34","*","","PURCHASE AUTHORIZED ON 12/31 CORNER CAFE"',
      '"01/03/2026","-45.10","*","","PURCHASE AUTHORIZED ON 01/02 CITY FRESH GROCERY"',
      '"01/05/2026","1500.00","*","","PAYROLL DIRECT DEP ACME"',
    ].join('\n'), 'export.csv')
    expect(error).toContain('Could not read any transactions from export.csv.')
    expect(error).toContain('It has 2 rows below the first line.')
    expect(error).toContain('Column names found: "01/02/2026", "-12.34", "*", "", "PURCHASE AUTHORIZED ON 12/31…".')
    expect(error).toContain('The first line looks like a transaction, so the file may have no header line.')
    expect(error).toContain(NEEDED_COLUMNS)
    expect(error).toContain('No column was recognized for: date, description, amount.')
  })
  it('欄位名稱不在猜測清單（Date,Transaction,Charge）：列出找不到的欄', () => {
    const { error } = check('Date,Transaction,Charge\n2026-01-02,CORNER CAFE,12.34\n2026-01-03,CITY FRESH GROCERY,45.10')
    expect(error).toContain('Column names found: "Date", "Transaction", "Charge".')
    expect(error).toContain('No column was recognized for: description, amount.')
    expect(error).not.toContain('no header line')
  })
  it('UTF-16 檔被當成 UTF-8 讀進來：說看起來不是純文字的 CSV', () => {
    const src = '﻿Date\tDescription\tAmount\r\n2026-01-02\tCORNER CAFE\t-12.34\r\n'
    const bytes = new Uint8Array(src.length * 2)
    for (let i = 0; i < src.length; i++) { bytes[i * 2] = src.charCodeAt(i) & 0xff; bytes[i * 2 + 1] = src.charCodeAt(i) >> 8 }
    const text = new TextDecoder('utf-8').decode(bytes) // File.text() 的行為
    expect(looksBinary(text)).toBe(true)
    const { txs, error } = check(text)
    expect(txs).toHaveLength(0)
    expect(error).toContain('It does not look like a plain-text CSV file. Save or export it as CSV (UTF-8) and try again.')
    expect(error).toContain(NEEDED_COLUMNS)
  })
  it('空檔案', () => {
    expect(check('').error).toBe(`Could not read any transactions from mybank.csv. The file is empty. ${NEEDED_COLUMNS}`)
    expect(check('  \n\n').error).toContain('The file is empty.')
  })
  it('欄位都找到但金額全是小數點用逗號的寫法：說哪裡讀不懂', () => {
    const { error } = check('Date,Description,Amount\n2026-01-02,CAFE,"-12,34"\n2026-01-03,SHOP,"-1,50"')
    expect(error).toContain('No row had both a description and an amount that could be read (amounts with a decimal comma, such as 12,34, are not supported).')
  })
  it('畫面上原本有資料時寫明沒有換掉', () => {
    expect(check('', 'x.csv', true).error).toContain('The statement on screen was not changed.')
    expect(check('', 'x.csv', false).error).not.toContain('not changed')
  })
  it('欄位名稱很多時只列前 8 個，控制字元拿掉', () => {
    const { error } = check('a,b,c,d,e,f,g,h,i\u0001,j\n1,2,3,4,5,6,7,8,9,10')
    expect(error).toContain('"a", "b", "c", "d", "e", "f", "g", "h" and 2 more.')
  })
  it('讀得到交易時沒有錯誤', () => {
    expect(check('Date,Description,Amount\n2026-01-02,CAFE,-1').error).toBeNull()
  })
})

describe('部分列讀不懂時的提示', () => {
  it('略過的列與原因', () => {
    const { warning } = check('Date,Description,Amount\n2026-01-02,CAFE,-1.00\n2026-01-03,,-2.00\n2026-01-04,SHOP,"-3,50"')
    expect(warning).toBe('2 of 3 rows were skipped because the description or amount could not be read (amounts with a decimal comma, such as 12,34, are not supported).')
  })
  it('讀不懂的日期（DD/MM、月份名稱）', () => {
    const { warning } = check('Date,Description,Amount\n25/01/2026,CAFE,-1\nJan 3 2026,SHOP,-2\n1/3/26,DELI,-3')
    expect(warning).toBe('2 transactions have dates this app cannot read (it reads YYYY-MM-DD, M/D/YYYY and M/D/YY), so date filters leave them out and the monthly view lists them as unknown.')
  })
  it('沒有日期欄', () => {
    expect(check('Description,Amount\nCAFE,-1').warning).toBe('No date column was recognized, so date filters leave every row out. You can choose one under Columns.')
  })
  it('一列讀不懂時用單數', () => {
    expect(check('Date,Description,Amount\n2026-01-02,CAFE,-1\n2026-01-03,,-2').warning).toBe('1 of 2 rows was skipped because the description or amount could not be read.')
  })
})

describe('兩份範例：沒有錯誤也沒有提示', () => {
  it('60 筆與 247 筆', () => {
    for (const s of [sample60, sample247]) {
      const r = check(s, 'sample.csv', true)
      expect(r.error).toBeNull()
      expect(r.warning).toBeNull()
    }
  })
})

describe('資料期間與答案 0 筆時的提示（找錯第 2 項）', () => {
  const s60 = check(sample60)
  const data60: Classified[] = s60.txs.map((t) => ({ ...t, category: classifyByRules(t.desc) }))
  it('兩份範例的資料期間', () => {
    expect(dataPeriod(s60.txs)).toEqual({ from: '2026-01-03', to: '2026-03-27' })
    expect(dataPeriod(check(sample247).txs)).toEqual({ from: '2026-01-01', to: '2026-03-28' })
  })
  it('讀不懂的日期不算；一筆都讀不懂回傳 null', () => {
    expect(dataPeriod([{ id: 1, date: 'Jan 3', desc: 'a', amount: -1 }, { id: 2, date: '2/1/26', desc: 'b', amount: -1 }])).toEqual({ from: '2026-02-01', to: '2026-02-01' })
    expect(dataPeriod([{ id: 1, date: '', desc: 'a', amount: -1 }])).toBeNull()
    expect(dataPeriod([])).toBeNull()
  })
  it('計畫的日期落在資料期間外（例如 last month）：0 筆並寫出兩個期間', () => {
    const plan: QueryPlan = { filter: { dateFrom: '2026-11-01', dateTo: '2026-11-30' }, aggregate: 'sum' }
    const r = runPlan(plan, data60)
    expect(r.rows).toEqual([{ label: 'Total', value: 0, count: 0 }])
    expect(emptyAnswerNote(plan, r, dataPeriod(s60.txs))).toBe('No transactions matched. The plan asks for dates 2026-11-01 to 2026-11-30, and this statement covers 2026-01-03 to 2026-03-27.')
    const from: QueryPlan = { filter: { dateFrom: '2026-11-01' }, groupBy: 'category', aggregate: 'sum' }
    expect(emptyAnswerNote(from, runPlan(from, data60), null)).toBe('No transactions matched. The plan asks for dates from 2026-11-01.')
  })
  it('有分組又 0 筆：說沒有符合的交易；沒有日期篩選的 Total 0 照舊不加提示；有結果時不加', () => {
    const g: QueryPlan = { filter: { merchantContains: 'zzz' }, groupBy: 'month', aggregate: 'sum' }
    expect(emptyAnswerNote(g, runPlan(g, data60), null)).toBe('No transactions matched.')
    const t: QueryPlan = { filter: { merchantContains: 'zzz' }, aggregate: 'sum' }
    expect(emptyAnswerNote(t, runPlan(t, data60), null)).toBeNull()
    const ok: QueryPlan = { filter: { dateFrom: '2026-01-01', dateTo: '2026-01-31' }, aggregate: 'sum' }
    expect(emptyAnswerNote(ok, runPlan(ok, data60), dataPeriod(s60.txs))).toBeNull()
    expect(emptyAnswerNote(null, null, null)).toBeNull()
  })
  it('資料期間與交易內容不進出境清單', () => {
    const cols: ColumnInfo[] = [{ name: 'Transaction Date', type: 'date' }, { name: 'Merchant', type: 'text' }, { name: 'Amount', type: 'number' }]
    const m = buildPlanManifest('How much did I spend last month?', cols, '2026-12-10', s60.txs.length)
    const a = buildAdviceManifest(categoryShares(spendByCategory(data60)), s60.txs.length)
    for (const sent of [m.system + m.prompt + JSON.stringify(m.schema), a.system + a.prompt + JSON.stringify(a.schema)]) {
      for (const t of s60.txs) {
        expect(sent).not.toContain(t.date)
        expect(sent).not.toContain(normalizeDesc(t.desc))
        expect(sent).not.toContain(String(Math.abs(t.amount)))
      }
      expect(sent).not.toContain('2026-01-03')
      expect(sent).not.toContain('2026-03-27')
    }
    // App.tsx 組出境清單時不讀資料期間
    const call = appSrc.split('\n').filter((l) => l.includes('buildPlanManifest(') || l.includes('buildAdviceManifest('))
    expect(call.length).toBeGreaterThan(0)
    for (const l of call) expect(l).not.toMatch(/period|dataPeriod/)
  })
})

describe('App.tsx 的接法', () => {
  it('讀到 0 筆時先顯示原因就結束，不換掉畫面上的資料', () => {
    const load = appSrc.slice(appSrc.indexOf('function load('), appSrc.indexOf('async function loadSample('))
    expect(load).toMatch(/setLoadErr\(err\)\s+if \(err\) return/)
    expect(load.indexOf('if (err) return')).toBeLessThan(load.indexOf('setCsv(p)'))
  })
  it('本機規則 0 列命中時也顯示規則摘要與提示', () => {
    expect(appSrc).toContain('{!busy && engine && (')
    expect(appSrc).toContain('No row matched a keyword rule.')
  })
})
