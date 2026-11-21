// 讀檔檢查：讀到 0 筆時的說明、部分列讀不懂時的提示。
// 全部是純函式，結果只在本機顯示在畫面上；出境清單由 cloudtasks.ts 組成，不讀這裡的任何結果，所以不會進雲端請求。
import { isSplit, type ColumnMap, type ParsedCsv, type Tx } from './csv'
import { isoDate } from './plan'

const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`

/** 讀到 0 筆時一律附上的說明：需要哪幾欄 */
export const NEEDED_COLUMNS = 'Each transaction needs a date, a description and an amount column (or Debit and Credit columns).'

/** 小數點用逗號的金額（12,34、1.234,56），parseAmount 不支援 */
const DECIMAL_COMMA = /\d,\d{1,2}(?!\d)|\.\d{3},/

/** UTF-16、試算表或 PDF 被當成 UTF-8 文字讀進來時，前段會出現 NUL 或替代字元 */
export function looksBinary(text: string): boolean {
  const head = text.slice(0, 4000)
  return head.includes('\u0000') || head.includes('�')
}

/** 標題看起來是一筆資料（日期或金額）：檔案可能沒有標題列 */
function looksLikeData(h: string): boolean {
  const t = h.trim()
  return isoDate(t) !== null || /^\(?[-+−]?\$?\d[\d,]*(\.\d+)?\)?-?$/.test(t)
}

/** 畫面上列出的欄位名稱：去掉控制字元、太長的截斷、最多 8 個 */
function columnList(headers: string[]): string {
  const names = headers.slice(0, 8).map((h) => {
    const t = [...h].filter((c) => { const n = c.codePointAt(0)!; return n >= 0x20 && n !== 0x7f && n !== 0xfffd }).join('').trim()
    return `"${t.length > 30 ? `${t.slice(0, 29).trimEnd()}…` : t}"`
  })
  return names.join(', ') + (headers.length > 8 ? ` and ${headers.length - 8} more` : '')
}

/** 金額欄裡有沒有小數點用逗號的寫法 */
function hasDecimalComma(p: ParsedCsv, m: ColumnMap): boolean {
  const keys = isSplit(m) ? [m.debit, m.credit] : [m.amount]
  return p.rows.some((r) => keys.some((k) => DECIMAL_COMMA.test((r[k] ?? '').trim())))
}
const DECIMAL_COMMA_NOTE = ' (amounts with a decimal comma, such as 12,34, are not supported)'

/**
 * 讀到 0 筆交易時的說明（英文，顯示在畫面上）；有讀到交易回傳 null。
 * kept：畫面上原本就有資料。這時不換掉它，說明裡也寫明。
 */
export function loadError(o: { fileName: string; text: string; parsed: ParsedCsv; cols: ColumnMap; txs: Tx[]; kept: boolean }): string | null {
  if (o.txs.length > 0) return null
  const { parsed: p, cols } = o
  const parts = [`Could not read any transactions from ${o.fileName}.`]
  if (looksBinary(o.text)) {
    parts.push('It does not look like a plain-text CSV file. Save or export it as CSV (UTF-8) and try again.', NEEDED_COLUMNS)
  } else if (p.headers.length === 0) {
    parts.push('The file is empty.', NEEDED_COLUMNS)
  } else {
    parts.push(`It has ${plural(p.rows.length, 'row')} below the first line. Column names found: ${columnList(p.headers)}.`)
    if (p.headers.some(looksLikeData)) parts.push('The first line looks like a transaction, so the file may have no header line.')
    parts.push(NEEDED_COLUMNS)
    const missing = [!cols.date && 'date', !cols.description && 'description', !cols.amount && !isSplit(cols) && 'amount'].filter((x): x is string => !!x)
    if (missing.length) parts.push(`No column was recognized for: ${missing.join(', ')}.`)
    else if (p.rows.length) parts.push(`No row had both a description and an amount that could be read${hasDecimalComma(p, cols) ? DECIMAL_COMMA_NOTE : ''}.`)
  }
  if (o.kept) parts.push('The statement on screen was not changed.')
  return parts.join(' ')
}

/** 有讀到交易、但部分列讀不懂時的提示（略過的列、讀不懂的日期）；都讀得懂回傳 null。 */
export function loadWarning(p: ParsedCsv, cols: ColumnMap, txs: Tx[]): string | null {
  if (txs.length === 0) return null
  const parts: string[] = []
  const skipped = p.rows.length - txs.length
  if (skipped > 0) {
    parts.push(`${skipped.toLocaleString('en-US')} of ${plural(p.rows.length, 'row')} ${skipped === 1 ? 'was' : 'were'} skipped because the description or amount could not be read${hasDecimalComma(p, cols) ? DECIMAL_COMMA_NOTE : ''}.`)
  }
  if (!cols.date) {
    parts.push('No date column was recognized, so date filters leave every row out. You can choose one under Columns.')
  } else {
    const bad = txs.filter((t) => isoDate(t.date) === null).length
    if (bad > 0) {
      const them = bad === 1 ? 'it' : 'them'
      parts.push(`${plural(bad, 'transaction')} ${bad === 1 ? 'has a date' : 'have dates'} this app cannot read (it reads YYYY-MM-DD, M/D/YYYY and M/D/YY), so date filters leave ${them} out and the monthly view lists ${them} as unknown.`)
    }
  }
  return parts.length ? parts.join(' ') : null
}
