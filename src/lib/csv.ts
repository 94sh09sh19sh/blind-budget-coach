// CSV 讀取與欄位對應：Papaparse 解析，猜日期、說明、金額欄位，允許手動改。
import Papa from 'papaparse'

export interface ColumnMap { date: string; description: string; amount: string }
export interface Tx { id: number; date: string; desc: string; amount: number }
export interface ParsedCsv { headers: string[]; rows: Record<string, string>[] }

export function parseCsv(text: string): ParsedCsv {
  const r = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true })
  return { headers: r.meta.fields ?? [], rows: r.data }
}

const GUESS: Record<keyof ColumnMap, RegExp> = {
  date: /date|posted|time/i,
  description: /desc|memo|merchant|payee|detail|narrat|name/i,
  amount: /amount|amt|debit|value|total/i,
}

export function guessColumns(headers: string[]): ColumnMap {
  const pick = (k: keyof ColumnMap) => headers.find((h) => GUESS[k].test(h)) ?? ''
  return { date: pick('date'), description: pick('description'), amount: pick('amount') }
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

export function toTransactions(p: ParsedCsv, m: ColumnMap): Tx[] {
  const out: Tx[] = []
  for (const r of p.rows) {
    const desc = (r[m.description] ?? '').trim()
    const amount = parseAmount(r[m.amount])
    if (!desc || Number.isNaN(amount)) continue
    out.push({ id: out.length + 1, date: (r[m.date] ?? '').trim(), desc, amount })
  }
  return out
}
