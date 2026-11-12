// 裝置端分類（經 Firebase AI Logic 的 ONLY_ON_DEVICE）。設定照 j1-probe 評測最佳組合：
// 清理後店家字串去重快取、enum 結構化輸出、只留類別定義的系統提示。
import { CATEGORIES, SYSTEM_PROMPT, isCategory, type Category } from './categories'
import { normalizeDesc } from './normalize'
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
}

/**
 * 逐筆分類：依清理後字串去重，同字串只問模型一次（結果快取；overrides 為使用者更正，優先於模型）。
 * 每完成一個不重複字串就呼叫 onEvent，讓介面逐筆亮起。
 */
export async function classifyAll(
  gen: Gen,
  descs: string[],
  onEvent: (e: ClassifyEvent) => void,
  overrides: Map<string, Category> = new Map(),
): Promise<Map<string, Category | null>> {
  const groups = new Map<string, string[]>()
  for (const d of descs) {
    const k = normalizeDesc(d)
    groups.set(k, [...(groups.get(k) ?? []), d])
  }
  const cache = new Map<string, Category | null>()
  for (const [key, group] of groups) {
    const o = overrides.get(key)
    if (o) {
      cache.set(key, o)
      onEvent({ key, category: o, ms: 0, cached: true, descs: group })
      continue
    }
    const r = await classifyOne(gen, key)
    cache.set(key, r.category)
    onEvent({ key, category: r.category, ms: r.ms, cached: false, descs: group })
  }
  return cache
}
