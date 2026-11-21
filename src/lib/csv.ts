// CSV 讀取與欄位對應：Papaparse 解析，猜日期、說明、金額欄位，允許手動改。
import Papa from 'papaparse'

/** debit／credit 兩欄都有值時走分欄模式（Debit 為支出、Credit 為收入），此時忽略 amount。 */
export interface ColumnMap { date: string; description: string; amount: string; debit: string; credit: string }
export interface Tx { id: number; date: string; desc: string; amount: number }
export interface ParsedCsv { headers: string[]; rows: Record<string, string>[] }

/** 標題列前面有摘要區時，往下找標題列的範圍（前幾列） */
const HEADER_SEARCH_ROWS = 20

/**
 * 第一行預設是標題列。第一行猜不出日期、說明、金額三欄時（例如對帳單前面先有期初餘額、借貸合計的摘要區），
 * 往下找前 20 列裡第一個猜得出三欄的列，從那一列開始讀；找不到就照第一行讀（與原本相同）。
 * 第一行就猜得出三欄的檔案完全照原本的方式讀。
 */
export function parseCsv(text: string): ParsedCsv {
  const src = text.trim()
  const r = Papa.parse<Record<string, string>>(src, { header: true, skipEmptyLines: true })
  const headers = r.meta.fields ?? []
  if (!hasAllColumns(guessColumns(headers))) {
    const cells = Papa.parse<string[]>(src, { header: false, skipEmptyLines: true }).data
    const start = cells.slice(0, HEADER_SEARCH_ROWS).findIndex((row, i) => {
      if (i === 0) return false
      const m = guessColumns(row)
      // 三欄要是不同的格子，避免一格同時含 date、name、total 之類字樣的資料列被當成標題
      return hasAllColumns(m) && new Set([m.date, m.description, isSplit(m) ? m.debit : m.amount]).size === 3
    })
    if (start > 0) {
      const rest = Papa.parse<Record<string, string>>(Papa.unparse(cells.slice(start)), { header: true, skipEmptyLines: true, delimiter: ',' })
      return { headers: rest.meta.fields ?? [], rows: rest.data }
    }
  }
  return { headers, rows: r.data }
}

/** 日期、說明、金額（或 Debit／Credit 兩欄）都猜得到 */
function hasAllColumns(m: ColumnMap): boolean {
  return !!m.date && !!m.description && (!!m.amount || isSplit(m))
}

const GUESS: Record<Exclude<keyof ColumnMap, 'description'>, RegExp> = {
  date: /date|posted|time/i,
  amount: /amount|amt|value|total/i,
  debit: /debit|withdraw|money out|paid out/i,
  credit: /credit|deposit|money in|paid in/i,
}

/**
 * 說明欄依序比對，前一組有符合的欄位就用它：description／desc → merchant／payee／name → narrative／memo／details。
 * 例如 Details,Posting Date,Description,... 要選 Description（Details 欄放的是 DEBIT／CREDIT 這類交易種類）。
 * 三組合起來與原本的比對字樣相同，所以原本找得到說明欄的檔案仍然找得到。
 */
const DESCRIPTION_ORDER: RegExp[] = [/desc/i, /merchant|payee|name/i, /narrat|memo|detail/i]

export function guessColumns(headers: string[]): ColumnMap {
  const pick = (k: keyof typeof GUESS) => headers.find((h) => GUESS[k].test(h)) ?? ''
  const description = DESCRIPTION_ORDER.map((re) => headers.find((h) => re.test(h))).find((h) => h !== undefined) ?? ''
  const debit = pick('debit')
  const credit = pick('credit')
  const split = !!debit && !!credit && debit !== credit
  return { date: pick('date'), description, amount: pick('amount'), debit: split ? debit : '', credit: split ? credit : '' }
}

/** 金額字串轉數字：容許 $、千分位逗號、括號負數。無法解析回傳 NaN。 */
export function parseAmount(s: string): number {
  const t = (s ?? '').trim()
  if (!t) return NaN
  const neg = /^\(.*\)$/.test(t) || t.startsWith('-')
  const digits = t.replace(/[^0-9.]/g, '')
  if (!/[0-9]/.test(digits)) return NaN
  const n = Number(digits)
  return neg ? -n : n
}

export type SignMode = 'expenses-negative' | 'expenses-positive'

export const isSplit = (m: ColumnMap) => !!m.debit && !!m.credit

function rawAmount(r: Record<string, string>, m: ColumnMap): number {
  if (isSplit(m)) {
    const d = Math.abs(parseAmount(r[m.debit]))
    const c = Math.abs(parseAmount(r[m.credit]))
    if (Number.isNaN(d) && Number.isNaN(c)) return NaN
    return (Number.isNaN(c) ? 0 : c) - (Number.isNaN(d) ? 0 : d)
  }
  return parseAmount(r[m.amount])
}

/**
 * 自動判斷正負號：先看薪資類說明的符號（正數＝收入進帳，支出為負），
 * 沒有薪資列就看多數符號（負數較多＝支出為負）。分欄模式固定為支出為負。
 */
export function detectSign(p: ParsedCsv, m: ColumnMap): SignMode {
  if (isSplit(m)) return 'expenses-negative'
  let pos = 0, neg = 0, payPos = 0, payNeg = 0
  for (const r of p.rows) {
    const a = parseAmount(r[m.amount])
    if (Number.isNaN(a) || a === 0) continue
    if (a > 0) pos++; else neg++
    if (/PAYROLL|DIRECT DEP|SALARY|PAYCHECK/i.test(r[m.description] ?? '')) { if (a > 0) payPos++; else payNeg++ }
  }
  if (payPos !== payNeg) return payPos > payNeg ? 'expenses-negative' : 'expenses-positive'
  return neg >= pos ? 'expenses-negative' : 'expenses-positive'
}

/** sign 預設自動判斷；使用者可切換。內部一律讓支出為負數。 */
export function toTransactions(p: ParsedCsv, m: ColumnMap, sign: SignMode = detectSign(p, m)): Tx[] {
  const out: Tx[] = []
  const flip = !isSplit(m) && sign === 'expenses-positive'
  for (const r of p.rows) {
    const desc = (r[m.description] ?? '').trim()
    const raw = rawAmount(r, m)
    if (!desc || Number.isNaN(raw)) continue
    out.push({ id: out.length + 1, date: (r[m.date] ?? '').trim(), desc, amount: flip ? -raw : raw })
  }
  return out
}
