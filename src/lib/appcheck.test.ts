import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app'
import { CustomProvider, initializeAppCheck } from 'firebase/app-check'
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'firebase/ai'
import firebaseSrc from '../firebase.ts?raw'

// 找錯報告第 9 項：App Check 不在背景自動續期。
// 用實際安裝的 firebase/app-check 與 firebase/ai 跑：權杖由測試自己的 CustomProvider 發（不連 reCAPTCHA），
// fetch 換成假的（不連任何主機），檢查「初始化後背景不換權杖」與「權杖過期後的第一次送出會先換到新權杖再送」。

const CONFIG = { apiKey: 'test-key', authDomain: 'x', projectId: 'demo-test', storageBucket: 'x', messagingSenderId: '1', appId: '1:1:web:1' }
const BODY = { candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ text: '{"aggregate":"sum"}' }] } }] }

const apps: FirebaseApp[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  while (apps.length) await deleteApp(apps.pop()!)
})

/** 發權杖的提供者：記下被呼叫幾次；每張權杖的效期由 ttl 決定 */
function provider(ttl: () => number) {
  const calls: number[] = []
  const p = new CustomProvider({
    getToken: async () => {
      calls.push(Date.now())
      return { token: `token-${calls.length}`, expireTimeMillis: Date.now() + ttl() }
    },
  })
  return { p, calls }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('App Check 權杖：關掉自動續期', () => {
  it('firebase.ts 的 reCAPTCHA 設定是 isTokenAutoRefreshEnabled: false', () => {
    expect(firebaseSrc).toContain('isTokenAutoRefreshEnabled: false')
    expect(firebaseSrc).not.toContain('isTokenAutoRefreshEnabled: true')
  })

  it('對照：設 true 時，初始化後沒有任何請求也會自己去換權杖', async () => {
    const app = initializeApp(CONFIG, 'auto-on'); apps.push(app)
    const { p, calls } = provider(() => 3_600_000)
    initializeAppCheck(app, { provider: p, isTokenAutoRefreshEnabled: true })
    await wait(50)
    expect(calls.length).toBeGreaterThan(0)
  })

  /** 假的 fetch：記下每次請求帶的 App Check 權杖，回一個合法的 generateContent 回應 */
  function fakeFetch() {
    const sent: (string | null)[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('X-Firebase-AppCheck'))
      return new Response(JSON.stringify(BODY), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    return sent
  }
  function cloudModel(name: string, ttl: number) {
    const app = initializeApp(CONFIG, name); apps.push(app)
    const prov = provider(() => ttl)
    // 與 firebase.ts 相同的順序：先 App Check，再 getAI
    initializeAppCheck(app, { provider: prov.p, isTokenAutoRefreshEnabled: false })
    const model = getGenerativeModel(getAI(app, { backend: new GoogleAIBackend() }), { mode: InferenceMode.ONLY_IN_CLOUD, inCloudParams: { model: 'test-model' } })
    return { model, calls: prov.calls }
  }

  it('設 false：初始化後背景不換權杖；第一次送出時才換，權杖有效期間用快取', async () => {
    const sent = fakeFetch()
    const { model, calls } = cloudModel('auto-off', 3_600_000)
    await wait(50)
    expect(calls).toHaveLength(0)
    await model.generateContent('one')
    expect(calls).toHaveLength(1)
    await model.generateContent('two')
    expect(calls).toHaveLength(1)
    expect(sent).toEqual(['token-1', 'token-1'])
  })

  it('設 false：權杖過期後背景不換；過期後的第一次送出先換到新權杖，請求帶新權杖並成功', async () => {
    const sent = fakeFetch()
    const { model, calls } = cloudModel('auto-off-short', 30)
    await model.generateContent('a')
    await wait(80)
    expect(calls).toHaveLength(1)
    const r = await model.generateContent('b')
    expect(r.response.text()).toBe('{"aggregate":"sum"}')
    expect(calls).toHaveLength(2)
    expect(sent).toEqual(['token-1', 'token-2'])
  })
})
