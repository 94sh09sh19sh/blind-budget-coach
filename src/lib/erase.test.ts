import { describe, expect, it } from 'vitest'
import appSrc from '../App.tsx?raw'
import cspSrc from '../csp.ts?raw'
import { ERASED_ELSEWHERE, openEraseChannel } from './erasechannel'

// 找錯報告第 6 項：Erase 在多分頁或分類進行中不持久。

describe('Erase 時通知同源的其他分頁', () => {
  it('另一個分頁收到通知；發出的分頁自己不會收到', async () => {
    let selfGot = 0
    const a = openEraseChannel(() => { selfGot++ })
    const got = new Promise<void>((resolve) => {
      const b = openEraseChannel(() => { b.close(); resolve() })
    })
    a.notify()
    await got
    await new Promise((r) => setTimeout(r, 20))
    a.close()
    expect(selfGot).toBe(0)
  })
  it('沒有 BroadcastChannel 的環境什麼都不做、不丟錯', () => {
    const saved = globalThis.BroadcastChannel
    try {
      // @ts-expect-error 模擬不支援的環境
      delete globalThis.BroadcastChannel
      const c = openEraseChannel(() => {})
      expect(() => { c.notify(); c.close() }).not.toThrow()
    } finally { globalThis.BroadcastChannel = saved }
  })
  it('BroadcastChannel 不是網路連線：Content-Security-Policy 不用多開任何主機', () => {
    expect(cspSrc).not.toMatch(/BroadcastChannel|broadcast/i)
  })
  it('其他分頁顯示的說明', () => {
    expect(ERASED_ELSEWHERE).toBe('Local data was erased in another tab of this app, so this tab was cleared too.')
  })
})

describe('App.tsx 的接法', () => {
  it('分類中或等雲端回應時停用 Erase 與所有載入按鈕', () => {
    expect(appSrc).toContain('<button className="btn btn-danger" disabled={busy || askBusy} onClick={erase}>Erase all local data</button>')
    expect(appSrc).toContain('disabled={busy || askBusy} onClick={() => loadSample(\'sample-statement-2.csv\')}>Try sample · 60 rows</button>')
    expect(appSrc).toContain('disabled={busy || askBusy} onClick={() => loadSample(\'sample-statement-1.csv\')}>Try sample · 247 rows</button>')
    expect(appSrc.match(/<DropZone[^>]*disabled=\{busy \|\| askBusy\}/g)).toHaveLength(2)
    // 拖放也擋
    expect(appSrc).toContain('if (!disabled) onFile(e.dataTransfer.files[0])')
  })
  it('Erase 會通知其他分頁；收到通知的分頁清掉記憶體裡的資料', () => {
    expect(appSrc).toContain('eraseChan.current?.notify()')
    expect(appSrc).toContain('openEraseChannel(() => clearTab(ERASED_ELSEWHERE))')
  })
  it('進行中的分類與問答在清除後不寫回、不顯示', () => {
    const classify = appSrc.slice(appSrc.indexOf('async function classify('), appSrc.indexOf('function classifyWithRules('))
    expect(classify).toContain('const erased = () => epoch.current !== ep')
    // 檢查點：查完可用狀態、模型建好、每個分類事件、分類結束存檔前、退回本機規則前
    expect(classify.match(/if \(erased\(\)\) (return|throw)/g)).toHaveLength(5)
    expect(classify).toMatch(/if \(erased\(\)\) return\s+setRunCounts\(counts\)/)
    expect(appSrc).toContain('if (epoch.current === ep) show(q, out)')
    expect(appSrc).toContain('if (epoch.current === ep) show(p.question, out)')
    expect(appSrc).toContain('if (epoch.current === ep) setAdvice(')
  })
})
