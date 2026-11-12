// 本機儲存（IndexedDB，經 idb-keyval）：更正、時間線、最近一次的交易與分類結果。全部只留在這個瀏覽器。
import { clear, get, set } from 'idb-keyval'
import type { Category } from './categories'
import type { ColumnMap, SignMode, Tx } from './csv'
import type { TimelineEntry } from './router'

export interface LastRun {
  fileName: string
  cols: ColumnMap
  sign: SignMode | 'auto'
  level: 'user-detail' | 'public-sample'
  txs: Tx[]
  cats: [number, Category | null][]
  savedAt: number
}

const K_OVERRIDES = 'overrides'
const K_TIMELINE = 'timeline'
const K_LAST = 'last-run'
const MAX_TIMELINE = 300

async function safe<T>(f: () => Promise<T>, fallback: T): Promise<T> {
  try { return await f() } catch { return fallback }
}

export const loadOverrides = () => safe(async () => (await get<Record<string, Category>>(K_OVERRIDES)) ?? {}, {} as Record<string, Category>)
export const saveOverrides = (o: Record<string, Category>) => safe(() => set(K_OVERRIDES, o), undefined)
export const loadTimeline = () => safe(async () => (await get<TimelineEntry[]>(K_TIMELINE)) ?? [], [] as TimelineEntry[])
export const saveTimeline = (t: TimelineEntry[]) => safe(() => set(K_TIMELINE, t.slice(-MAX_TIMELINE)), undefined)
export const loadLastRun = () => safe(async () => (await get<LastRun>(K_LAST)) ?? null, null as LastRun | null)
export const saveLastRun = (r: LastRun) => safe(() => set(K_LAST, r), undefined)

/** 清光所有本機資料（更正、時間線、最近一次結果）。 */
export const eraseAll = () => safe(() => clear(), undefined)

/** 出境帳本：每一次經同意的雲端請求一列，留下當時送出的原文，供介面點開核對。 */
export interface LedgerEntry {
  id: number
  at: number
  task: string
  mode: string
  bytes: number
  system: string
  prompt: string
  schema: object
  outcome: string
}
const K_LEDGER = 'ledger'
export const loadLedger = () => safe(async () => (await get<LedgerEntry[]>(K_LEDGER)) ?? [], [] as LedgerEntry[])
export const saveLedger = (l: LedgerEntry[]) => safe(() => set(K_LEDGER, l), undefined)
