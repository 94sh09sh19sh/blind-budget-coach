// 出境清單與頁面上的固定揭露文字（英文，介面直接顯示）。純函式，不碰 SDK 與 DOM，單元測試直接檢查字串。
// 原則：只寫我們實際知道的；不用「never」「guarantee」這類保證式用語。
import { connectHostsForDisplay, scriptHostsForDisplay } from '../csp'

/**
 * 第一次雲端呼叫時 App Check 會怎麼做：
 * - recaptcha：設了 VITE_RECAPTCHA_ENTERPRISE_SITE_KEY 的建置，載入 reCAPTCHA Enterprise 並換權杖。
 * - debug：開發模式且設了除錯權杖，只拿除錯權杖換 App Check 權杖，不載入 reCAPTCHA。
 * - off：兩者都沒設，不啟用 App Check。
 * 判斷條件與 src/firebase.ts 的 setupAppCheck 相同（那裡也呼叫這個函式）。
 */
export type AppCheckMode = 'recaptcha' | 'debug' | 'off'

export function appCheckMode(i: { dev: boolean; debugToken?: string; siteKey?: string }): AppCheckMode {
  if (i.dev && i.debugToken) return 'debug'
  if (i.siteKey) return 'recaptcha'
  return 'off'
}

export interface Disclosure {
  heading: string
  text: string
}

/** 出境清單裡「清單以外也會發生的事」。off 時沒有額外的 App Check 流量，回傳 null。 */
export function appCheckDisclosure(mode: AppCheckMode): Disclosure | null {
  if (mode === 'recaptcha') {
    return {
      heading: 'Also happens when you send: App Check and reCAPTCHA',
      text:
        'To show Google that the request comes from this app, the page also uses Firebase App Check. ' +
        'The first time you send, it loads Google reCAPTCHA (scripts from www.google.com and www.gstatic.com). ' +
        'reCAPTCHA reads signals from your browser and device, and the result is exchanged for an App Check token at content-firebaseappcheck.googleapis.com. ' +
        'The app does not give App Check or reCAPTCHA your statement, your transactions or any question text beyond what is listed above. ' +
        'What reCAPTCHA itself reads and sends is decided by Google’s script, so it cannot be listed here word for word. ' +
        'You can see these requests in DevTools → Network.',
    }
  }
  if (mode === 'debug') {
    return {
      heading: 'Also happens when you send: App Check (development build)',
      text:
        'This development build exchanges an App Check debug token for an App Check token at content-firebaseappcheck.googleapis.com. ' +
        'It does not load reCAPTCHA. ' +
        'The app does not give App Check your statement, your transactions or any question text beyond what is listed above.',
    }
  }
  return null
}

/** 預算建議區塊的固定說明：依支出比例給的一般性建議，不是專業意見。 */
export const ADVICE_DISCLAIMER =
  'These are general budgeting suggestions based on your spending shares. They are not investment, tax or personal financial advice.'

/**
 * 出境清單標題下的位元組說明：計數只算清單上的文字，不是整個請求。
 * 回傳的字串接在「N bytes」後面（介面把 N bytes 加粗）。
 */
export function byteCountNote(mode: AppCheckMode): string {
  return (
    ' is the size of only the text listed below (instructions, message and response structure, as UTF-8). ' +
    'The request on the wire is larger: it also carries HTTP headers and JSON wrapping' +
    (mode === 'off' ? '. ' : ', and sending triggers the App Check traffic described below. ') +
    'Compare it in DevTools → Network.'
  )
}

/** 英文清單：a, b and c */
function joinList(xs: string[]): string {
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}

/**
 * 雲端欄的 CSP 說明。applied 是「這個頁面的 HTML 裡真的找得到 CSP 的 meta」，
 * 不是建置模式的推測：沒套用就如實說沒套用。主機清單與政策出自同一個來源（src/csp.ts）。
 */
export function cspNote(applied: boolean): string {
  const connect = joinList(['this site', ...connectHostsForDisplay()])
  const scripts = joinList(['this site', ...scriptHostsForDisplay()])
  return applied
    ? `Your browser enforces a Content-Security-Policy on this page: requests made by the page’s code (fetch, XHR) are limited to ${connect}, and scripts may load only from ${scripts}. Check the policy in the page source (a meta tag) or in the response headers.`
    : `No Content-Security-Policy is applied to this page: development builds do not apply it, so the host list is not enforced here. Production builds limit the page’s requests to ${connect}, and scripts to ${scripts}; the policy is in the page source (a meta tag) and in the response headers.`
}
