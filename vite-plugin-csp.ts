// 正式建置時把 Content-Security-Policy 的 <meta> 注入 index.html。
// 只在 vite build 套用（apply: 'build'）：開發伺服器不注入，以免擋到熱更新；vite preview 讀的是已建置好的檔案，所以含 meta。
// 放在 <meta charset> 之後、其他所有會載入資源的標籤之前：meta 政策只管它之後出現的資源，
// 而 charset 必須在文件前 1024 位元組內，所以不放在最前面。找不到 charset 標籤就讓建置失敗，不默默略過。
import type { Plugin } from 'vite'
import { buildCsp } from './src/csp.ts'

const CHARSET = /<meta\s+charset="UTF-8"\s*\/?>/i

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 把 CSP meta 插在 charset meta 後面。匯出給單元測試用。 */
export function injectCspMeta(html: string): string {
  if (!CHARSET.test(html)) throw new Error('index.html 找不到 <meta charset="UTF-8">，無法決定 CSP meta 的位置')
  const tag = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(buildCsp('meta'))}" />`
  return html.replace(CHARSET, (m) => `${m}\n    ${tag}`)
}

export function cspPlugin(): Plugin {
  return {
    name: 'blind-budget-coach:csp-meta',
    apply: 'build',
    transformIndexHtml: { order: 'pre', handler: injectCspMeta },
  }
}
