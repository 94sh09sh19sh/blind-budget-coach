// 裝置端分類（經 Firebase AI Logic 的 ONLY_ON_DEVICE）。設定照 j1-probe 評測最佳組合：
// 清理後店家字串去重快取、enum 結構化輸出、只留類別定義的系統提示。
import { CATEGORIES, SYSTEM_PROMPT, isCategory, type Category } from './categories'
import { normalizeDesc } from './normalize'
import { isPayrollDeposit } from './rules'
import { createDeviceModel, type DeviceModel, type Gen } from './ai'

/* eslint-disable @typescript-eslint/no-explicit-any */
// 注意：這裡只用 LanguageModel.availability() 查可用狀態（不是推論）；所有推論都經 lib/ai.ts 的 Firebase AI Logic。
export type Availability = 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available'

export async function checkAvailability(): Promise<Availability> {
  const LM = (globalThis as any).LanguageModel
  if (!LM) return 'unsupported'
  try {
    return (await LM.availability({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    })) as Availability
  } catch {
    return 'unavailable'
  }
}

/** 批次大小預設值；1 表示逐筆（速度實驗後的採用結果，見 README 的 Known limitations） */
export const DEFAULT_BATCH_SIZE = 1

export const CLASSIFY_SCHEMA = { type: 'string', enum: [...CATEGORIES] }
const TIMEOUT_MS = 60_000 // 評測量到偶發約 26 秒停頓

/** 必須在使用者手勢（click）內呼叫；onProgress 收 0～1。走 ONLY_ON_DEVICE。 */
export function createClassifier(onProgress?: (p: number) => void): Promise<DeviceModel> {
  return createDeviceModel({ system: SYSTEM_PROMPT, schema: CLASSIFY_SCHEMA, onProgress })
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms)
    p.then((v) => { clearTimeout(t); res(v) }, (e) => { clearTimeout(t); rej(e) })
  })
}

/** 單筆分類。失敗重試 1 次，再失敗回傳 null（待分類）。gen 可注入，測試用假的。 */
export async function classifyOne(gen: Gen, key: string): Promise<{ category: Category | null; ms: number }> {
  const t0 = performance.now()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await withTimeout(gen(`Description: ${key}
Category:`), TIMEOUT_MS)
      const v = JSON.parse(out)
      if (isCategory(v)) return { category: v, ms: performance.now() - t0 }
    } catch {
      /* 重試 */
    }
  }
  return { category: null, ms: performance.now() - t0 }
}

export interface ClassifyEvent {
  key: string
  category: Category | null
  ms: number
  cached: boolean
  /** 這個店家字串影響的原始說明（呼叫端據此逐筆亮出） */
  descs: string[]
  /** 為 true 表示這筆是確定性規則判的（薪資入帳字樣），沒有問模型；呼叫端必須標成 Rules，不能算成模型判的 */
  rule?: boolean
  /** 只有批次路徑才有：這筆是哪一批的一份子（first 只在該批第一筆為 true，時間線每批只記一列） */
  batch?: { size: number; ms: number; first: boolean; fellBack: boolean }
}

// ---- 批次：一次呼叫分類多個字串，結構化輸出為固定長度的類別陣列 ----

export const BATCH_SYSTEM = `${SYSTEM_PROMPT}
You will receive a numbered list of descriptions. Answer with a JSON array that has exactly one category per description, in the same order.`

export function batchSchema(n: number) {
  return { type: 'array', items: { type: 'string', enum: [...CATEGORIES] }, minItems: n, maxItems: n }
}

export function batchPrompt(keys: string[]): string {
  return ['Descriptions:', ...keys.map((k, i) => `${i + 1}. ${k}`), 'Categories:'].join('\n')
}

/** 依批次長度產生輸出（陣列長度寫在結構裡，所以每種長度各一個模型物件）。 */
export type GenBatch = (n: number, prompt: string) => Promise<string>

/** 解析批次輸出；數量不符或有不合法類別就回傳 null（呼叫端退回逐筆）。 */
export function parseBatch(out: string, n: number): Category[] | null {
  try {
    const v: unknown = JSON.parse(out)
    if (!Array.isArray(v) || v.length !== n || !v.every(isCategory)) return null
    return v as Category[]
  } catch {
    return null
  }
}

/** 必須在使用者手勢內呼叫。回傳的 genBatch 會依需要建立各長度的模型；warm 可先建好。走 ONLY_ON_DEVICE。 */
export function createBatchClassifier(onProgress?: (p: number) => void) {
  const models = new Map<number, Promise<DeviceModel>>()
  const get = (n: number) => {
    let m = models.get(n)
    if (!m) { m = createDeviceModel({ system: BATCH_SYSTEM, schema: batchSchema(n), onProgress }); models.set(n, m) }
    return m
  }
  let last: 'device' | 'cloud' | 'unknown' = 'unknown'
  const generate: GenBatch = async (n, prompt) => {
    const m = await get(n)
    const out = await m.generate(prompt)
    last = m.lastSource()
    return out
  }
  return { generate, warm: (sizes: number[]) => Promise.all([...new Set(sizes)].map(get)).then(() => undefined), lastSource: () => last }
}

export interface ClassifyOptions {
  /** 一次送幾個字串；預設 1（逐筆）。大於 1 時需要 genBatch。 */
  batchSize?: number
  genBatch?: GenBatch
}

/**
 * 分類：依清理後字串去重，同字串只問模型一次（結果快取；overrides 為使用者更正，優先於模型，不送模型）。
 * 明顯的薪資入帳字樣由確定性規則直接判 Income（事件的 rule 為 true），不問模型。
 * batchSize 為 1 時逐筆；大於 1 時每批一次呼叫，數量不符、解析失敗或逾時就整批退回逐筆。
 * 每完成一個不重複字串就呼叫 onEvent（一批回來時，該批的事件連續發出，讓介面一起亮）。
 */
export async function classifyAll(
  gen: Gen,
  descs: string[],
  onEvent: (e: ClassifyEvent) => void,
  overrides: Map<string, Category> = new Map(),
  opts: ClassifyOptions = {},
): Promise<Map<string, Category | null>> {
  const groups = new Map<string, string[]>()
  for (const d of descs) {
    const k = normalizeDesc(d)
    groups.set(k, [...(groups.get(k) ?? []), d])
  }
  const cache = new Map<string, Category | null>()
  const todo: string[] = []
  for (const [key, group] of groups) {
    const o = overrides.get(key)
    if (o) {
      cache.set(key, o)
      onEvent({ key, category: o, ms: 0, cached: true, descs: group })
    } else if (isPayrollDeposit(key)) {
      // 使用者更正優先，其次是薪資入帳規則；都沒命中才問模型
      cache.set(key, 'Income')
      onEvent({ key, category: 'Income', ms: 0, cached: false, rule: true, descs: group })
    } else todo.push(key)
  }
  const size = Math.max(1, Math.floor(opts.batchSize ?? 1))
  const useBatch = size > 1 && !!opts.genBatch
  for (let i = 0; i < todo.length; i += useBatch ? size : 1) {
    const keys = todo.slice(i, i + (useBatch ? size : 1))
    if (useBatch && keys.length > 1) {
      const t0 = performance.now()
      let cats: Category[] | null = null
      try {
        cats = parseBatch(await withTimeout(opts.genBatch!(keys.length, batchPrompt(keys)), TIMEOUT_MS), keys.length)
      } catch {
        cats = null
      }
      if (cats) {
        const ms = performance.now() - t0
        keys.forEach((key, j) => {
          cache.set(key, cats![j])
          onEvent({ key, category: cats![j], ms, cached: false, descs: groups.get(key)!, batch: { size: keys.length, ms, first: j === 0, fellBack: false } })
        })
        continue
      }
      // 退回逐筆
      for (let j = 0; j < keys.length; j++) {
        const r = await classifyOne(gen, keys[j])
        cache.set(keys[j], r.category)
        onEvent({ key: keys[j], category: r.category, ms: r.ms, cached: false, descs: groups.get(keys[j])!, batch: { size: keys.length, ms: performance.now() - t0, first: j === 0, fellBack: true } })
      }
      continue
    }
    const key = keys[0]
    const r = await classifyOne(gen, key)
    cache.set(key, r.category)
    onEvent({ key, category: r.category, ms: r.ms, cached: false, descs: groups.get(key)! })
  }
  return cache
}
