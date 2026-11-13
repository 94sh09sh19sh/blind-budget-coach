import { describe, expect, it } from 'vitest'
import firebaseJson from '../firebase.json'
import indexHtml from '../index.html?raw'
import { cspPlugin, injectCspMeta } from '../vite-plugin-csp'
import { CSP_HOSTS, buildCsp, connectHostsForDisplay, hostsFor, scriptHostsForDisplay } from './csp'

/** 把政策字串拆成 { 指令: 來源[] } */
function parse(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const part of policy.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [name, ...values] = part.split(/\s+/)
    out[name] = values
  }
  return out
}

describe('Content-Security-Policy 的唯一來源', () => {
  const meta = buildCsp('meta')
  const header = buildCsp('header')

  it('firebase.json 對所有路徑送的標頭與 src/csp.ts 產生的標頭版完全一致', () => {
    const rules = firebaseJson.hosting.headers.filter((h) => h.headers.some((x) => x.key === 'Content-Security-Policy'))
    expect(rules.length).toBe(1)
    expect(rules[0].source).toBe('**')
    const csp = rules[0].headers.filter((x) => x.key === 'Content-Security-Policy')
    expect(csp.length).toBe(1)
    expect(csp[0].value).toBe(header)
  })

  it('firebase.json 原有的快取標頭仍在', () => {
    const keys = firebaseJson.hosting.headers.map((h) => `${h.source}:${h.headers.map((x) => x.key).join(',')}`)
    expect(keys).toContain('/sw.js:Cache-Control')
    expect(keys).toContain('/index.html:Cache-Control')
    expect(keys).toContain('/assets/**:Cache-Control')
  })

  it('meta 版 = 標頭版去掉 frame-ancestors（meta 不支援這個指令）', () => {
    expect(parse(header)['frame-ancestors']).toEqual(["'none'"])
    expect(meta).not.toContain('frame-ancestors')
    expect(header).toBe(`${meta}; frame-ancestors 'none'`)
  })

  it('沒有萬用字元、unsafe-eval、script 沒有 unsafe-inline、沒有 http: 或 data: 的指令碼來源', () => {
    for (const p of [meta, header]) {
      expect(p).not.toMatch(/\*/)
      expect(p).not.toContain('unsafe-eval')
      const d = parse(p)
      expect(d['script-src']).not.toContain("'unsafe-inline'")
      expect(d['script-src'].join(' ')).not.toMatch(/\bdata:|\bhttp:|\bblob:/)
      for (const v of Object.values(d).flat()) if (/^[a-z]+:\/\//.test(v)) expect(v.startsWith('https://')).toBe(true)
    }
  })

  it('固定的基本指令', () => {
    const d = parse(header)
    expect(d['default-src']).toEqual(["'self'"])
    expect(d['object-src']).toEqual(["'none'"])
    expect(d['base-uri']).toEqual(["'self'"])
    expect(d['form-action']).toEqual(["'none'"])
    expect(d['worker-src']).toEqual(["'self'"])
    expect(d['manifest-src']).toEqual(["'self'"])
  })

  it('允許清單的內容：連線、指令碼、框架各自的主機', () => {
    const d = parse(header)
    expect(d['connect-src']).toEqual([
      "'self'",
      'https://firebasevertexai.googleapis.com',
      'https://content-firebaseappcheck.googleapis.com',
      'https://www.google.com/recaptcha/',
    ])
    expect(d['script-src']).toEqual(["'self'", 'https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/'])
    expect(d['frame-src']).toEqual(['https://www.google.com/recaptcha/', 'https://recaptcha.google.com/recaptcha/'])
  })

  it('政策裡出現的外部來源都來自 CSP_HOSTS，沒有另外寫死的主機', () => {
    const known = new Set(CSP_HOSTS.map((h) => h.source))
    for (const v of Object.values(parse(header)).flat()) if (v.startsWith('https://')) expect(known.has(v)).toBe(true)
    // 反過來：CSP_HOSTS 的每一項都真的用到
    for (const h of CSP_HOSTS) expect(header).toContain(h.source)
  })

  it('介面用的主機清單與政策同源', () => {
    expect(connectHostsForDisplay()).toEqual(hostsFor('connect').map((s) => s.replace('https://', '')))
    expect(scriptHostsForDisplay()).toEqual(hostsFor('script').map((s) => s.replace('https://', '')))
    expect(connectHostsForDisplay()).toContain('firebasevertexai.googleapis.com')
  })
})

describe('vite 外掛', () => {
  it('只在建置時套用（開發伺服器不注入）', () => {
    expect(cspPlugin().apply).toBe('build')
  })

  it('真正的 index.html：meta 政策在 charset 之後、第一個載入資源的標籤之前，內容與 meta 版一致', () => {
    const out = injectCspMeta(indexHtml)
    expect(out.match(/http-equiv="Content-Security-Policy"/g)?.length).toBe(1)
    const content = /content="([^"]*)"/.exec(out.slice(out.indexOf('http-equiv="Content-Security-Policy"')))![1]
    expect(content.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')).toBe(buildCsp('meta'))
    const iCharset = out.indexOf('<meta charset')
    const iCsp = out.indexOf('http-equiv="Content-Security-Policy"')
    const iFirstResource = Math.min(...['<link', '<script'].map((t) => out.indexOf(t)).filter((i) => i >= 0))
    expect(iCharset).toBeGreaterThanOrEqual(0)
    expect(iCsp).toBeGreaterThan(iCharset)
    expect(iCsp).toBeLessThan(iFirstResource)
    // charset 必須在文件前 1024 位元組內
    expect(out.indexOf('<meta charset') + '<meta charset="UTF-8" />'.length).toBeLessThan(1024)
  })

  it('找不到 charset 標籤時丟錯，不默默略過', () => {
    expect(() => injectCspMeta('<html><head></head></html>')).toThrow()
  })
})
