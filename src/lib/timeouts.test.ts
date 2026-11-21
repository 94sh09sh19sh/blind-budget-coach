import { afterEach, describe, expect, it, vi } from 'vitest'
import { AVAILABILITY_TIMEOUT_MS, checkAvailability } from './ondevice'
import { AskSession, DEVICE_CHOOSE_TIMEOUT_MS, askCloud, askFixed, buildPlanManifest } from './cloudtasks'
import type { TimelineEntry } from './router'

// 找錯報告第 11 項：availability() 與固定樣式的裝置端呼叫沒有逾時。

afterEach(() => { vi.unstubAllGlobals() })

describe('checkAvailability 的等待上限', () => {
  it('預設 5 秒', () => {
    expect(AVAILABILITY_TIMEOUT_MS).toBe(5_000)
  })
  it('availability() 一直不回：逾時當成 unavailable（分類改走本機規則）', async () => {
    vi.stubGlobal('LanguageModel', { availability: () => new Promise(() => {}) })
    expect(await checkAvailability(10)).toBe('unavailable')
  })
  it('有回應時照原本的值；丟錯時 unavailable；沒有 Prompt API 時 unsupported', async () => {
    vi.stubGlobal('LanguageModel', { availability: async () => 'available' })
    expect(await checkAvailability(1000)).toBe('available')
    vi.stubGlobal('LanguageModel', { availability: async () => { throw new Error('x') } })
    expect(await checkAvailability(1000)).toBe('unavailable')
    vi.stubGlobal('LanguageModel', undefined)
    expect(await checkAvailability(1000)).toBe('unsupported')
  })
})

describe('固定樣式的裝置端呼叫的等待上限', () => {
  const mk = (deviceChoose: (q: string) => Promise<string>, deviceTimeoutMs?: number) => {
    const logs: Omit<TimelineEntry, 'id' | 'at'>[] = []
    return { logs, deps: { log: (e: Omit<TimelineEntry, 'id' | 'at'>) => { logs.push(e) }, now: () => 0, deviceChoose, deviceTimeoutMs } }
  }
  it('預設 60 秒（與分類單筆相同）', () => {
    expect(DEVICE_CHOOSE_TIMEOUT_MS).toBe(60_000)
  })
  it('裝置端模型一直不回：逾時後退回關鍵字比對，原因寫在時間線與答案說明', async () => {
    const { deps, logs } = mk(() => new Promise(() => {}), 500)
    const r = await askFixed(new AskSession(), deps, 'How much did I spend on Groceries?', 'Using a fixed pattern.')
    expect(r.source).toBe('rules')
    expect(r.plan).toEqual({ filter: { categories: ['Groceries'] }, aggregate: 'sum' })
    expect(r.note).toBe('Fixed pattern chosen by keywords. The on-device model did not answer within 1 s. Using a fixed pattern.')
    expect(logs.map((l) => [l.side, l.reason])).toEqual([
      ['device', 'The on-device model did not answer within 1 s. Using a fixed pattern.'],
      ['rules', 'The on-device model did not answer within 1 s. Using a fixed pattern.'],
    ])
  })
  it('雲端失敗後退回固定樣式時也一樣（不會停在等待畫面）', async () => {
    const { deps } = mk(() => new Promise(() => {}), 500)
    const q = 'What are my top spending categories?'
    const r = await askCloud(new AskSession(), { ...deps, cloud: async () => { throw new Error('offline') } }, q, buildPlanManifest(q, [], '2026-12-10', 1))
    expect(r.source).toBe('rules')
    expect(r.plan).not.toBeNull()
  })
  it('有回應時行為不變：用裝置端的選擇，說明不提逾時', async () => {
    const { deps, logs } = mk(async () => JSON.stringify({ pattern: 'monthly_spend' }))
    const r = await askFixed(new AskSession(), deps, 'How much do I spend each month?', 'Using a fixed pattern.')
    expect(r.source).toBe('device')
    expect(r.note).toBe('Fixed pattern chosen on device. Using a fixed pattern.')
    expect(logs.map((l) => l.reason)).toEqual(['Using a fixed pattern.'])
  })
})
