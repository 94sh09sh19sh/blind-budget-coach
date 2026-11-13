import { describe, expect, it } from 'vitest'
import { classifyAll, type ClassifyEvent } from './ondevice'
import { isPayrollDeposit } from './rules'
import type { Category } from './categories'

describe('薪資入帳規則', () => {
  it('明顯的薪資入帳字樣命中', () => {
    expect(isPayrollDeposit('DIRECT DEP BRIGHTWAVE LLC')).toBe(true)
    expect(isPayrollDeposit('PAYROLL DIRECT DEP ACME CORP')).toBe(true)
    expect(isPayrollDeposit('direct deposit employer inc')).toBe(true)
    expect(isPayrollDeposit('SALARY JANUARY')).toBe(true)
    expect(isPayrollDeposit('PAYCHECK ACME')).toBe(true)
  })

  it('其他字串不命中（扣款、轉帳、別的詞裡剛好含有的字）', () => {
    expect(isPayrollDeposit('DIRECT DEBIT UTILITY CO')).toBe(false)
    expect(isPayrollDeposit('ONLINE TRANSFER TO SAVINGS')).toBe(false)
    expect(isPayrollDeposit('INTEREST PAID')).toBe(false)
    expect(isPayrollDeposit('PAYROLLER CAFE')).toBe(false)
    expect(isPayrollDeposit('CITY FRESH GROCERY')).toBe(false)
  })
})

describe('classifyAll 與薪資入帳規則', () => {
  // 假模型：記下被問到的字串；一律回 Transfers，用來確認規則命中的字串沒有送進模型
  const asked: string[] = []
  const fake = async (prompt: string) => {
    asked.push(prompt)
    return JSON.stringify('Transfers')
  }
  const descs = ['DIRECT DEP BRIGHTWAVE LLC', 'PAYROLL DIRECT DEP ACME CORP XX8851', 'POS PURCHASE CITY FRESH GROCERY STORE 8310']

  it('規則命中的字串直接判 Income、不問模型，事件標明 rule', async () => {
    asked.length = 0
    const ev: ClassifyEvent[] = []
    const r = await classifyAll(fake, descs, (e) => ev.push(e))
    expect(asked.length).toBe(1)
    expect(asked[0]).toContain('CITY FRESH GROCERY')
    expect(r.get('DIRECT DEP BRIGHTWAVE LLC')).toBe('Income')
    expect(r.get('PAYROLL DIRECT DEP ACME CORP')).toBe('Income')
    const rules = ev.filter((e) => e.rule)
    expect(rules.map((e) => e.key).sort()).toEqual(['DIRECT DEP BRIGHTWAVE LLC', 'PAYROLL DIRECT DEP ACME CORP'])
    expect(rules.every((e) => e.category === 'Income' && !e.cached && e.ms === 0)).toBe(true)
    // 模型判的那筆不能帶 rule 標記
    expect(ev.find((e) => e.key.includes('GROCERY'))?.rule).toBeUndefined()
  })

  it('使用者更正優先於薪資規則，且標為更正而不是規則', async () => {
    asked.length = 0
    const ev: ClassifyEvent[] = []
    const ov = new Map<string, Category>([['DIRECT DEP BRIGHTWAVE LLC', 'Transfers']])
    const r = await classifyAll(fake, ['DIRECT DEP BRIGHTWAVE LLC'], (e) => ev.push(e), ov)
    expect(r.get('DIRECT DEP BRIGHTWAVE LLC')).toBe('Transfers')
    expect(ev).toHaveLength(1)
    expect(ev[0].cached).toBe(true)
    expect(ev[0].rule).toBeUndefined()
    expect(asked.length).toBe(0)
  })

  it('批次路徑也不把規則命中的字串送進批次', async () => {
    const seen: string[] = []
    const gb = async (n: number, prompt: string) => {
      seen.push(prompt)
      return JSON.stringify(Array(n).fill('Shopping'))
    }
    const many = ['DIRECT DEP BRIGHTWAVE LLC', 'STORE ONE', 'STORE TWO']
    const r = await classifyAll(fake, many, () => {}, new Map(), { batchSize: 3, genBatch: gb })
    expect(r.get('DIRECT DEP BRIGHTWAVE LLC')).toBe('Income')
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toContain('BRIGHTWAVE')
    expect(seen[0]).toContain('STORE ONE')
  })
})
