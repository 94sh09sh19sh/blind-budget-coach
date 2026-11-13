import { describe, expect, it } from 'vitest'
import appSrc from '../App.tsx?raw'
import readme from '../../README.md?raw'
import { ADVICE_DISCLAIMER } from './disclosure'

describe('預算建議的界線', () => {
  it('說明是一般性預算建議，不是投資、稅務或個人財務顧問意見', () => {
    expect(ADVICE_DISCLAIMER).toContain('general budgeting suggestions')
    expect(ADVICE_DISCLAIMER).toContain('not investment, tax or personal financial advice')
  })
  it('預算建議區塊與 README 都有這段說明', () => {
    expect(appSrc).toContain('{ADVICE_DISCLAIMER}')
    expect(readme).toContain('not investment, tax or personal financial advice')
  })
  it('說明放在「Budget advice」區塊裡，在按鈕之前', () => {
    const i = appSrc.indexOf('id="advice-title"')
    const note = appSrc.indexOf('{ADVICE_DISCLAIMER}', i)
    const btn = appSrc.indexOf('Review what would be sent', i)
    expect(i).toBeGreaterThan(0)
    expect(note).toBeGreaterThan(i)
    expect(note).toBeLessThan(btn)
  })
})
