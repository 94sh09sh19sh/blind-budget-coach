// Firebase 設定。目前是佔位值：任何一個欄位還是佔位值，雲端就視為未設定（只跑裝置端與本機）。
// 不要把金鑰或 debug token 寫進這個 repo；正式值之後由主線提供，建議改由 VITE_ 變數注入。
import { initializeApp, type FirebaseApp } from 'firebase/app'
import { getAI, GoogleAIBackend, type AI } from 'firebase/ai'

export const PLACEHOLDER = 'REPLACE_ME'

export const firebaseConfig = {
  apiKey: PLACEHOLDER,
  authDomain: PLACEHOLDER,
  projectId: PLACEHOLDER,
  storageBucket: PLACEHOLDER,
  messagingSenderId: PLACEHOLDER,
  appId: PLACEHOLDER,
}

export function isPlaceholderConfig(c: Record<string, string>): boolean {
  return Object.values(c).some((v) => !v || v === PLACEHOLDER)
}

/** 設定是佔位值時為 false：所有雲端功能停用，不會送出任何雲端請求。 */
export const CLOUD_CONFIGURED = !isPlaceholderConfig(firebaseConfig)

/** 雲端用的模型名稱（以 Firebase AI Logic 的 Gemini Developer API 為準）。 */
export const CLOUD_MODEL = 'gemini-2.5-flash'

let app: FirebaseApp | undefined
let ai: AI | undefined

/** 取得 AI Logic 物件。佔位設定下也能建立，裝置端模式不會連網。 */
export function getAi(): AI {
  if (!ai) {
    app = initializeApp(firebaseConfig)
    ai = getAI(app, { backend: new GoogleAIBackend() })
  }
  return ai
}
