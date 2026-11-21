// 裝置端模型「可下載但還沒下載」時的處理：不自動下載（約 4 GB），先讓使用者選。純函式，單元測試直接驗。
import type { Availability } from './ondevice'

export type ClassifyPath =
  | 'device' // 模型可用，或使用者已同意下載：建立模型並分類
  | 'ask' // 可下載或下載中，使用者還沒選：先顯示選項，不碰模型
  | 'rules' // 完全不可用：本機關鍵字規則

/**
 * 按「Classify」時走哪條路。
 * 只有 downloadable／downloading 會問使用者；available 與 unavailable／unsupported 的行為不變。
 * approvedDownload 只在使用者按了「Download the model」那次為 true，不會被記住。
 */
export function decideClassifyPath(a: Availability, approvedDownload: boolean): ClassifyPath {
  if (a === 'available') return 'device'
  if (a === 'downloadable' || a === 'downloading') return approvedDownload ? 'device' : 'ask'
  return 'rules'
}

/** 固定樣式（問答）能不能現在就用裝置端模型：只有已下載好的才行，否則會在背景觸發下載。 */
export function canUseModelNow(a: Availability | 'checking'): boolean {
  return a === 'available'
}

/**
 * 按分類後、建立裝置端模型時等待畫面的標題與說明。
 * 使用者按了「Download the model」而且模型還沒下載好時，Chrome 要先下載約 4 GB，可能要幾十分鐘：
 * 不能寫成「約 15–40 秒」，改說明正在下載、可能很久、重新整理就能改用本機規則。
 */
export function startingPhase(a: Availability, approvedDownload: boolean): { label: string; detail: string } {
  if (approvedDownload && a !== 'available') {
    return {
      label: 'Downloading the on-device model (about 4 GB)',
      detail: 'Chrome downloads it once. This can take a long time; reload the page to use local keyword rules instead.',
    }
  }
  return { label: 'Starting the on-device model', detail: 'First start takes about 15–40 s.' }
}

/** 使用者選了本機規則時，寫進時間線與摘要的原因。 */
export const RULES_CHOSEN_REASON =
  'You chose local keyword rules instead of downloading the on-device model. This step makes no network request.'
