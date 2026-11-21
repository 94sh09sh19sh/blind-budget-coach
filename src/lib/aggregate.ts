// 依類別、月份加總（全在瀏覽器內，不經模型）。
import type { Category } from './categories'
import type { Tx } from './csv'

export interface Classified extends Tx { category: Category | null }

/**
 * 美式日期 M/D/YYYY 或 M/D/YY（兩位數年份當成 20YY）。
 * 月份不在 1～12、日不在 1～31 回傳 null：例如 DD/MM 寫法的 25/01/2026 不支援，不當成第 25 月。
 */
export function parseUsDate(s: string): { y: string; m: string; d: string } | null {
  const r = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2}(?!\d))/.exec(s)
  if (!r) return null
  const mo = Number(r[1]), da = Number(r[2])
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null
  return { y: r[3].length === 2 ? `20${r[3]}` : r[3], m: r[1].padStart(2, '0'), d: r[2].padStart(2, '0') }
}

/** 取 YYYY-MM；支援 YYYY-MM-DD、M/D/YYYY 與 M/D/YY，其他回傳 'unknown'。 */
export function monthOf(date: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(date)
  if (m) return `${m[1]}-${m[2]}`
  const u = parseUsDate(date)
  if (u) return `${u.y}-${u.m}`
  return 'unknown'
}

/** 只加總支出（金額小於 0）；收入與轉帳類別不計入。未分類歸入 'Unclassified'。 */
export function spendByCategory(txs: Classified[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of txs) {
    if (t.amount >= 0 || t.category === 'Income' || t.category === 'Transfers') continue
    const k = t.category ?? 'Unclassified'
    out[k] = (out[k] ?? 0) - t.amount
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 100) / 100
  return out
}

export function spendByMonthCategory(txs: Classified[]): Record<string, Record<string, number>> {
  const byMonth = new Map<string, Classified[]>()
  for (const t of txs) {
    const k = monthOf(t.date)
    byMonth.set(k, [...(byMonth.get(k) ?? []), t])
  }
  const out: Record<string, Record<string, number>> = {}
  for (const [k, v] of byMonth) out[k] = spendByCategory(v)
  return out
}
