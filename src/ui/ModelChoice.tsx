// 裝置端模型還沒下載時，按「Classify」之後出現的選項：不自動下載，由使用者選。
// 預設焦點在「用本機規則」那顆（不下載的選項），避免連按 Enter 就開始約 4 GB 的下載。
import { useEffect, useRef } from 'react'
import { IconDevice, IconRules } from './icons'

export function ModelChoice({ state, onDownload, onRules }: { state: 'downloadable' | 'downloading'; onDownload: () => void; onRules: () => void }) {
  const rulesRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { rulesRef.current?.focus() }, [])
  const downloading = state === 'downloading'
  return (
    <section className="card modelchoice" role="group" aria-labelledby="mc-title">
      <h3 id="mc-title" className="card-title">{downloading ? 'The on-device model is still downloading' : 'The on-device model is not downloaded yet'}</h3>
      <p className="mc-lead">
        {downloading
          ? 'Chrome is already downloading it (about 4 GB). Classifying with the model has to wait for that to finish.'
          : 'Classifying with the model needs a download first: about 4 GB, done once by Chrome, which can take a long time. The app has not started it. Choose how to classify this time.'}
      </p>
      <div className="mc-options">
        <div className="mc-option">
          <button ref={rulesRef} type="button" className="btn btn-primary" onClick={onRules}><IconRules size={16} /> Use local keyword rules now</button>
          <p className="fine">No download and no cloud request. Rows the rules do not recognize stay uncategorized until you pick a category.</p>
        </div>
        <div className="mc-option">
          <button type="button" className="btn" onClick={onDownload}><IconDevice size={16} /> {downloading ? 'Wait for the download, then classify' : 'Download the model (about 4 GB), then classify'}</button>
          <p className="fine">Chrome downloads it once; progress is shown here. Classification starts when it finishes.</p>
        </div>
      </div>
      <p className="fine">You can choose again any time with "Classify again". Neither option makes a cloud request from this page. The download itself is done by Chrome and does not appear in the page&apos;s Network panel.</p>
    </section>
  )
}
