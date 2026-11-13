// Content-Security-Policy 的唯一定義處。
// 讀它的地方：vite-plugin-csp.ts（正式建置時把 <meta> 注入 index.html）、介面（列出允許的主機）、
// 單元測試（確認 firebase.json 的回應標頭與這裡一致）。firebase.json 是靜態檔，內容必須與 buildCsp('header') 相同。
// 本檔不碰 DOM、不碰 Vite，Node 與瀏覽器都能載入。

export type CspUse = 'connect' | 'script' | 'frame'

export interface CspHost {
  /** 寫進政策的來源運算式（含協定；有路徑的是路徑前綴比對） */
  source: string
  /** 給人看的說明（英文，介面會用到） */
  what: string
  /** 允許用在哪些指令 */
  use: readonly CspUse[]
}

/**
 * 除了 'self' 以外，這個頁面被允許連到的主機。來源：
 * - firebasevertexai.googleapis.com：firebase/ai 的 DEFAULT_DOMAIN，雲端的 generateContent 請求。
 * - content-firebaseappcheck.googleapis.com：firebase/app-check 的 BASE_ENDPOINT，換 App Check 權杖。
 * - www.google.com/recaptcha/、www.gstatic.com/recaptcha/、recaptcha.google.com/recaptcha/：
 *   firebase/app-check 的 ReCaptchaEnterpriseProvider 動態載入 https://www.google.com/recaptcha/enterprise.js，
 *   指令碼、框架與連線的主機清單依 Google 官方文件「reCAPTCHA 與 CSP」一節。
 * 沒有萬用字元主機。reCAPTCHA 只在設定了網站金鑰的建置才會被載入，但政策是靜態的，所以所有正式建置都列出來。
 */
export const CSP_HOSTS: readonly CspHost[] = [
  { source: 'https://firebasevertexai.googleapis.com', what: 'Gemini through Firebase AI Logic', use: ['connect'] },
  { source: 'https://content-firebaseappcheck.googleapis.com', what: 'Firebase App Check token exchange', use: ['connect'] },
  { source: 'https://www.google.com/recaptcha/', what: 'reCAPTCHA Enterprise (script, frames, requests)', use: ['script', 'frame', 'connect'] },
  { source: 'https://www.gstatic.com/recaptcha/', what: 'reCAPTCHA scripts', use: ['script'] },
  { source: 'https://recaptcha.google.com/recaptcha/', what: 'reCAPTCHA frames', use: ['frame'] },
]

/** 某個用途（連線、指令碼、框架）被允許的外部來源，原樣（含協定與路徑）。 */
export function hostsFor(use: CspUse): string[] {
  return CSP_HOSTS.filter((h) => h.use.includes(use)).map((h) => h.source)
}

/** 給人看的寫法：去掉 https://，保留路徑。 */
export function displayHost(source: string): string {
  return source.replace(/^https:\/\//, '')
}

/**
 * 不依主機清單的固定指令，都沒有放寬：
 * - style-src 只有 'self'（沒有 'unsafe-inline'）：建置出的 CSS 是同源檔案；React 的行內樣式（寬度條）走 CSSOM，不受 style-src 限制；
 *   reCAPTCHA 的徽章也是用 CSSOM 設樣式（2026-11-13 在 localhost 預覽實測，按 Send 載入 reCAPTCHA 後沒有任何 CSP 違規，徽章樣式正常套用）。
 *   若部署後主控台出現 style-src 或 style-src-attr 的違規且來源是 reCAPTCHA，才需要放寬，見 README「Network allow-list」。
 * - img-src 只有 'self'：沒有 data: 圖片；PWA 圖示與 favicon 都是同源檔案。
 * - form-action 'none'：頁面的 <form> 都在 onSubmit 裡 preventDefault，沒有真正的表單送出（實測送出提問時沒有違規）。
 * - worker-src 'self'：service worker（sw.js 與 workbox 檔）都是同源。
 */
const FIXED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['style-src', ["'self'"]],
  ['img-src', ["'self'"]],
  ['worker-src', ["'self'"]],
  ['manifest-src', ["'self'"]],
  ['object-src', ["'none'"]],
  ['base-uri', ["'self'"]],
  ['form-action', ["'none'"]],
]

/**
 * 組出政策字串。
 * - 'meta'：放進 <meta http-equiv>；瀏覽器不支援 frame-ancestors，所以沒有。
 * - 'header'：Firebase Hosting 的回應標頭；多一個 frame-ancestors 'none'（不讓別的網站用框架嵌入這個頁面）。
 */
export function buildCsp(kind: 'meta' | 'header'): string {
  const parts: Array<readonly [string, readonly string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", ...hostsFor('script')]],
    ['connect-src', ["'self'", ...hostsFor('connect')]],
    ['frame-src', hostsFor('frame')],
    ...FIXED,
  ]
  if (kind === 'header') parts.push(['frame-ancestors', ["'none'"]] as const)
  return parts.map(([name, values]) => [name, ...values].join(' ')).join('; ')
}

/** 介面用：允許連線的主機（不含 'self'）。 */
export function connectHostsForDisplay(): string[] {
  return hostsFor('connect').map(displayHost)
}

/** 介面用：允許載入指令碼的主機（不含 'self'）。 */
export function scriptHostsForDisplay(): string[] {
  return hostsFor('script').map(displayHost)
}
