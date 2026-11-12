// 使用者更正：以清理後字串為鍵，套用到所有同字串的列。
import type { Category } from './categories'
import type { Tx } from './csv'
import { normalizeDesc } from './normalize'

export type Overrides = Record<string, Category>

/** 回傳新的 id → 類別對照：有更正的列一律用更正值，其餘保留原值。 */
export function applyOverrides(txs: Tx[], cats: Map<number, Category | null>, overrides: Overrides): Map<number, Category | null> {
  const out = new Map(cats)
  for (const t of txs) {
    const o = overrides[normalizeDesc(t.desc)]
    if (o) out.set(t.id, o)
  }
  return out
}

/** 設定一個更正，回傳新的更正表與受影響的列數。 */
export function setOverride(txs: Tx[], overrides: Overrides, desc: string, cat: Category): { overrides: Overrides; affected: number } {
  const key = normalizeDesc(desc)
  return { overrides: { ...overrides, [key]: cat }, affected: txs.filter((t) => normalizeDesc(t.desc) === key).length }
}
