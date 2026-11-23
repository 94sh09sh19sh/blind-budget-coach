// 規則式的店家字串清理（當快取鍵用）。移植自投件期前寫的探測腳本 normalize.mjs，純 regex，不用模型。
const CITY_STATE =
  /\b(SEATTLE WA|AUSTIN TX|NEW YORK NY|DENVER CO|CHICAGO IL|PORTLAND OR|BOSTON MA|ATLANTA GA|SAN JOSE CA|MIAMI FL)\b/g

export function normalizeDesc(s: string): string {
  let t = s.toUpperCase()
  t = t.replace(
    /^(POS PURCHASE|DEBIT CARD PURCHASE|CHECKCARD|PURCHASE AUTHORIZED ON \d{1,2}\/\d{1,2}|RECURRING PAYMENT|VISA|SQ \*|TST\*|PAYPAL \*)\s*/,
    '',
  )
  t = t
    .replace(/\bVISA ENDING \d{4}\b/g, '')
    .replace(/\bCARD \d{4}\b/g, '')
    .replace(/\bXX\d{4}\b/g, '')
    .replace(/\*\d{4}\b/g, '')
    .replace(/\bREF \d+\b/g, '')
    .replace(/\bAUTH \d+\b/g, '')
    .replace(/\b\d{1,2}\/\d{1,2}\b/g, '')
    .replace(/#\d+/g, '')
    .replace(/\bSTORE \d+\b/g, '')
    .replace(/\bNO\.\d+\b/g, '')
    .replace(/\b\d{4,6}\b/g, '')
    .replace(CITY_STATE, '')
  return t.replace(/\s+/g, ' ').trim()
}
