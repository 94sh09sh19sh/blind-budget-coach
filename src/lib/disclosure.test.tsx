import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { appCheckDisclosure, appCheckMode, byteCountNote, cspNote } from './disclosure'
import { buildAdviceManifest, buildPlanManifest } from './cloudtasks'
import { ManifestDialog, QUESTION_AS_TYPED } from '../ui/ManifestDialog'

describe('App Check 方式的判斷（與 firebase.ts 共用）', () => {
  it('有網站金鑰的正式建置是 recaptcha，不會是 debug', () => {
    expect(appCheckMode({ dev: false, siteKey: 'KEY' })).toBe('recaptcha')
    expect(appCheckMode({ dev: false, siteKey: 'KEY', debugToken: 'T' })).toBe('recaptcha')
  })
  it('開發模式有除錯權杖是 debug（優先於網站金鑰）', () => {
    expect(appCheckMode({ dev: true, debugToken: 'T' })).toBe('debug')
    expect(appCheckMode({ dev: true, debugToken: 'T', siteKey: 'KEY' })).toBe('debug')
  })
  it('開發模式只有網站金鑰時仍會載入 reCAPTCHA', () => {
    expect(appCheckMode({ dev: true, siteKey: 'KEY' })).toBe('recaptcha')
  })
  it('兩者都沒有（或是空字串）就是 off', () => {
    expect(appCheckMode({ dev: false })).toBe('off')
    expect(appCheckMode({ dev: true, debugToken: '', siteKey: '' })).toBe('off')
  })
})

describe('揭露文字', () => {
  it('recaptcha：寫出 reCAPTCHA、主機、無法逐字列出與去哪看，不用保證式用語', () => {
    const d = appCheckDisclosure('recaptcha')!
    expect(d.text).toContain('reCAPTCHA')
    expect(d.text).toContain('www.google.com')
    expect(d.text).toContain('www.gstatic.com')
    expect(d.text).toContain('content-firebaseappcheck.googleapis.com')
    expect(d.text).toContain('signals from your browser and device')
    expect(d.text).toContain('cannot be listed here word for word')
    expect(d.text).toContain('DevTools')
    expect(`${d.heading} ${d.text}`).not.toMatch(/\bnever\b|guarantee/i)
  })
  it('debug：較短，明說不載入 reCAPTCHA', () => {
    const r = appCheckDisclosure('recaptcha')!
    const d = appCheckDisclosure('debug')!
    expect(d.text.length).toBeLessThan(r.text.length)
    expect(d.text).toContain('does not load reCAPTCHA')
    expect(d.text).toContain('debug token')
    expect(`${d.heading} ${d.text}`).not.toMatch(/\bnever\b|guarantee/i)
  })
  it('off：沒有額外說明', () => {
    expect(appCheckDisclosure('off')).toBeNull()
  })
  it('recaptcha：寫明權杖不在背景續期、過期後下一次送出才換（firebase.ts 的 isTokenAutoRefreshEnabled: false）', () => {
    expect(appCheckDisclosure('recaptcha')!.text).toContain('The app sets App Check not to refresh that token in the background; when it has expired, the next send gets a new one the same way.')
  })
  it('位元組說明：只算清單上的文字，不說是送出的全部', () => {
    for (const mode of ['recaptcha', 'debug', 'off'] as const) {
      const t = byteCountNote(mode)
      expect(t).toContain('is the size of only the text listed below')
      expect(t).toContain('larger')
      expect(t).not.toMatch(/\bnever\b|guarantee|everything|all of what/i)
    }
    expect(byteCountNote('recaptcha')).toContain('App Check traffic')
    expect(byteCountNote('off')).not.toContain('App Check')
  })
})

describe('CSP 說明（雲端欄）', () => {
  it('套用時列出主機並說明去哪確認', () => {
    const t = cspNote(true)
    expect(t).toContain('firebasevertexai.googleapis.com')
    expect(t).toContain('content-firebaseappcheck.googleapis.com')
    expect(t).toContain('www.google.com/recaptcha/')
    expect(t).toContain('www.gstatic.com/recaptcha/')
    expect(t).toContain('page source')
    expect(t).toContain('response headers')
    expect(t).not.toContain('not applied')
  })
  it('沒套用（開發模式）時如實說沒套用，不宣稱已強制', () => {
    const t = cspNote(false)
    expect(t).toContain('No Content-Security-Policy is applied')
    expect(t).toContain('development builds do not apply it')
    expect(t).not.toContain('enforces')
  })
})

describe('出境清單對話框的輸出', () => {
  const m = buildPlanManifest('How much do I spend each month?', [{ name: 'Date', type: 'date' }], '2026-11-13', 60)
  const html = (mode: 'recaptcha' | 'debug' | 'off') =>
    renderToStaticMarkup(<ManifestDialog m={m} onSend={() => {}} onCancel={() => {}} cancelText="Don't send" appCheck={mode} />)

  it('recaptcha 建置：對話框含 reCAPTCHA 揭露與精確的位元組說明', () => {
    const h = html('recaptcha')
    expect(h).toContain('Also happens when you send: App Check and reCAPTCHA')
    expect(h).toContain('cannot be listed here word for word')
    expect(h).toContain('is the size of only the text listed below')
    expect(h).toContain(`Send this text · ${m.bytes.toLocaleString('en-US')} bytes`)
  })
  it('debug：只有較短的除錯權杖說明，沒有 reCAPTCHA 的揭露標題', () => {
    const h = html('debug')
    expect(h).toContain('App Check (development build)')
    expect(h).toContain('does not load reCAPTCHA')
    expect(h).not.toContain('Also happens when you send: App Check and reCAPTCHA')
  })
  it('off：沒有額外區塊', () => {
    const h = html('off')
    expect(h).not.toContain('Also happens when you send')
    expect(h).not.toContain('gd-extra')
  })
  it('問答：右欄寫明問題原樣送出（問題裡打了商家名稱時，Not included 的 merchants 指的是對帳單）', () => {
    const q = buildPlanManifest('How much did I spend at OAKWOOD APARTMENTS?', [{ name: 'Date', type: 'date' }], '2026-12-10', 60)
    const h = renderToStaticMarkup(<ManifestDialog m={q} onSend={() => {}} onCancel={() => {}} cancelText="Don't send" appCheck="recaptcha" />)
    expect(h).toContain('OAKWOOD APARTMENTS')
    expect(h).toContain('Your question is sent as you typed it, including any merchant names, dates or amounts in it.')
    expect(QUESTION_AS_TYPED).not.toMatch(/\bnever\b|guarantee/i)
  })
  it('預算建議：沒有問題文字，不加這一句', () => {
    const a = buildAdviceManifest({ Groceries: 60, Dining: 40 }, 60)
    const h = renderToStaticMarkup(<ManifestDialog m={a} onSend={() => {}} onCancel={() => {}} cancelText="Don't send" appCheck="recaptcha" />)
    expect(h).not.toContain('Your question is sent as you typed it')
  })
})
