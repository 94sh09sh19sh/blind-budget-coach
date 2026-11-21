// 本機儲存（IndexedDB，經 idb-keyval）：更正、時間線、最近一次的交易與分類結果。全部只留在這個瀏覽器。
import { clear, get, set, update } from 'idb-keyval'
import type { Category } from './categories'
import type { ColumnMap, SignMode, Tx } from './csv'
import type { TimelineEntry } from './router'

/** 最近一次分類各由誰判了幾列：模型、確定性規則（薪資入帳字樣）、使用者先前存的更正 */
export interface RunCounts { model: number; rule: number; corrected: number }

export interface LastRun {
  fileName: string
  cols: ColumnMap
  sign: SignMode | 'auto'
  level: 'user-detail' | 'public-sample'
  txs: Tx[]
  cats: [number, Category | null][]
  /** 舊版存的紀錄沒有這欄 */
  counts?: RunCounts | null
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

/**
 * 按 Send 之後、請求送出之前先寫的結果欄，回應回來（或失敗、逾時）後改成實際結果。
 * 重新整理後還是這句，表示答案回來之前頁面就關了或重新整理了；畫面改顯示 LEDGER_NO_ANSWER，儲存的內容不變。
 */
export const LEDGER_PENDING = 'Sent; waiting for the answer.'
export const LEDGER_NO_ANSWER = 'No answer was recorded: the page was closed or reloaded while waiting. The request may have been sent.'

/** 帳本追加一列（純函式） */
export const appendRow = (l: LedgerEntry[] | undefined, row: LedgerEntry): LedgerEntry[] => [...(l ?? []), row]

/** 把送出前寫的那一列換成結果：依 id 與送出時間找，找不到就不動（例如其間在別的分頁按了 Erase）。純函式。 */
export const finishRow = (l: LedgerEntry[] | undefined, key: { id: number; at: number }, done: Pick<LedgerEntry, 'at' | 'outcome'>): LedgerEntry[] =>
  (l ?? []).map((e) => (e.id === key.id && e.at === key.at ? { ...e, ...done } : e))

// 帳本用 update 讀改寫（同一個交易內），不整份覆寫：兩個分頁各送一次時，兩列都留得住。儲存格式與原本相同（LedgerEntry 陣列）。
export const appendLedger = (row: LedgerEntry) => safe(() => update<LedgerEntry[]>(K_LEDGER, (l) => appendRow(l, row)), undefined)
export const finishLedger = (key: { id: number; at: number }, done: Pick<LedgerEntry, 'at' | 'outcome'>) =>
  safe(() => update<LedgerEntry[]>(K_LEDGER, (l) => finishRow(l, key, done)), undefined)
