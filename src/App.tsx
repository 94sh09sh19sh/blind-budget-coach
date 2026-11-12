import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { CATEGORIES, type Category } from './lib/categories'
import { detectSign, guessColumns, isSplit, parseCsv, toTransactions, type ColumnMap, type ParsedCsv, type SignMode, type Tx } from './lib/csv'
import { classifyAll, checkAvailability, createClassifier, type Availability } from './lib/ondevice'
import { classifyByRules } from './lib/rules'
import { normalizeDesc } from './lib/normalize'
import { spendByCategory, type Classified } from './lib/aggregate'
import { route, type DataLevel, type TimelineEntry } from './lib/router'
import { CLOUD_CONFIGURED } from './firebase'
import { createDeviceModel, firebaseCloudCall, type DeviceModel } from './lib/ai'
import { EXAMPLE_QUESTIONS, PATTERN_SCHEMA, PATTERN_SYSTEM, runPlan, type PlanResult } from './lib/plan'
import {
  AskSession, askAdvice, askCloud, askFixed, buildAdviceManifest, buildPlanManifest, categoryShares,
  type Advice, type AskDeps, type AskOutcome, type ColumnInfo, type Manifest,
} from './lib/cloudtasks'
import { applyOverrides, setOverride, type Overrides } from './lib/overrides'
import { eraseAll, loadLastRun, loadOverrides, loadTimeline, saveLastRun, saveOverrides, saveTimeline } from './lib/store'

type Engine = 'device' | 'rules' | null
type Pending = { kind: 'plan'; question: string; manifest: Manifest } | { kind: 'advice'; manifest: Manifest }

const today = () => new Date().toISOString().slice(0, 10)

export default function App() {
  const [avail, setAvail] = useState<Availability>('unsupported')
  const [csv, setCsv] = useState<ParsedCsv | null>(null)
  const [restored, setRestored] = useState<Tx[]>([])
  const [cols, setCols] = useState<ColumnMap>({ date: '', description: '', amount: '', debit: '', credit: '' })
  const [signSel, setSignSel] = useState<'auto' | SignMode>('auto')
  const [level, setLevel] = useState<DataLevel>('public-sample')
  const [fileName, setFileName] = useState('')
  const [cats, setCats] = useState<Map<number, Category | null>>(new Map())
  const [overrides, setOverrides] = useState<Overrides>({})
  const [engine, setEngine] = useState<Engine>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [timeline, setTimeline] = useState<TimelineEntry[]>([])
  const [sentBytes, setSentBytes] = useState(0)
  const [online, setOnline] = useState(navigator.onLine)
  const [question, setQuestion] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [answer, setAnswer] = useState<{ q: string; outcome: AskOutcome; result: PlanResult | null } | null>(null)
  const [advice, setAdvice] = useState<{ advice?: Advice; error?: string } | null>(null)
  const [askBusy, setAskBusy] = useState(false)
  const tlId = useRef(0)
  const session = useRef(new AskSession())
  const chooser = useRef<DeviceModel | null>(null)

  useEffect(() => {
    checkAvailability().then(setAvail)
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    ;(async () => {
      const [o, tl, last] = await Promise.all([loadOverrides(), loadTimeline(), loadLastRun()])
      setOverrides(o)
      if (tl.length) { setTimeline(tl); tlId.current = Math.max(...tl.map((e) => e.id)) }
      if (last) {
        setRestored(last.txs); setFileName(`${last.fileName} (restored from this browser)`); setLevel(last.level)
        setCats(new Map(last.cats))
      }
    })()
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  const signMode: SignMode = useMemo(() => (csv ? (signSel === 'auto' ? detectSign(csv, cols) : signSel) : 'expenses-negative'), [csv, cols, signSel])
  const txs = useMemo(() => (csv ? toTransactions(csv, cols, signMode) : restored), [csv, cols, signMode, restored])
  const classified: Classified[] = useMemo(() => txs.map((t) => ({ ...t, category: cats.get(t.id) ?? null })), [txs, cats])
  const spend = useMemo(() => spendByCategory(classified), [classified])
  const doneCount = classified.filter((t) => t.category).length
  const maxSpend = Math.max(1, ...Object.values(spend))
  const decision = route({ level, deviceModel: avail === 'unsupported' || avail === 'unavailable' ? 'unavailable' : 'available', online, consent: false })
  const columns: ColumnInfo[] = [
    { name: cols.date || 'date', type: 'date' },
    { name: cols.description || 'description', type: 'text' },
    ...(isSplit(cols) ? [{ name: cols.debit, type: 'number' as const }, { name: cols.credit, type: 'number' as const }] : [{ name: cols.amount || 'amount', type: 'number' as const }]),
  ]
  const cloudOk = CLOUD_CONFIGURED && online
  const cloudWhy = !CLOUD_CONFIGURED ? 'Cloud is not configured in this build.' : !online ? 'You are offline.' : ''

  function load(text: string, name: string, lvl: DataLevel) {
    const p = parseCsv(text)
    setCsv(p); setRestored([]); setCols(guessColumns(p.headers)); setSignSel('auto'); setLevel(lvl); setFileName(name)
    setCats(new Map()); setEngine(null); setNote(''); setAnswer(null); setAdvice(null); setPending(null)
  }
  async function loadSample(file: string) {
    const r = await fetch(`${import.meta.env.BASE_URL}samples/${file}`)
    load(await r.text(), file, 'public-sample')
  }
  async function onFile(f: File | undefined) {
    if (f) load(await f.text(), f.name, 'user-detail')
  }

  function log(e: Omit<TimelineEntry, 'id' | 'at'>) {
    const entry = { ...e, id: ++tlId.current, at: Date.now() }
    setSentBytes((b) => b + e.bytesSent)
    setTimeline((t) => { const n = [...t, entry]; saveTimeline(n); return n })
  }

  function persist(c: Map<number, Category | null>) {
    if (!txs.length) return
    saveLastRun({ fileName: fileName.replace(/ \(restored.*$/, ''), cols, sign: signSel, level: level === 'user-detail' ? 'user-detail' : 'public-sample', txs, cats: [...c], savedAt: Date.now() })
  }

  function runRules(reason: string, ov: Overrides) {
    const t0 = performance.now()
    const next = new Map<number, Category | null>()
    const memo = new Map<string, Category | null>()
    for (const t of txs) {
      const k = normalizeDesc(t.desc)
      if (!memo.has(k)) memo.set(k, ov[k] ?? classifyByRules(t.desc))
      next.set(t.id, memo.get(k) ?? null)
    }
    setCats(next); setEngine('rules'); persist(next)
    log({ task: `classify ${txs.length} rows (keyword rules)`, mode: 'LOCAL_RULES', side: 'rules', ms: performance.now() - t0, bytesSent: 0, reason })
  }

  // 必須由 click 觸發：裝置端模型的建立需要使用者手勢
  async function classify() {
    setBusy(true); setNote(''); setCats(new Map())
    try {
      const a = await checkAvailability(); setAvail(a)
      const d = route({ level, deviceModel: a === 'available' || a === 'downloadable' || a === 'downloading' ? 'available' : 'unavailable', online, consent: false })
      if (d.side === 'device') {
        setProgress(0)
        const model = await createClassifier((p) => setProgress(p))
        setProgress(null); setAvail('available'); setEngine('device')
        const idsByDesc = new Map<string, number[]>()
        for (const t of txs) idsByDesc.set(t.desc, [...(idsByDesc.get(t.desc) ?? []), t.id])
        const ovMap = new Map(Object.entries(overrides) as [string, Category][])
        await classifyAll(model.generate, txs.map((t) => t.desc), (e) => {
          setCats((prev) => {
            const n = new Map(prev)
            for (const ds of e.descs) for (const id of idsByDesc.get(ds) ?? []) n.set(id, e.category)
            return n
          })
          if (!e.cached) log({ task: `classify "${e.key}"`, mode: 'ONLY_ON_DEVICE', side: model.lastSource() === 'cloud' ? 'cloud' : 'device', ms: e.ms, bytesSent: 0, reason: d.reason })
        }, ovMap)
        setCats((prev) => { persist(prev); return prev })
      } else {
        // 分類走本機規則；雲端不碰使用者明細
        const why = d.side === 'cloud' ? 'No on-device model; using local rules. Nothing is uploaded.' : d.reason
        runRules(why, overrides)
        setNote(why)
      }
    } catch (err) {
      setProgress(null)
      runRules('On-device model failed to start; fell back to local rules.', overrides)
      console.error('On-device model failed to start', err)
      setNote('The on-device model could not start on this browser or machine; used local keyword rules instead.')
    } finally { setBusy(false) }
  }

  async function correct(t: Tx, cat: Category) {
    const r = setOverride(txs, overrides, t.desc, cat)
    setOverrides(r.overrides); saveOverrides(r.overrides)
    const next = applyOverrides(txs, cats, r.overrides)
    setCats(next); persist(next)
    setNote(`Saved: "${normalizeDesc(t.desc)}" is now ${cat} (${r.affected} row${r.affected === 1 ? '' : 's'}). It will be reused next time.`)
  }

  async function erase() {
    await eraseAll()
    setOverrides({}); setTimeline([]); setSentBytes(0); setCats(new Map()); setRestored([]); setCsv(null); setEngine(null)
    setAnswer(null); setAdvice(null); setPending(null); setFileName(''); session.current = new AskSession(); setNote('All local data erased (corrections, timeline, last statement).')
  }

  // ---- 盲眼分析 ----
  async function deps(): Promise<AskDeps> {
    const d: AskDeps = { log, cloud: cloudOk ? firebaseCloudCall : undefined }
    if (avail === 'available' || avail === 'downloadable' || avail === 'downloading') {
      try {
        if (!chooser.current) chooser.current = await createDeviceModel({ system: PATTERN_SYSTEM, schema: PATTERN_SCHEMA })
        const m = chooser.current
        d.deviceChoose = (q) => m.generate(`Question: ${q}\nAnswer:`)
      } catch { chooser.current = null }
    }
    return d
  }
  function show(q: string, outcome: AskOutcome) {
    setAnswer({ q, outcome, result: outcome.plan ? runPlan(outcome.plan, classified) : null })
  }
  async function ask(q0: string) {
    const q = q0.trim()
    if (!q || doneCount === 0) return
    setQuestion(q); setAnswer(null); setPending(null); setAskBusy(true)
    try {
      if (cloudOk && !session.current.cache.has(AskSession.key(q))) {
        setPending({ kind: 'plan', question: q, manifest: buildPlanManifest(q, columns, today(), txs.length) })
      } else {
        show(q, await askFixed(session.current, await deps(), q, cloudWhy || 'Using a fixed pattern.'))
      }
    } finally { setAskBusy(false) }
  }
  async function confirmPending(sendIt: boolean) {
    const p = pending
    if (!p) return
    setPending(null); setAskBusy(true)
    try {
      if (p.kind === 'plan') {
        const d = await deps()
        show(p.question, sendIt ? await askCloud(session.current, d, p.question, p.manifest) : await askFixed(session.current, d, p.question, 'You chose not to send anything; using a fixed pattern.'))
      } else if (sendIt) {
        const r = await askAdvice(session.current, await deps(), p.manifest)
        setAdvice(r.ok ? { advice: r.advice } : { error: r.error })
      }
    } finally { setAskBusy(false) }
  }
  function prepareAdvice() {
    setAdvice(null)
    setPending({ kind: 'advice', manifest: buildAdviceManifest(categoryShares(spend), txs.length) })
  }

  const deviceCalls = timeline.filter((t) => t.side === 'device').length
  const counter = engine === 'device'
    ? `${doneCount} classified on this device · ${sentBytes} bytes sent`
    : engine === 'rules'
      ? `${doneCount} classified by local rules · ${sentBytes} bytes sent`
      : `${doneCount} classified · ${sentBytes} bytes sent`
  const availText: Record<Availability, string> = {
    unsupported: 'Prompt API not found in this browser. Local keyword rules will be used.',
    unavailable: 'On-device model unavailable on this machine. Local keyword rules will be used.',
    downloadable: 'On-device model ready to download (about 4 GB, first run only).',
    downloading: 'On-device model is downloading.',
    available: 'On-device model ready (Gemini Nano, run through Firebase AI Logic).',
  }
  const ready = doneCount > 0
  const maxRow = Math.max(1, ...(answer?.result?.rows.map((r) => Math.abs(r.value)) ?? [1]))
  const fmt = (n: number, agg: string) => (agg === 'count' ? String(n) : n.toFixed(2))

  return (
    <main className="app">
      <h1>Blind Budget Coach</h1>
      <p className="sub">Drop a bank statement CSV. Every transaction is categorized on this device. You can check this yourself in your browser's DevTools Network panel.</p>

      <section className="panel">
        <div className="row">
          <label className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files[0]) }}>
            Drop a CSV here or <u>choose a file</u>
            <input type="file" accept=".csv,text/csv" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <button onClick={() => loadSample('sample-statement-1.csv')}>Load sample 1 (247 rows)</button>
          <button onClick={() => loadSample('sample-statement-2.csv')}>Load sample 2 (60 rows)</button>
          <button onClick={erase}>Erase all local data</button>
        </div>
        <p className="muted">Samples are synthetic and use fictional merchants. Corrections, the timeline and your last statement are stored only in this browser (IndexedDB) until you erase them.</p>
        <p className={`badge ${avail === 'available' ? 'ok' : 'warn'}`}>{availText[avail]}</p>
        {!online && <p className="badge warn">You are offline. On-device features still work; cloud features are off.</p>}
      </section>

      {(csv || restored.length > 0) && (
        <section className="panel">
          <h2>{fileName} <span className="muted">· {txs.length} transactions</span></h2>
          {csv && (
            <div className="row">
              {(['date', 'description'] as const).map((k) => (
                <label key={k}>Column for {k}:{' '}
                  <select value={cols[k]} onChange={(e) => setCols({ ...cols, [k]: e.target.value })}>
                    <option value="">(none)</option>
                    {csv.headers.map((h) => <option key={h}>{h}</option>)}
                  </select>
                </label>
              ))}
              {isSplit(cols) ? (['debit', 'credit'] as const).map((k) => (
                <label key={k}>{k === 'debit' ? 'Debit' : 'Credit'} column:{' '}
                  <select value={cols[k]} onChange={(e) => setCols({ ...cols, [k]: e.target.value })}>
                    {csv.headers.map((h) => <option key={h}>{h}</option>)}
                  </select>
                </label>
              )) : (
                <label>Column for amount:{' '}
                  <select value={cols.amount} onChange={(e) => setCols({ ...cols, amount: e.target.value })}>
                    <option value="">(none)</option>
                    {csv.headers.map((h) => <option key={h}>{h}</option>)}
                  </select>
                </label>
              )}
              {isSplit(cols)
                ? <button onClick={() => setCols({ ...cols, debit: '', credit: '' })}>Use a single amount column</button>
                : <button disabled={csv.headers.length < 4} onClick={() => { const g = guessColumns(csv.headers); setCols({ ...cols, debit: g.debit || csv.headers[0], credit: g.credit || csv.headers[1] }) }}>Use Debit / Credit columns</button>}
              {!isSplit(cols) && (
                <label>Spending is:{' '}
                  <select value={signSel} onChange={(e) => setSignSel(e.target.value as 'auto' | SignMode)}>
                    <option value="auto">auto ({signMode === 'expenses-negative' ? 'negative' : 'positive'})</option>
                    <option value="expenses-negative">negative numbers</option>
                    <option value="expenses-positive">positive numbers</option>
                  </select>
                </label>
              )}
            </div>
          )}
          <div className="row">
            <button className="primary" disabled={busy || txs.length === 0} onClick={classify}>
              {busy ? 'Classifying…' : 'Classify on this device'}
            </button>
            <span className="counter" aria-live="polite">{counter}</span>
          </div>
          <p className="muted">Routing: <b>{decision.mode}</b> — {decision.reason}</p>
          {progress !== null && <p className="badge warn">Loading on-device model… {Math.round(progress * 100)}% (first run downloads about 4 GB and may pause near 90%)</p>}
          {engine === 'rules' && <p className="badge warn">Using local keyword rules (no model). {note}</p>}
          {engine === 'device' && <p className="badge ok">Using the on-device model. Unrecognized merchants may be wrong; click a category to correct it.</p>}
          {note && engine !== 'rules' && <p className="muted">{note}</p>}
        </section>
      )}

      <section className="panel">
        <h2>Ask a question (blind analysis)</h2>
        <p className="muted">Your question becomes a query plan that runs here, on your data. If the cloud writes the plan, it sees only your question, column names, the category list and today's date.</p>
        <div className="row">
          {EXAMPLE_QUESTIONS.map((q) => <button key={q} disabled={!ready || askBusy} onClick={() => ask(q)}>{q}</button>)}
        </div>
        <div className="row">
          <input style={{ flex: 1, minWidth: 220, padding: 8 }} value={question} placeholder="Ask in one sentence" onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') ask(question) }} />
          <button className="primary" disabled={!ready || askBusy || !question.trim()} onClick={() => ask(question)}>Ask</button>
        </div>
        {!ready && <p className="muted">Classify a statement first.</p>}
        {cloudWhy && <p className="muted">{cloudWhy} Questions use fixed patterns (on-device model if available, otherwise keywords).</p>}
        {pending?.kind === 'plan' && <ManifestBox m={pending.manifest} onSend={() => confirmPending(true)} onCancel={() => confirmPending(false)} cancelText="Don't send; use a fixed pattern" />}
        {answer && (
          <div>
            <h3>{answer.q}</h3>
            {answer.outcome.unsupported
              ? <p className="badge warn">{answer.outcome.note}</p>
              : <p className="muted">{answer.outcome.note}{answer.outcome.cached ? ' (cached answer)' : ''}</p>}
            {answer.result ? (
              <table>
                <thead><tr><th>{answer.result.groupBy ?? 'Result'}</th><th className="num">{answer.result.aggregate}</th><th className="num">rows</th><th /></tr></thead>
                <tbody>
                  {answer.result.rows.map((r) => (
                    <tr key={r.label}>
                      <td>{r.label}</td><td className="num">{fmt(r.value, answer.result!.aggregate)}</td><td className="num">{r.count}</td>
                      <td style={{ width: '40%' }}><svg width="100%" height="10" aria-hidden="true"><rect x="0" y="1" height="8" rx="2" width={`${Math.max(1, (Math.abs(r.value) / maxRow) * 100)}%`} fill="#2f6fed" /></svg></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : !answer.outcome.unsupported && <p className="badge warn">No result.</p>}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Budget advice from category ratios</h2>
        <p className="muted">Sends only whole-number category percentages to the cloud, after you approve the exact text.</p>
        <button disabled={!ready || !cloudOk || askBusy} onClick={prepareAdvice}>Get budget advice</button>
        {!ready && <p className="muted">Classify a statement first.</p>}
        {ready && !cloudOk && <p className="muted">Disabled: {cloudWhy}</p>}
        {pending?.kind === 'advice' && <ManifestBox m={pending.manifest} onSend={() => confirmPending(true)} onCancel={() => confirmPending(false)} cancelText="Cancel" />}
        {advice?.error && <p className="badge warn">{advice.error}</p>}
        {advice?.advice && <ol>{advice.advice.tips.map((t) => <li key={t.title}><b>{t.title}</b> {t.detail}</li>)}</ol>}
      </section>

      {txs.length > 0 && (
        <div className="grid">
          <section className="panel">
            <h2>Transactions</h2>
            <div className="scroll">
              <table>
                <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th><th>Category</th></tr></thead>
                <tbody>
                  {classified.map((t) => (
                    <tr key={t.id} className={t.category ? 'done' : ''}>
                      <td>{t.date}</td><td>{t.desc}</td><td className="num">{t.amount.toFixed(2)}</td>
                      <td>
                        <select aria-label={`Category for ${t.desc}`} value={t.category ?? ''} onChange={(e) => e.target.value && correct(t, e.target.value as Category)}>
                          <option value="">—</option>
                          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <div>
            <section className="panel">
              <h2>Spending by category</h2>
              {Object.keys(spend).length === 0 ? <p className="muted">Classify to see totals.</p> : (
                <svg viewBox={`0 0 420 ${(CATEGORIES.length + 1) * 22}`} role="img" aria-label="Spending by category">
                  {[...Object.entries(spend)].sort((a, b) => b[1] - a[1]).map(([k, v], i) => (
                    <g key={k} transform={`translate(0 ${i * 22})`}>
                      <text x="0" y="14" fontSize="12" fill="currentColor">{k}</text>
                      <rect x="100" y="3" width={Math.max(2, (v / maxSpend) * 230)} height="14" rx="2" fill="#2f6fed" />
                      <text x={106 + (v / maxSpend) * 230} y="14" fontSize="11" fill="currentColor">{v.toFixed(0)}</text>
                    </g>
                  ))}
                </svg>
              )}
            </section>
            <section className="panel">
              <h2>Timeline <span className="muted">· {deviceCalls} on-device calls · {sentBytes} bytes sent this visit</span></h2>
              <div className="scroll short">
                <table>
                  <thead><tr><th>Mode</th><th>Side</th><th>Task</th><th className="num">ms</th><th className="num">Sent</th></tr></thead>
                  <tbody>
                    {timeline.slice(-80).map((e) => (
                      <tr key={e.id} title={e.reason}><td>{e.mode}</td><td>{e.side}</td><td>{e.task}</td><td className="num">{Math.round(e.ms)}</td><td className="num">{e.bytesSent} B</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted">Hover a row for the reason. Sent = request content bytes of each cloud call (0 when nothing was sent).</p>
            </section>
          </div>
        </div>
      )}
    </main>
  )
}

function ManifestBox({ m, onSend, onCancel, cancelText }: { m: Manifest; onSend: () => void; onCancel: () => void; cancelText: string }) {
  return (
    <div className="panel" role="dialog" aria-label="Data leaving this device">
      <h3>This exact text will leave your device ({m.bytes} bytes)</h3>
      <p className="muted">Mode: {m.mode}. The size counts the instructions, the message and the response structure below; the network adds a little more for headers and wrapping. Instructions:</p>
      <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.8rem' }}>{m.system}</pre>
      <p className="muted">Message:</p>
      <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.8rem' }}>{m.prompt}</pre>
      <details>
        <summary className="muted">Response structure sent with the request (tells the model which JSON shape to answer with)</summary>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem' }}>{JSON.stringify(m.schema, null, 1)}</pre>
      </details>
      <p><b>{m.notIncluded}</b></p>
      <div className="row">
        <button className="primary" onClick={onSend}>Send</button>
        <button onClick={onCancel}>{cancelText}</button>
      </div>
    </div>
  )
}
