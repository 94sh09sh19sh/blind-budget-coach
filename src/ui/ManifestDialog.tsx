// 出境清單對話框：送出前把原文列給使用者看。用原生 <dialog> 的 showModal，焦點會被限制在框內，Esc 等同「不送」。
import { useEffect, useRef } from 'react'
import type { Manifest } from '../lib/cloudtasks'
import { IconCloud, IconDevice, IconGate } from './icons'

// 記住對話框以外最後一個有焦點的元素：按鈕一按下去就會暫時停用而失去焦點，開啟時再讀 activeElement 會是 body
let lastOutside: HTMLElement | null = null
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    const t = e.target
    if (t instanceof HTMLElement && !t.closest('dialog')) lastOutside = t
  })
}

export function ManifestDialog({ m, onSend, onCancel, cancelText }: { m: Manifest; onSend: () => void; onCancel: () => void; cancelText: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  const noRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const d = ref.current
    const opener = lastOutside
    if (d && !d.open) d.showModal()
    noRef.current?.focus()
    return () => {
      if (d?.open) d.close()
      // 對話框被移除時瀏覽器不會自動還焦點；按鈕在處理中可能暫時停用，等它恢復再還
      let tries = 0
      const back = () => {
        if (!opener || !opener.isConnected || document.activeElement !== document.body) return
        if (!(opener as HTMLButtonElement).disabled) { opener.focus(); return }
        if (++tries < 40) setTimeout(back, 150)
      }
      setTimeout(back, 0)
    }
  }, [])
  const kept = m.notIncluded.replace(/^Not included:\s*/i, '').split(/,\s*/)
  return (
    <dialog
      ref={ref}
      className="gate-dialog"
      aria-labelledby="gate-title"
      aria-describedby="gate-desc"
      onCancel={(e) => { e.preventDefault(); onCancel() }}
    >
      <header className="gd-head">
        <span className="gd-kicker"><IconGate size={16} /> Outbound gate · {m.mode}</span>
        <h2 id="gate-title">This exact text will leave your device</h2>
        <p id="gate-desc" className="gd-sub">
          <strong className="mono">{m.bytes.toLocaleString('en-US')} bytes</strong> of instructions, message and response structure. Headers and wrapping add a little on the wire; you can verify this in DevTools → Network.
        </p>
      </header>

      <div className="gd-body">
        <section className="gd-out" aria-label="Text that will be sent">
          <h3><IconCloud size={16} /> Leaves this device</h3>
          <div className="gd-label">Message</div>
          <pre className="gd-pre" tabIndex={0} aria-label="Message text">{m.prompt}</pre>
          <div className="gd-label">Instructions</div>
          <pre className="gd-pre gd-pre-long" tabIndex={0} aria-label="Instruction text">{m.system}</pre>
          <details className="gd-schema">
            <summary>Response structure sent with the request</summary>
            <pre className="gd-pre" tabIndex={0}>{JSON.stringify(m.schema, null, 1)}</pre>
          </details>
        </section>
        <section className="gd-keep" aria-label="Data that stays on this device">
          <h3><IconDevice size={16} /> Stays on this device</h3>
          <p className="gd-keep-lead">Not included:</p>
          <ul className="gd-keep-list">
            {kept.map((k) => <li key={k}>{k}</li>)}
          </ul>
          <p className="gd-keep-note">The answer comes back as a query plan or short text, and runs against your data here.</p>
        </section>
      </div>

      <footer className="gd-foot">
        <button ref={noRef} type="button" className="btn" onClick={onCancel}>{cancelText}</button>
        <button type="button" className="btn btn-send" onClick={onSend}>Send {m.bytes.toLocaleString('en-US')} bytes</button>
      </footer>
    </dialog>
  )
}
