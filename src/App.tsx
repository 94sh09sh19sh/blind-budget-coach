import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { CATEGORIES, type Category } from './lib/categories'
import { guessColumns, parseCsv, toTransactions, type ColumnMap, type ParsedCsv } from './lib/csv'
import { classifyAll, checkAvailability, createClassifier, type Availability } from './lib/ondevice'
import { classifyByRules } from './lib/rules'
import { normalizeDesc } from './lib/normalize'
import { spendByCategory, type Classified } from './lib/aggregate'
import { route, type DataLevel, type TimelineEntry } from './lib/router'
import { CLOUD_CONFIGURED as CLOUD_ENABLED } from './firebase'

type Engine = 'device' | 'rules' | null

export default function App() {
  const [avail, setAvail] = useState<Availability>('unsupported')
  const [csv, setCsv] = useState<ParsedCsv | null>(null)
  const [cols, setCols] = useState<ColumnMap>({ date: '', description: '', amount: '' })
  const [level, setLevel] = useState<DataLevel>('public-sample')
  const [fileName, setFileName] = useState('')
  const [cats, setCats] = useState<Map<number, Category | null>>(new Map())
  const [engine, setEngine] = useState<Engine>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [timeline, setTimeline] = useState<TimelineEntry[]>([])
  const tlId = useRef(0)

  useEffect(() => { checkAvailability().then(setAvail) }, [])

  const txs = useMemo(() => (csv ? toTransactions(csv, cols) : []), [csv, cols])
  const classified: Classified[] = useMemo(
    () => txs.map((t) => ({ ...t, category: cats.get(t.id) ?? null })),
    [txs, cats],
  )
  const spend = useMemo(() => spendByCategory(classified), [classified])
  const doneCount = classified.filter((t) => t.category).length
  const maxSpend = Math.max(1, ...Object.values(spend))
  const decision = route({ level, deviceModel: avail === 'unsupported' || avail === 'unavailable' ? 'unavailable' : 'available', online: navigator.onLine, consent: false })

  function load(text: string, name: string, lvl: DataLevel) {
    const p = parseCsv(text)
    setCsv(p); setCols(guessColumns(p.headers)); setLevel(lvl); setFileName(name)
    setCats(new Map()); setEngine(null); setTimeline([]); setNote('')
  }
  async function loadSample(file: string) {
    const r = await fetch(`${import.meta.env.BASE_URL}samples/${file}`)
    load(await r.text(), file, 'public-sample')
  }
  async function onFile(f: File | undefined) {
    if (f) load(await f.text(), f.name, 'user-detail')
  }

  function log(e: Omit<TimelineEntry, 'id' | 'at'>) {
    setTimeline((t) => [...t, { ...e, id: ++tlId.current, at: Date.now() }])
  }

  // 規則式備援：完全在本機，同樣依清理後字串去重
  function runRules(reason: string) {
    const t0 = performance.now()
    const next = new Map<number, Category | null>()
    const memo = new Map<string, Category | null>()
    for (const t of txs) {
      const k = normalizeDesc(t.desc)
      if (!memo.has(k)) memo.set(k, classifyByRules(t.desc))
      next.set(t.id, memo.get(k) ?? null)
    }
    setCats(next); setEngine('rules')
    log({ task: `classify ${txs.length} rows (keyword rules)`, mode: 'LOCAL_RULES', side: 'rules', ms: performance.now() - t0, bytesSent: 0, reason })
  }

  // 必須由 click 觸發，Prompt API 的 create() 需要使用者手勢
  async function classify() {
    setBusy(true); setNote(''); setCats(new Map())
    try {
      const a = await checkAvailability(); setAvail(a)
      const d = route({ level, deviceModel: a === 'available' || a === 'downloadable' || a === 'downloading' ? 'available' : 'unavailable', online: navigator.onLine, consent: false })
      if (d.side === 'device') {
        setProgress(0)
        const base = await createClassifier((p) => setProgress(p))
        setProgress(null); setAvail('available'); setEngine('device')
        const byKey = new Map<string, Category | null>()
        const idsByDesc = new Map<string, number[]>()
        for (const t of txs) idsByDesc.set(t.desc, [...(idsByDesc.get(t.desc) ?? []), t.id])
        await classifyAll(base.generate, txs.map((t) => t.desc), (e) => {
          byKey.set(e.key, e.category)
          setCats((prev) => {
            const n = new Map(prev)
            for (const ds of e.descs) for (const id of idsByDesc.get(ds) ?? []) n.set(id, e.category)
            return n
          })
          if (!e.cached) log({ task: `classify "${e.key}"`, mode: d.mode, side: 'device', ms: e.ms, bytesSent: 0, reason: d.reason })
        })
      } else {
        // 雲端路徑目前沒有接線：就算路由建議雲端，也一律改用本機規則
        const why = d.side === 'cloud' ? 'Cloud path is not wired in this build; using local rules. Nothing is uploaded.' : d.reason
        runRules(why)
        setNote(why)
      }
    } catch (err) {
      setProgress(null)
      runRules('On-device model failed to start; fell back to local rules.')
      setNote(`On-device model failed (${err instanceof Error ? err.message : 'unknown error'}); used local keyword rules instead.`)
    } finally { setBusy(false) }
  }

  const deviceCalls = timeline.filter((t) => t.side === 'device').length
  const counter = engine === 'device'
    ? `${doneCount} classified on this device · 0 bytes sent`
    : engine === 'rules'
      ? `${doneCount} classified by local rules · 0 bytes sent`
      : '0 classified · 0 bytes sent'
  const availText: Record<Availability, string> = {
    unsupported: 'Prompt API not found in this browser. Local keyword rules will be used.',
    unavailable: 'On-device model unavailable on this machine. Local keyword rules will be used.',
    downloadable: 'On-device model ready to download (about 4 GB, first run only).',
    downloading: 'On-device model is downloading.',
    available: 'On-device model ready (Gemini Nano via Chrome Prompt API).',
  }

  return (
    <main className="app">
      <h1>Blind Budget Coach</h1>
      <p className="sub">Drop a bank statement CSV. Every transaction is categorized on this device; your line items are never uploaded.</p>

      <section className="panel">
        <div className="row">
          <label className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files[0]) }}>
            Drop a CSV here or <u>choose a file</u>
            <input type="file" accept=".csv,text/csv" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <button onClick={() => loadSample('sample-statement-1.csv')}>Load sample 1 (247 rows)</button>
          <button onClick={() => loadSample('sample-statement-2.csv')}>Load sample 2 (60 rows)</button>
        </div>
        <p className="muted">Samples are synthetic and use fictional merchants.</p>
        <p className={`badge ${avail === 'available' ? 'ok' : 'warn'}`}>{availText[avail]}</p>
      </section>

      {csv && (
        <section className="panel">
          <h2>{fileName} <span className="muted">· {txs.length} transactions</span></h2>
          <div className="row">
            {(['date', 'description', 'amount'] as const).map((k) => (
              <label key={k}>Column for {k}:{' '}
                <select value={cols[k]} onChange={(e) => setCols({ ...cols, [k]: e.target.value })}>
                  <option value="">(none)</option>
                  {csv.headers.map((h) => <option key={h}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="row">
            <button className="primary" disabled={busy || txs.length === 0} onClick={classify}>
              {busy ? 'Classifying…' : 'Classify on this device'}
            </button>
            <span className="counter" aria-live="polite">{counter}</span>
          </div>
          <p className="muted">Routing: <b>{decision.mode}</b> — {decision.reason}</p>
          {progress !== null && <p className="badge warn">Loading on-device model… {Math.round(progress * 100)}% (first run downloads about 4 GB and may pause near 90%)</p>}
          {engine === 'rules' && <p className="badge warn">Using local keyword rules (no model). {note}</p>}
          {engine === 'device' && <p className="badge ok">Using the on-device model. Unrecognized merchants may be wrong.</p>}
        </section>
      )}

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
                      <td>{t.category ? <span className="chip">{t.category}</span> : <span className="muted">—</span>}</td>
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
              <h2>Timeline <span className="muted">· {deviceCalls} on-device calls</span></h2>
              <div className="scroll short">
                <table>
                  <thead><tr><th>Side</th><th>Task</th><th className="num">ms</th><th className="num">Sent</th></tr></thead>
                  <tbody>
                    {timeline.slice(-60).map((e) => (
                      <tr key={e.id} title={e.reason}><td>{e.side}</td><td>{e.task}</td><td className="num">{Math.round(e.ms)}</td><td className="num">{e.bytesSent} B</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="panel">
              <h2>Cloud features</h2>
              <p className="muted">Coming later. The cloud would only ever see column structure or category ratios you approve, never transactions.</p>
              <div className="row">
                <button disabled={!CLOUD_ENABLED}>Ask a question (blind analysis)</button>
                <button disabled={!CLOUD_ENABLED}>Budget advice from ratios</button>
              </div>
            </section>
          </div>
        </div>
      )}
    </main>
  )
}
