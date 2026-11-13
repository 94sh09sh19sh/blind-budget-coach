// 路由函式：依「資料等級、裝置端模型可用性、是否連線、使用者是否同意」決定模式。規則照構想報告 13.1 的表。
export type DataLevel =
  | 'user-detail' // 使用者自己的明細：絕不上雲
  | 'public-sample' // 內附的公開合成示範資料
  | 'schema-only' // 只有欄位結構，沒有明細
  | 'aggregate' // 使用者按同意的類別比例

export type Mode =
  | 'ONLY_ON_DEVICE'
  | 'PREFER_IN_CLOUD'
  | 'ONLY_IN_CLOUD'
  | 'LOCAL_RULES' // 本機關鍵字規則（不經任何模型）
  | 'DISABLED' // 該功能目前不可用（例如沒連線又需要雲端）

export type Side = 'device' | 'cloud' | 'rules' | 'none'

export interface RouteInput {
  level: DataLevel
  deviceModel: 'available' | 'unavailable'
  online: boolean
  consent: boolean
}

export interface RouteDecision {
  mode: Mode
  /** 實際會在哪一端執行 */
  side: Side
  reason: string
}

export function route(i: RouteInput): RouteDecision {
  const dev = i.deviceModel === 'available'
  switch (i.level) {
    case 'user-detail':
      return dev
        ? { mode: 'ONLY_ON_DEVICE', side: 'device', reason: 'Your own transactions are classified on this device and are not sent.' }
        : { mode: 'LOCAL_RULES', side: 'rules', reason: 'On-device model unavailable; using local keyword rules. This step makes no network request.' }
    case 'public-sample':
      // 分類一律以 ONLY_ON_DEVICE 呼叫 SDK（示範資料也一樣）：改用 PREFER_ON_DEVICE 的話，沒有模型時 SDK 會不經出境清單就送雲端
      if (dev) return { mode: 'ONLY_ON_DEVICE', side: 'device', reason: 'Public sample data; classified by the on-device model.' }
      // 沒有裝置端模型時，示範資料也走本機規則，分類不上雲
      return { mode: 'LOCAL_RULES', side: 'rules', reason: 'Public sample data; on-device model unavailable, using local keyword rules. This step makes no network request.' }
    case 'schema-only':
      if (i.online && i.consent) return { mode: 'PREFER_IN_CLOUD', side: 'cloud', reason: 'Only column structure is shared; cloud writes the query plan.' }
      return dev
        ? { mode: 'PREFER_IN_CLOUD', side: 'device', reason: i.online ? 'No consent to send the schema; picking a fixed query pattern on device.' : 'Offline; picking one of the fixed query patterns on device.' }
        : { mode: 'LOCAL_RULES', side: 'rules', reason: 'Cloud and on-device model unavailable; using fixed local query patterns.' }
    case 'aggregate':
      return i.online && i.consent
        ? { mode: 'ONLY_IN_CLOUD', side: 'cloud', reason: 'You approved sharing category ratios only; no transactions are included.' }
        : { mode: 'DISABLED', side: 'none', reason: i.online ? 'Needs your consent to send category ratios.' : 'Offline; budget advice needs the cloud.' }
  }
}

/** 時間線紀錄：每次呼叫一列，進透明面板。 */
export interface TimelineEntry {
  id: number
  at: number // epoch ms
  task: string
  mode: Mode
  side: Side
  ms: number
  bytesSent: number
  reason: string
}
