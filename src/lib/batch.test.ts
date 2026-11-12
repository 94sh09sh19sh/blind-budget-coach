import { describe, expect, it } from 'vitest'
import { batchPrompt, batchSchema, classifyAll, parseBatch, type ClassifyEvent, type GenBatch } from './ondevice'
import type { Category } from './categories'

// 單筆假模型：依字串內容決定類別
const single = async (prompt: string) => JSON.stringify(prompt.includes('CAFE') ? 'Dining' : 'Shopping')

describe('批次分類', () => {
  const descs = ['CAFE ONE', 'STORE TWO', 'CAFE THREE', 'STORE FOUR', 'CAFE FIVE']
  const goodBatch: GenBatch = async (n, prompt) => {
    const lines = prompt.split('\n').filter((l) => /^\d+\. /.test(l))
    expect(lines.length).toBe(n)
    return JSON.stringify(lines.map((l) => (l.includes('CAFE') ? 'Dining' : 'Shopping')))
  }

  it('結構是固定長度的 enum 陣列', () => {
    const s = batchSchema(3)
    expect(s.minItems).toBe(3)
    expect(s.maxItems).toBe(3)
    expect(s.items.enum).toContain('Dining')
    expect(batchPrompt(['A', 'B'])).toBe('Descriptions:\n1. A\n2. B\nCategories:')
  })

  it('parseBatch：數量不符、不合法類別、非 JSON 都回 null', () => {
    expect(parseBatch('["Dining","Health"]', 2)).toEqual(['Dining', 'Health'])
    expect(parseBatch('["Dining"]', 2)).toBeNull()
    expect(parseBatch('["Dining","Nope"]', 2)).toBeNull()
    expect(parseBatch('{"a":1}', 1)).toBeNull()
    expect(parseBatch('not json', 1)).toBeNull()
  })

  it('每批一次呼叫，事件逐字串發出且標明批次', async () => {
    const calls: number[] = []
    const gb: GenBatch = (n, p) => { calls.push(n); return goodBatch(n, p) }
    const ev: ClassifyEvent[] = []
    const r = await classifyAll(single, descs, (e) => ev.push(e), new Map(), { batchSize: 3, genBatch: gb })
    expect(calls).toEqual([3, 2])
    expect(r.get('CAFE ONE')).toBe('Dining')
    expect(r.get('STORE FOUR')).toBe('Shopping')
    expect(ev.filter((e) => e.batch?.first).length).toBe(2)
    expect(ev.every((e) => e.batch && !e.batch.fellBack)).toBe(true)
    expect(ev.slice(0, 3).every((e) => e.batch!.size === 3)).toBe(true)
  })

  it('數量不符時該批退回逐筆', async () => {
    const bad: GenBatch = async () => '["Dining"]'
    const ev: ClassifyEvent[] = []
    const r = await classifyAll(single, descs, (e) => ev.push(e), new Map(), { batchSize: 5, genBatch: bad })
    expect(ev.length).toBe(5)
    expect(ev.every((e) => e.batch?.fellBack)).toBe(true)
    expect(r.get('CAFE FIVE')).toBe('Dining')
    expect(r.get('STORE TWO')).toBe('Shopping')
  })

  it('解析失敗或丟錯時退回逐筆，其他批不受影響', async () => {
    let k = 0
    const flaky: GenBatch = async (n, p) => {
      if (k++ === 0) return 'garbage'
      return goodBatch(n, p)
    }
    const ev: ClassifyEvent[] = []
    const r = await classifyAll(single, descs, (e) => ev.push(e), new Map(), { batchSize: 3, genBatch: flaky })
    expect(ev.slice(0, 3).every((e) => e.batch!.fellBack)).toBe(true)
    expect(ev.slice(3).every((e) => !e.batch!.fellBack)).toBe(true)
    expect(r.size).toBe(5)
    const thrower: GenBatch = async () => { throw new Error('boom') }
    const r2 = await classifyAll(single, descs, () => {}, new Map(), { batchSize: 5, genBatch: thrower })
    expect(r2.get('CAFE ONE')).toBe('Dining')
  })

  it('使用者更正優先於模型，也不送進批次', async () => {
    const seen: string[] = []
    const gb: GenBatch = (n, p) => { seen.push(p); return goodBatch(n, p) }
    const ov = new Map<string, Category>([['CAFE ONE', 'Health']])
    const r = await classifyAll(single, descs, () => {}, ov, { batchSize: 5, genBatch: gb })
    expect(r.get('CAFE ONE')).toBe('Health')
    expect(seen.join('')).not.toContain('CAFE ONE')
  })

  it('batchSize 為 1 或沒給 genBatch 時維持逐筆', async () => {
    const ev: ClassifyEvent[] = []
    await classifyAll(single, descs, (e) => ev.push(e), new Map(), { batchSize: 1 })
    await classifyAll(single, descs, (e) => ev.push(e), new Map(), { batchSize: 5 })
    expect(ev.every((e) => !e.batch)).toBe(true)
  })
})

describe('固定樣式與出境清單', () => {
  it('選了不送（固定樣式）之後，同一題仍可再走出境清單', async () => {
    const { AskSession, askFixed } = await import('./cloudtasks')
    const session = new AskSession()
    const out = await askFixed(session, { log: () => {} }, 'What are my top spending categories?', 'test')
    expect(out.plan).not.toBeNull()
    expect(session.cache.has(AskSession.key('What are my top spending categories?'))).toBe(false)
    expect((await askFixed(session, { log: () => {} }, 'What are my top spending categories?', 'test')).cached).toBe(true)
  })
})
