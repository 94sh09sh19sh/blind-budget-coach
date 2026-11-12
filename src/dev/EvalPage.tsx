// 只在開發模式、網址帶 ?eval=1 時載入（main.tsx 以 import.meta.env.DEV 把關，正式建置會整段剔除）。
// 評測資料不放在本 repo：由外部腳本經 CDP 呼叫 window.__runEval(rows, n) 傳入。
import { classifyAll, classifyOne, createBatchClassifier, createClassifier, type ClassifyEvent } from '../lib/ondevice'
import { normalizeDesc } from '../lib/normalize'

export interface EvalRow { desc: string; label: string }
export interface EvalResult {
  n: number
  rows: number
  unique: number
  accuracy: number
  totalMs: number
  msPerUnique: number
  batches: number
  fellBackBatches: number
}

async function runEval(rows: EvalRow[], n: number): Promise<EvalResult> {
  const single = await createClassifier()
  const batch = n > 1 ? createBatchClassifier() : null
  // 暖機：不計入耗時（第一次呼叫會載入模型）
  await classifyOne(single.generate, 'COFFEE SHOP')
  if (batch) {
    await batch.warm([n])
    await batch.generate(n, Array.from({ length: n }, (_, i) => `${i + 1}. COFFEE SHOP`).join('\n'))
  }
  const events: ClassifyEvent[] = []
  const t0 = performance.now()
  const cache = await classifyAll(single.generate, rows.map((r) => r.desc), (e) => events.push(e), new Map(), { batchSize: n, genBatch: batch?.generate })
  const totalMs = performance.now() - t0
  let ok = 0
  for (const r of rows) if (cache.get(normalizeDesc(r.desc)) === r.label) ok++
  const model = events.filter((e) => !e.cached)
  const batchEvents = model.filter((e) => e.batch && e.batch.first)
  return {
    n,
    rows: rows.length,
    unique: cache.size,
    accuracy: ok / rows.length,
    totalMs,
    msPerUnique: totalMs / Math.max(1, cache.size),
    batches: batchEvents.length,
    fellBackBatches: batchEvents.filter((e) => e.batch!.fellBack).length,
  }
}

;(window as unknown as { __runEval: typeof runEval }).__runEval = runEval

export default function EvalPage() {
  return <p style={{ font: '14px system-ui', padding: 16 }}>Dev eval harness. Call window.__runEval(rows, n) from a script.</p>
}
