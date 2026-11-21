import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import appSrc from '../App.tsx?raw'
import { ModelChoice } from '../ui/ModelChoice'
import { canUseModelNow, decideClassifyPath, RULES_CHOSEN_REASON, startingPhase } from './modelchoice'
import { NOT_DOWNLOADED_REASON, route } from './router'
import type { Availability } from './ondevice'

describe('按分類時走哪條路', () => {
  it('可下載或下載中：預設不自動下載，先問', () => {
    expect(decideClassifyPath('downloadable', false)).toBe('ask')
    expect(decideClassifyPath('downloading', false)).toBe('ask')
  })
  it('使用者選了下載之後才建立模型', () => {
    expect(decideClassifyPath('downloadable', true)).toBe('device')
    expect(decideClassifyPath('downloading', true)).toBe('device')
  })
  it('模型已可用：行為不變，直接用，不問', () => {
    expect(decideClassifyPath('available', false)).toBe('device')
    expect(decideClassifyPath('available', true)).toBe('device')
  })
  it('完全不可用：行為不變，本機規則，不問', () => {
    for (const a of ['unavailable', 'unsupported'] as Availability[]) {
      expect(decideClassifyPath(a, false)).toBe('rules')
      expect(decideClassifyPath(a, true)).toBe('rules')
    }
  })
  it('固定樣式（問答）只在模型已下載好時才用裝置端模型，否則會在背景觸發下載', () => {
    expect(canUseModelNow('available')).toBe(true)
    for (const a of ['downloadable', 'downloading', 'unavailable', 'unsupported', 'checking'] as const) expect(canUseModelNow(a)).toBe(false)
  })
})

describe('路由：模型還沒下載', () => {
  const base = { online: true, consent: false } as const
  it('分類走本機規則的路由，說明還沒下載、要使用者選，不是 ONLY_ON_DEVICE', () => {
    for (const level of ['public-sample', 'user-detail'] as const) {
      const r = route({ ...base, level, deviceModel: 'downloadable' })
      expect(r.mode).toBe('LOCAL_RULES')
      expect(r.side).toBe('rules')
      expect(r.reason).toBe(NOT_DOWNLOADED_REASON)
    }
    expect(NOT_DOWNLOADED_REASON).toContain('not downloaded')
    expect(NOT_DOWNLOADED_REASON).toContain('about 4 GB')
    expect(NOT_DOWNLOADED_REASON).toContain('local keyword rules')
  })
  it('已可用與完全不可用的路由不變', () => {
    expect(route({ ...base, level: 'public-sample', deviceModel: 'available' }).mode).toBe('ONLY_ON_DEVICE')
    expect(route({ ...base, level: 'user-detail', deviceModel: 'available' }).mode).toBe('ONLY_ON_DEVICE')
    expect(route({ ...base, level: 'public-sample', deviceModel: 'unavailable' }).mode).toBe('LOCAL_RULES')
    expect(route({ ...base, level: 'user-detail', deviceModel: 'unavailable' }).reason).toContain('unavailable')
  })
})

describe('選了本機規則的標示', () => {
  it('原因如實寫是規則、沒下載、沒有網路請求', () => {
    expect(RULES_CHOSEN_REASON).toContain('local keyword rules')
    expect(RULES_CHOSEN_REASON).toContain('instead of downloading')
    expect(RULES_CHOSEN_REASON).toContain('no network request')
    expect(RULES_CHOSEN_REASON).not.toMatch(/on-device model classified|classified by the on-device model/i)
  })
})

describe('ModelChoice 選項', () => {
  const html = (state: 'downloadable' | 'downloading') => renderToStaticMarkup(<ModelChoice state={state} onDownload={() => {}} onRules={() => {}} />)
  it('可下載：兩個選項、寫明約 4 GB、由 Chrome 下載一次、時間長、尚未開始', () => {
    const h = html('downloadable')
    expect(h).toContain('The on-device model is not downloaded yet')
    expect(h).toContain('Use local keyword rules now')
    expect(h).toContain('Download the model (about 4 GB), then classify')
    expect(h).toContain('about 4 GB')
    expect(h).toContain('done once by Chrome')
    expect(h).toContain('a long time')
    expect(h).toContain('The app has not started it')
    expect(h).toContain('No download and no cloud request')
    expect(h).toContain('Classify again')
  })
  it('預設焦點的那顆是「不下載」的選項（Use local keyword rules now 排在第一個）', () => {
    const h = html('downloadable')
    expect(h.indexOf('Use local keyword rules now')).toBeLessThan(h.indexOf('Download the model'))
  })
  it('下載中：說明 Chrome 已在下載，選項改為等待', () => {
    const h = html('downloading')
    expect(h).toContain('still downloading')
    expect(h).toContain('Wait for the download, then classify')
    expect(h).toContain('Use local keyword rules now')
  })
  it('不寫保證式用語', () => {
    for (const s of ['downloadable', 'downloading'] as const) expect(html(s)).not.toMatch(/\bnever\b|guarantee|nothing is uploaded/i)
  })
})

describe('App 的接線（原始碼順序）', () => {
  it('classify 先問路再建立模型；固定樣式的模型建立受 canUseModelNow 管', () => {
    const f = appSrc.indexOf('async function classify(')
    expect(f).toBeGreaterThan(0)
    const decide = appSrc.indexOf('decideClassifyPath(', f)
    const create = appSrc.indexOf('createClassifier(', f)
    expect(decide).toBeGreaterThan(f)
    expect(create).toBeGreaterThan(decide)
    expect(appSrc).toContain('canUseModelNow(avail)')
    // 按鈕本身不帶參數呼叫：事件物件不能被當成「已同意下載」
    expect(appSrc).toContain('onClick={() => classify()}')
    // 只有 ModelChoice 的下載按鈕傳 true
    expect(appSrc.match(/classify\(true\)/g)?.length).toBe(1)
  })
})

describe('按了下載之後的等待畫面（找錯第 12 項）', () => {
  it('選了下載而且還沒下載好：標題與說明寫正在下載約 4 GB、可能很久、重新整理可改用規則', () => {
    for (const a of ['downloadable', 'downloading'] as const) {
      expect(startingPhase(a, true)).toEqual({
        label: 'Downloading the on-device model (about 4 GB)',
        detail: 'Chrome downloads it once. This can take a long time; reload the page to use local keyword rules instead.',
      })
    }
  })
  it('模型已可用：照原本的文字', () => {
    expect(startingPhase('available', false)).toEqual({ label: 'Starting the on-device model', detail: 'First start takes about 15–40 s.' })
    expect(startingPhase('available', true)).toEqual({ label: 'Starting the on-device model', detail: 'First start takes about 15–40 s.' })
  })
  it('App 用 startingPhase 決定等待畫面的文字', () => {
    expect(appSrc).toContain('startPhase({ ...startingPhase(a, approvedDownload), where: \'device\' })')
  })
})
