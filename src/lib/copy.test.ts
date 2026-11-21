import { describe, expect, it } from 'vitest'
import appSrc from '../App.tsx?raw'
import dialogSrc from '../ui/ManifestDialog.tsx?raw'
import disclosureSrc from './disclosure.ts?raw'
import routerSrc from './router.ts?raw'
import loadcheckSrc from './loadcheck.ts?raw'
import storeSrc from './store.ts?raw'
import indexHtml from '../../index.html?raw'
import readme from '../../README.md?raw'

// 介面文案的守門：偏絕對、無法由頁面程式行為驗證的句子不再出現。
// 每一句都要寫這個頁面的程式實際做什麼，以及使用者可以在哪裡自己確認（出境清單、DevTools Network）。

/** 去掉單行註解：註解是中文說明，裡面可以提到被禁的字。 */
const noComments = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const UI_FILES: Array<[string, string]> = [
  ['App.tsx', noComments(appSrc)],
  ['ManifestDialog.tsx', noComments(dialogSrc)],
  ['disclosure.ts', noComments(disclosureSrc)],
  ['router.ts', noComments(routerSrc)],
  ['loadcheck.ts', noComments(loadcheckSrc)],
  ['store.ts', noComments(storeSrc)],
  ['index.html', indexHtml],
]

const FORBIDDEN: RegExp[] = [
  /not uploaded/i,
  /without uploading/i,
  /only through/i,
  /not part of the request/i,
  /sees only/i,
  /nothing is uploaded/i,
  /nothing has left/i,
  /shown to you first/i,
  /\bnever\b/i,
  /\bguarantee/i,
]

describe('介面文案：不用保證式或無法驗證的說法', () => {
  for (const [name, src] of UI_FILES) {
    it(`${name} 沒有被禁的句子`, () => {
      for (const re of FORBIDDEN) expect(src, `${name} 含 ${re}`).not.toMatch(re)
    })
  }
  it('README 沒有被禁的句子（不含引用型的歷史描述）', () => {
    for (const re of [/not uploaded/i, /without uploading/i, /only through/i, /sees only/i, /nothing is uploaded/i, /nothing has left/i, /shown to you first/i]) {
      expect(readme, `README 含 ${re}`).not.toMatch(re)
    }
  })
})

describe('改寫後的句子', () => {
  it('頁首、空狀態標題、步驟三、雲端欄說明', () => {
    expect(appSrc).toContain('The text of each cloud request is listed for you before it is sent.')
    expect(appSrc).toContain('Classify your statement on this device, and check what leaves it')
    expect(appSrc).toContain('A question goes to the cloud only after you approve its exact text at the gate.')
    expect(appSrc).toContain('This page makes a cloud request only after you press Send in the outbound gate, which lists the exact text first.')
    expect(appSrc).toContain('You can check this in DevTools → Network.')
  })
  it('等待說明與沒有模型時的說明', () => {
    expect(appSrc).toContain('The request is the text you approved in the dialog.')
    expect(appSrc).toContain('Local keyword rules, run in this page. This step makes no network request.')
  })
  it('index.html 的描述', () => {
    expect(indexHtml).toContain('The text of each cloud request is listed for you before it is sent, and you can check it.')
  })
  it('路由說明對應實際送出的內容', () => {
    expect(routerSrc).toContain('The text listed in the dialog (your question and the column structure) is sent')
    expect(routerSrc).toContain('You approved the text listed in the dialog (category percentages); it has no transactions.')
  })
})
