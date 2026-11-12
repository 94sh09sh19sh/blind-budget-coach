// Firebase 設定。值由 VITE_ 環境變數注入（見 .env.example）；repo 裡不放任何設定值、金鑰或 debug token。
// 任何一個欄位沒填，雲端就視為未設定：只跑裝置端與本機規則，不會送出任何雲端請求。
import { initializeApp, type FirebaseApp } from 'firebase/app'
import { getAI, GoogleAIBackend, type AI } from 'firebase/ai'
import { CustomProvider, ReCaptchaEnterpriseProvider, initializeAppCheck } from 'firebase/app-check'

export const PLACEHOLDER = 'REPLACE_ME'

const env = import.meta.env

export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || PLACEHOLDER,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || PLACEHOLDER,
  projectId: env.VITE_FIREBASE_PROJECT_ID || PLACEHOLDER,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || PLACEHOLDER,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || PLACEHOLDER,
  appId: env.VITE_FIREBASE_APP_ID || PLACEHOLDER,
}

export function isPlaceholderConfig(c: Record<string, string>): boolean {
  return Object.values(c).some((v) => !v || v === PLACEHOLDER)
}

/** 設定沒填齊時為 false：所有雲端功能停用，不會送出任何雲端請求。 */
export const CLOUD_CONFIGURED = !isPlaceholderConfig(firebaseConfig)

/** 雲端用的模型名稱（Firebase AI Logic 的 Gemini Developer API；不需帳單的模型）。 */
export const CLOUD_MODEL = 'gemini-3.5-flash-lite'

let deviceAi: AI | undefined
let cloudAi: AI | undefined

/**
 * 裝置端推論用的 AI Logic 物件。掛在預設的 Firebase app 上，這個 app 不啟用 App Check，
 * 所以分類自己的明細時，頁面不會為了它發出任何網路請求。佔位設定下也能建立。
 */
export function getAi(): AI {
  if (!deviceAi) {
    deviceAi = getAI(initializeApp(firebaseConfig), { backend: new GoogleAIBackend() })
  }
  return deviceAi
}

/**
 * 雲端推論用的 AI Logic 物件。另開一個具名的 Firebase app，第一次雲端呼叫（使用者按同意之後）才建立，
 * App Check 也在這時才啟用。SDK 在建立 AI 物件當下讀取 App Check，所以順序必須是先 App Check 再 getAI。
 */
export function getCloudAi(): AI {
  if (!cloudAi) {
    const cloudApp = initializeApp(firebaseConfig, 'cloud')
    setupAppCheck(cloudApp)
    cloudAi = getAI(cloudApp, { backend: new GoogleAIBackend() })
  }
  return cloudAi
}

function setupAppCheck(app: FirebaseApp): void {
  // debug token 只在開發模式讀，而且只放在不進 repo 的 .env.development.local；正式建置不會帶到。
  const debugToken: string | undefined = env.DEV ? env.VITE_APPCHECK_DEBUG_TOKEN : undefined
  const siteKey: string | undefined = env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY
  if (debugToken) {
    ;(self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken
    // 除錯模式下 SDK 直接拿 debug token 換權杖，不會呼叫這個提供者；放它只是因為 initializeAppCheck 需要一個。
    initializeAppCheck(app, {
      provider: new CustomProvider({ getToken: () => Promise.reject(new Error('App Check debug mode only')) }),
    })
  } else if (siteKey) {
    initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(siteKey), isTokenAutoRefreshEnabled: true })
  }
  // 兩者都沒有：不啟用 App Check；專案若已強制 App Check，雲端呼叫會被拒並顯示錯誤。
}
