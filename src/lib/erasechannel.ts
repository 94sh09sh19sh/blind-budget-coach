// 按 Erase 時通知同一個瀏覽器裡、同一個來源開著的其他分頁，讓它們也清掉畫面上的資料，不再把舊資料寫回 IndexedDB。
// BroadcastChannel 只在同一個瀏覽器、同一個來源的分頁之間傳訊，不經網路、不連到任何主機；
// Content-Security-Policy 沒有管它的指令，所以不用改允許清單。不支援的環境就什麼都不做。

const NAME = 'blind-budget-coach:erase'

export interface EraseChannel {
  /** 告訴其他分頁：本機資料已清除（自己不會收到自己發的訊息） */
  notify: () => void
  close: () => void
}

export function openEraseChannel(onErasedElsewhere: () => void): EraseChannel {
  if (typeof BroadcastChannel === 'undefined') return { notify: () => {}, close: () => {} }
  const ch = new BroadcastChannel(NAME)
  ch.onmessage = (e: MessageEvent) => {
    if (e.data && typeof e.data === 'object' && (e.data as { type?: unknown }).type === 'erased') onErasedElsewhere()
  }
  return { notify: () => ch.postMessage({ type: 'erased' }), close: () => ch.close() }
}

/** 別的分頁按了 Erase 之後，這個分頁顯示的說明 */
export const ERASED_ELSEWHERE = 'Local data was erased in another tab of this app, so this tab was cleared too.'
