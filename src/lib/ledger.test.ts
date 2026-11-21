import { describe, expect, it } from 'vitest'
import appSrc from '../App.tsx?raw'
import { AskSession, askAdvice, askCloud, buildAdviceManifest, buildPlanManifest, type AskDeps, type Manifest } from './cloudtasks'
import type { CloudCall } from './ai'
import type { TimelineEntry } from './router'
import { LEDGER_PENDING, appendRow, finishRow, type LedgerEntry } from './store'

// 找錯報告第 5 項：帳本與 bytes sent 少記已送出的請求。
// 情境 A：PREFER_IN_CLOUD 的雲端呼叫失敗、SDK 改由裝置端模型回答（時間線是 Device），帳本原本不記。
// 情境 B：按 Send 之後、回應之前重新整理或關分頁，帳本原本沒有這次請求。

const COLS = [{ name: 'Date', type: 'date' as const }, { name: 'Description', type: 'text' as const }, { name: 'Amount', type: 'number' as const }]
const Q = 'How much did I spend on Groceries?'
const GOOD = JSON.stringify({ filter: { categories: ['Groceries'] }, aggregate: 'sum' })

/** 照 App.tsx 的 beforeCloud 與 log：送出前寫一列（結果欄是 LEDGER_PENDING），回來後補上結果；只收帶位元組的列，不看 side */
function appLedger() {
  let ledger: LedgerEntry[] = []
  let id = 0
  let sent: { id: number; at: number } | null = null
  const order: string[] = []
  const timeline: Omit<TimelineEntry, 'id' | 'at'>[] = []
  const deps = (cloud: CloudCall, extra: Partial<AskDeps> = {}): AskDeps => ({
    cloud: async (req) => { order.push('cloud'); return cloud(req) },
    now: () => 0,
    beforeCloud: (m: Manifest) => {
      order.push('before')
      const row: LedgerEntry = { id: ++id, at: 1000 + id, task: m.task, mode: m.mode, bytes: m.bytes, system: m.system, prompt: m.prompt, schema: m.schema, outcome: LEDGER_PENDING }
      sent = { id: row.id, at: row.at }
      ledger = appendRow(ledger, row)
    },
    log: (e) => {
      order.push(`log:${e.side}`)
      timeline.push(e)
      if (e.bytesSent > 0 && sent) { ledger = finishRow(ledger, sent, { at: 5000 + id, outcome: e.reason }); sent = null }
    },
    ...extra,
  })
  return { deps, order, timeline, get ledger() { return ledger } }
}

describe('帳本的純函式', () => {
  const row = (id: number, at: number, outcome = LEDGER_PENDING): LedgerEntry => ({ id, at, task: 't', mode: 'PREFER_IN_CLOUD', bytes: 10, system: 's', prompt: 'p', schema: {}, outcome })
  it('appendRow：沒有舊資料也能追加', () => {
    expect(appendRow(undefined, row(1, 1))).toEqual([row(1, 1)])
    expect(appendRow([row(1, 1, 'x')], row(2, 2))).toEqual([row(1, 1, 'x'), row(2, 2)])
  })
  it('finishRow：只換 id 與送出時間都相同的那一列，其他列（含別的分頁同 id 的列）不動', () => {
    const l = [row(5, 100, 'old'), row(5, 200), row(6, 300)]
    expect(finishRow(l, { id: 5, at: 200 }, { at: 250, outcome: 'Plan accepted.' })).toEqual([row(5, 100, 'old'), row(5, 250, 'Plan accepted.'), row(6, 300)])
    expect(finishRow(l, { id: 9, at: 1 }, { at: 2, outcome: 'x' })).toEqual(l)
    expect(finishRow(undefined, { id: 5, at: 200 }, { at: 2, outcome: 'x' })).toEqual([])
  })
})

describe('情境 A：雲端失敗、SDK 改由裝置端回答', () => {
  it('時間線是 Device，帳本仍記這一列，原因寫明', async () => {
    const a = appLedger()
    const m = buildPlanManifest(Q, COLS, '2026-12-10', 60)
    const out = await askCloud(new AskSession(), a.deps(async () => ({ text: GOOD, source: 'device' })), Q, m)
    expect(out.source).toBe('device')
    expect(a.timeline.map((e) => [e.side, e.bytesSent])).toEqual([['device', m.bytes]])
    expect(a.ledger).toHaveLength(1)
    expect(a.ledger[0]).toMatchObject({ bytes: m.bytes, prompt: m.prompt, outcome: 'The cloud call failed, so the SDK let the on-device model answer. Plan accepted.' })
  })
  it('App.tsx 寫帳本的條件不看 side', () => {
    expect(appSrc).toContain('if (e.bytesSent > 0 && m) {')
    expect(appSrc).not.toMatch(/e\.side === 'cloud' && e\.bytesSent > 0/)
  })
})

describe('情境 B：送出前先寫一列，回來再補結果', () => {
  it('問答：送出前寫、雲端呼叫、寫時間線，依這個順序；成功後結果欄是原本的文字', async () => {
    const a = appLedger()
    const m = buildPlanManifest(Q, COLS, '2026-12-10', 60)
    await askCloud(new AskSession(), a.deps(async () => ({ text: GOOD, source: 'cloud' })), Q, m)
    expect(a.order).toEqual(['before', 'cloud', 'log:cloud'])
    expect(a.ledger.map((e) => e.outcome)).toEqual(['Plan accepted.'])
  })
  it('計畫被退回重試：每次送出各一列', async () => {
    const a = appLedger()
    let n = 0
    await askCloud(new AskSession(), a.deps(async () => ({ text: n++ === 0 ? '{"aggregate":"median"}' : GOOD, source: 'cloud' })), Q, buildPlanManifest(Q, COLS, '2026-12-10', 60))
    expect(a.order).toEqual(['before', 'cloud', 'log:cloud', 'before', 'cloud', 'log:cloud'])
    expect(a.ledger.map((e) => e.outcome)).toEqual(['Plan rejected (aggregate must be sum, count or avg); retrying once.', 'Plan accepted.'])
  })
  it('雲端丟錯：結果欄寫失敗原因', async () => {
    const a = appLedger()
    await askCloud(new AskSession(), a.deps(async () => { throw new Error('503 overloaded') }), Q, buildPlanManifest(Q, COLS, '2026-12-10', 60))
    expect(a.ledger).toHaveLength(1)
    expect(a.ledger[0].outcome).toMatch(/^Call failed: /)
  })
  it('答案回來之前頁面就關了：帳本已經有這一列（結果欄停在 LEDGER_PENDING）', async () => {
    const a = appLedger()
    const m = buildPlanManifest(Q, COLS, '2026-12-10', 60)
    void askCloud(new AskSession(), a.deps(() => new Promise(() => {})), Q, m)
    await Promise.resolve()
    expect(a.ledger).toHaveLength(1)
    expect(a.ledger[0]).toMatchObject({ bytes: m.bytes, prompt: m.prompt, outcome: LEDGER_PENDING })
  })
  it('預算建議也一樣', async () => {
    const a = appLedger()
    const tips = { tips: [1, 2, 3].map((i) => ({ title: `T${i}`, detail: `D${i}` })) }
    await askAdvice(new AskSession(), a.deps(async () => ({ text: JSON.stringify(tips), source: 'cloud' })), buildAdviceManifest({ Groceries: 60, Dining: 40 }, 10))
    expect(a.order).toEqual(['before', 'cloud', 'log:cloud'])
    expect(a.ledger.map((e) => e.outcome)).toEqual(['Advice accepted.'])
  })
  it('App.tsx：deps 帶 beforeCloud；重新整理後停在 LEDGER_PENDING 的列顯示成沒有記到答案', () => {
    expect(appSrc).toContain('const d: AskDeps = { log, beforeCloud,')
    expect(appSrc).toContain('e.outcome === LEDGER_PENDING && waitingRow !== e.id ? LEDGER_NO_ANSWER : e.outcome')
  })
})
