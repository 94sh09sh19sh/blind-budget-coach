// Firebase 設定的空殼。Firebase 專案尚未建立，所有值刻意留空，不要填任何金鑰。
// TODO: 專案建好後，把網頁應用的設定值填入（或改由 import.meta.env 的 VITE_ 變數讀取）。
// TODO: 啟用 AI Logic（Gemini Developer API）後，用 getAI + getGenerativeModel 加 InferenceMode 接雲端路徑。
// TODO: 啟用 App Check。
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
}

/** 目前沒有任何雲端接線；介面上的雲端功能一律停用。 */
export const CLOUD_ENABLED = false
