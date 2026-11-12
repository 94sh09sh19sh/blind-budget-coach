// CSV 讀取與欄位對應：Papaparse 解析，猜日期、說明、金額欄位，允許手動改。
import Papa from 'papaparse'

/** debit／credit 兩欄都有值時走分欄模式（Debit 為支出、Credit 為收入），此時忽略 amount。 */
export interface ColumnMap { date: string; description: string; amount: string; debit: string; credit: string }
export interface Tx { id: number; date: string; desc: string; amount: number }
export interface ParsedCsv { headers: string[]; rows: Record<string, string>[] }

export function parseCsv(text: string): ParsedCsv {
  const r = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true })
  return { headers: r.meta.fields ?? [], rows: r.data }
}

const GUESS: Record<keyof ColumnMap, RegExp> = {
  date: /date|posted|time/i,
  description: /desc|memo|merchant|payee|detail|narrat|name/i,
  amount: /amount|amt|value|total/i,
  debit: /debit|withdraw|money out|paid out/i,
  credit: /credit|deposit|money in|paid in/i,
}

export function guessColumns(headers: string[]): ColumnMap {
  const pick = (k: keyof ColumnMap) => headers.find((h) => GUESS[k].test(h)) ?? ''
  const debit = pick('debit')
  const credit = pick('credit')
  const split = !!debit && !!credit && debit !== credit
  return { date: pick('date'), description: pick('description'), amount: pick('amount'), debit: split ? debit : '', credit: split ? credit : '' }
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
