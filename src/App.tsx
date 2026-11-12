import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import './App.css'
import { CATEGORIES, type Category } from './lib/categories'
import { detectSign, guessColumns, isSplit, parseCsv, toTransactions, type ColumnMap, type ParsedCsv, type SignMode, type Tx } from './lib/csv'
import { classifyAll, checkAvailability, createBatchClassifier, createClassifier, DEFAULT_BATCH_SIZE, type Availability } from './lib/ondevice'
import { classifyByRules } from './lib/rules'
import { normalizeDesc } from './lib/normalize'
import { spendByCategory, type Classified } from './lib/aggregate'
import { route, type DataLevel, type Mode, type Side, type TimelineEntry } from './lib/router'
import { CLOUD_CONFIGURED } from './firebase'
import { createDeviceModel, firebaseCloudCall, type DeviceModel } from './lib/ai'
import { EXAMPLE_QUESTIONS, PATTERN_SCHEMA, PATTERN_SYSTEM, runPlan, type PlanResult } from './lib/plan'
import {
  AskSession, askAdvice, askCloud, askFixed, buildAdviceManifest, buildPlanManifest, categoryShares,
  type Advice, type AskDeps, type AskOutcome, type ColumnInfo, type Manifest,
} from './lib/cloudtasks'
import { applyOverrides, setOverride, type Overrides } from './lib/overrides'
import {
  eraseAll, loadLastRun, loadLedger, loadOverrides, loadTimeline, saveLastRun, saveLedger, saveOverrides, saveTimeline, type LedgerEntry,
} from './lib/store'
import { ManifestDialog } from './ui/ManifestDialog'
import { IconAlert, IconCheck, IconCloud, IconDevice, IconGate, IconRules, IconUpload, Logo } from './ui/icons'

type Engine = 'device' | 'rules' | null
type Pending = { kind: 'plan'; question: string; manifest: Manifest } | { kind: 'advice'; manifest: Manifest }
/** 進行中的工作：標籤、開始時間（算經過秒數用） */
type Phase = { label: string; detail?: string; start: number; where: 'device' | 'cloud' }
type ClassifyProgress = { done: number; total: number; keys: string[]; batch: number; last?: { key: string; category: Category | null } }

const today = () => new Date().toISOString().slice(0, 10)
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`

const MODES: { mode: Mode; side: Side; use: string; why: string }[] = [
  { mode: 'ONLY_ON_DEVICE', side: 'device', use: 'Your own statement', why: 'Each transaction is classified by the on-device model in this browser, and the app does not send it anywhere.' },
  { mode: 'PREFER_ON_DEVICE', side: 'device', use: 'Built-in samples', why: 'Synthetic data; the on-device model is preferred.' },
  { mode: 'PREFER_IN_CLOUD', side: 'cloud', use: 'Questions', why: 'The cloud writes a query plan from your question and column names, after you approve. Declined or offline: a fixed pattern is picked here.' },
  { mode: 'ONLY_IN_CLOUD', side: 'cloud', use: 'Budget advice', why: 'Sends whole-number category percentages only, after you approve.' },
  { mode: 'LOCAL_RULES', side: 'rules', use: 'No model available', why: 'Keyword rules in this page. Nothing is uploaded.' },
]

export default function App() {
  const [avail, setAvail] = useState<Availability | 'checking'>('checking')
  const [csv, setCsv] = useState<ParsedCsv | null>(null)
  const [restored, setRestored] = useState<Tx[]>([])
  const [cols, setCols] = useState<ColumnMap>({ date: '', description: '', amount: '', debit: '', credit: '' })
  const [signSel, setSignSel] = useState<'auto' | SignMode>('auto')
  const [level, setLevel] = useState<DataLevel>('public-sample')
  const [fileName, setFileName] = useState('')
  const [isRestored, setIsRestored] = useState(false)
  const [cats, setCats] = useState<Map<number, Category | null>>(new Map())
  const [overrides, setOverrides] = useState<Overrides>({})
  const [engine, setEngine] = useState<Engine>(null)
  const [busy, setBusy] = useState(false)
  const [dl, setDl] = useState<number | null>(null)
  const [prog, setProg] = useState<ClassifyProgress | null>(null)
  const [phase, setPhase] = useState<Phase | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [note, setNote] = useState('')
  const [timeline, setTimeline] = useState<TimelineEntry[]>([])
  const [ledger, setLedger] = useState<LedgerEntry[]>([])
  const [online, setOnline] = useState(navigator.onLine)
  const [question, setQuestion] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [answer, setAnswer] = useState<{ q: string; outcome: AskOutcome; result: PlanResult | null } | null>(null)
  const [advice, setAdvice] = useState<{ advice?: Advice; error?: string } | null>(null)
  const [askBusy, setAskBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [lastClassifyMs, setLastClassifyMs] = useState<number | null>(null)
  const tlId = useRef(0)
  const session = useRef(new AskSession())
  const chooser = useRef<DeviceModel | null>(null)
  /** 目前準備送出的出境清單；雲端呼叫寫時間線時一併記進帳本 */
  const outbound = useRef<Manifest | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    checkAvailability().then(setAvail)
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    ;(async () => {
      const [o, tl, last, lg] = await Promise.all([loadOverrides(), loadTimeline(), loadLastRun(), loadLedger()])
      setOverrides(o)
      if (tl.length) { setTimeline(tl); tlId.current = Math.max(...tl.map((e) => e.id)) }
      if (lg.length) { setLedger(lg); tlId.current = Math.max(tlId.current, ...lg.map((e) => e.id)) }
      if (last) {
        setRestored(last.txs); setFileName(last.fileName); setIsRestored(true); setLevel(last.level)
        setCats(new Map(last.cats))
        if (last.cats.some(([, c]) => c)) setEngine(tl.some((e) => e.mode === 'LOCAL_RULES' && e.task.startsWith('classify')) && !tl.some((e) => e.side === 'device') ? 'rules' : 'device')
      }
    })()
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  // 進行中每秒更新經過時間
  useEffect(() => {
    if (!phase) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [phase])

  const signMode: SignMode = useMemo(() => (csv ? (signSel === 'auto' ? detectSign(csv, cols) : signSel) : 'expenses-negative'), [csv, cols, signSel])
  const txs = useMemo(() => (csv ? toTransactions(csv, cols, signMode) : restored), [csv, cols, signMode, restored])
  const classified: Classified[] = useMemo(() => txs.map((t) => ({ ...t, category: cats.get(t.id) ?? null })), [txs, cats])
  const spend = useMemo(() => spendByCategory(classified), [classified])
  const uniqueKeys = useMemo(() => [...new Set(txs.map((t) => normalizeDesc(t.desc)))], [txs])
  const doneCount = classified.filter((t) => t.category).length
  const modelOk = avail === 'available' || avail === 'downloadable' || avail === 'downloading'
  const decision = route({ level, deviceModel: modelOk ? 'available' : 'unavailable', online, consent: false })
  const columns: ColumnInfo[] = [
    { name: cols.date || 'date', type: 'date' },
    { name: cols.description || 'description', type: 'text' },
    ...(isSplit(cols) ? [{ name: cols.debit, type: 'number' as const }, { name: cols.credit, type: 'number' as const }] : [{ name: cols.amount || 'amount', type: 'number' as const }]),
  ]
  const cloudOk = CLOUD_CONFIGURED && online
  const cloudWhy = !CLOUD_CONFIGURED ? 'Cloud is not configured in this build.' : !online ? 'You are offline.' : ''
  const sentBytes = ledger.reduce((s, e) => s + e.bytes, 0)
  const hasData = txs.length > 0
  const ready = doneCount > 0
  const elapsed = phase ? Math.max(0, Math.floor((now - phase.start) / 1000)) : 0
  // 正在處理的店家：還沒完成的前 batch 個（逐筆時就是一個；批次時整批一起標示）
  const workingKeys = useMemo(() => {
    if (!busy || !prog || prog.done >= prog.total) return [] as string[]
    const doneSet = new Set(prog.keys)
    return uniqueKeys.filter((k) => !doneSet.has(k)).slice(0, prog.batch)
  }, [busy, prog, uniqueKeys])
  const workingId = workingKeys.join('|')

  // 分類中把正在處理的那一列捲進表格可視範圍，讓逐筆亮起看得到
  useEffect(() => {
    if (!workingId) return
    const row = document.querySelector<HTMLElement>('.tx .scroll tr.working')
    const box = row?.closest<HTMLElement>('.scroll')
    if (row && box && (row.offsetTop < box.scrollTop + 30 || row.offsetTop > box.scrollTop + box.clientHeight - 60)) box.scrollTop = row.offsetTop - box.clientHeight / 2
  }, [workingId])

  function startPhase(p: Omit<Phase, 'start'>) { setNow(Date.now()); setPhase({ ...p, start: Date.now() }) }

  function load(text: string, name: string, lvl: DataLevel) {
    const p = parseCsv(text)
    setCsv(p); setRestored([]); setCols(guessColumns(p.headers)); setSignSel('auto'); setLevel(lvl); setFileName(name); setIsRestored(false)
    setCats(new Map()); setEngine(null); setNote(''); setAnswer(null); setAdvice(null); setPending(null); setProg(null); setLastClassifyMs(null)
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
    setTimeline((t) => { const n = [...t, entry]; saveTimeline(n); return n })
    const m = outbound.current
    if (e.side === 'cloud' && e.bytesSent > 0 && m) {
      const row: LedgerEntry = { id: entry.id, at: entry.at, task: e.task, mode: e.mode, bytes: e.bytesSent, system: m.system, prompt: m.prompt, schema: m.schema, outcome: e.reason }
      setLedger((l) => { const n = [...l, row]; saveLedger(n); return n })
    }
  }

  function persist(c: Map<number, Category | null>) {
    if (!txs.length) return
    saveLastRun({ fileName, cols, sign: signSel, level: level === 'user-detail' ? 'user-detail' : 'public-sample', txs, cats: [...c], savedAt: Date.now() })
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
    setBusy(true); setNote(''); setCats(new Map()); setProg(null); setLastClassifyMs(null)
    const t0 = Date.now()
    try {
      const a = await checkAvailability(); setAvail(a)
      const d = route({ level, deviceModel: a === 'available' || a === 'downloadable' || a === 'downloading' ? 'available' : 'unavailable', online, consent: false })
      if (d.side === 'device') {
        setDl(0)
        startPhase({ label: 'Starting the on-device model', detail: 'First start takes about 15–30 s.', where: 'device' })
        const model = await createClassifier((p) => setDl(p))
        const batchN = DEFAULT_BATCH_SIZE
        const bm = batchN > 1 ? createBatchClassifier((p) => setDl(p)) : null
        const total = new Set(txs.map((t) => normalizeDesc(t.desc))).size
        if (bm) await bm.warm([batchN, total % batchN].filter((n) => n > 1))
        setDl(null); setAvail('available'); setEngine('device')
        setProg({ done: 0, total, keys: [], batch: batchN })
        startPhase({ label: 'Classifying on this device', where: 'device' })
        const idsByDesc = new Map<string, number[]>()
        for (const t of txs) idsByDesc.set(t.desc, [...(idsByDesc.get(t.desc) ?? []), t.id])
        const ovMap = new Map(Object.entries(overrides) as [string, Category][])
        await classifyAll(model.generate, txs.map((t) => t.desc), (e) => {
          setCats((prev) => {
            const n = new Map(prev)
            for (const ds of e.descs) for (const id of idsByDesc.get(ds) ?? []) n.set(id, e.category)
            return n
          })
          setProg((p) => p && { ...p, done: p.done + 1, keys: [...p.keys, e.key], last: { key: e.key, category: e.category } })
          const side = (bm && e.batch && !e.batch.fellBack ? bm.lastSource() : model.lastSource()) === 'cloud' ? 'cloud' : 'device'
          if (e.cached) return
          if (e.batch && !e.batch.fellBack) {
            // 時間線每批一列，寫明這批有幾個字串
            if (e.batch.first) log({ task: `classify batch of ${e.batch.size} merchants`, mode: 'ONLY_ON_DEVICE', side, ms: e.batch.ms, bytesSent: 0, reason: d.reason })
          } else log({ task: `classify "${e.key}"${e.batch ? ' (batch fell back to one by one)' : ''}`, mode: 'ONLY_ON_DEVICE', side, ms: e.ms, bytesSent: 0, reason: d.reason })
        }, ovMap, { batchSize: batchN, genBatch: bm?.generate })
        setCats((prev) => { persist(prev); return prev })
      } else {
        // 分類走本機規則；雲端不碰使用者明細
        const why = d.side === 'cloud' ? 'No on-device model; using local rules. Nothing is uploaded.' : d.reason
        runRules(why, overrides)
        setNote(why)
      }
    } catch (err) {
      setDl(null)
      runRules('On-device model failed to start; fell back to local rules.', overrides)
      console.error('On-device model failed to start', err)
      setNote('The on-device model could not start on this browser or machine; used local keyword rules instead.')
    } finally { setBusy(false); setPhase(null); setLastClassifyMs(Date.now() - t0) }
  }

  async function correct(t: Tx, cat: Category) {
    const r = setOverride(txs, overrides, t.desc, cat)
    setOverrides(r.overrides); saveOverrides(r.overrides)
    const next = applyOverrides(txs, cats, r.overrides)
    setCats(next); persist(next)
    setNote(`Saved: "${normalizeDesc(t.desc)}" is now ${cat} (${plural(r.affected, 'row')}). It will be reused next time.`)
  }

  async function erase() {
    await eraseAll()
    setOverrides({}); setTimeline([]); setLedger([]); setCats(new Map()); setRestored([]); setCsv(null); setEngine(null); setProg(null)
    setAnswer(null); setAdvice(null); setPending(null); setFileName(''); setIsRestored(false); session.current = new AskSession()
    setNote('All local data erased: corrections, timeline, outbound ledger and last statement.')
  }

  // ---- 盲眼分析 ----
  async function deps(): Promise<AskDeps> {
    const d: AskDeps = { log, cloud: cloudOk ? firebaseCloudCall : undefined }
    if (modelOk) {
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
        startPhase({ label: 'Picking a fixed query pattern on this device', where: 'device' })
        show(q, await askFixed(session.current, await deps(), q, cloudWhy || 'Using a fixed pattern.'))
      }
    } finally { setAskBusy(false); setPhase(null) }
  }
  async function confirmPending(sendIt: boolean) {
    const p = pending
    if (!p) return
    setPending(null); setAskBusy(true)
    outbound.current = sendIt ? p.manifest : null
    try {
      if (p.kind === 'plan') {
        startPhase(sendIt
          ? { label: 'Waiting for the cloud to write a query plan', detail: 'Usually 2–12 s. Your data is not part of the request.', where: 'cloud' }
          : { label: 'Picking a fixed query pattern on this device', where: 'device' })
        const d = await deps()
        show(p.question, sendIt ? await askCloud(session.current, d, p.question, p.manifest) : await askFixed(session.current, d, p.question, 'You chose not to send anything; using a fixed pattern.'))
      } else if (sendIt) {
        startPhase({ label: 'Waiting for budget advice from the cloud', detail: 'Usually 2–12 s.', where: 'cloud' })
        const r = await askAdvice(session.current, await deps(), p.manifest)
        setAdvice(r.ok ? { advice: r.advice } : { error: r.error })
      }
    } finally { setAskBusy(false); setPhase(null); outbound.current = null }
  }
  function prepareAdvice() {
    setAdvice(null)
    setPending({ kind: 'advice', manifest: buildAdviceManifest(categoryShares(spend), txs.length) })
  }

  const meterWhere = engine === 'rules' ? 'classified by local rules' : 'classified on this device'
  const spendRows = Object.entries(spend).sort((a, b) => b[1] - a[1])
  const maxSpend = Math.max(1, ...spendRows.map(([, v]) => v))
  const totalSpend = spendRows.reduce((s, [, v]) => s + v, 0)
  const maxRow = Math.max(1, ...(answer?.result?.rows.map((r) => Math.abs(r.value)) ?? [1]))
  const fmt = (n: number, agg: string) => (agg === 'count' ? String(n) : money(n))
  const deviceCalls = timeline.filter((t) => t.side === 'device').length
  const cloudCalls = timeline.filter((t) => t.side === 'cloud').length

  return (
    <div className="shell">
      <a className="skip" href="#device">Skip to the workspace</a>

      <header className="top">
        <div className="brand">
          <Logo />
          <div>
            <div className="brand-name">Blind Budget Coach</div>
            <div className="brand-tag">Your statement is classified in this browser. Anything sent to the cloud is shown to you first.</div>
          </div>
        </div>
        <div className="meter" role="status" aria-live="polite" aria-atomic="true">
          <div className="meter-item">
            <span className="meter-num">{doneCount.toLocaleString('en-US')}</span>
            <span className="meter-lbl">{meterWhere}</span>
          </div>
          <span className="meter-sep" aria-hidden="true">·</span>
          <div className={`meter-item ${sentBytes > 0 ? 'is-out' : 'is-zero'}`}>
            <span className="meter-num">{sentBytes.toLocaleString('en-US')} bytes</span>
            <span className="meter-lbl">sent{ledger.length ? ` in ${plural(ledger.length, 'approved request')}` : ''}</span>
          </div>
        </div>
        <div className="status-chips">
          <span className={`chip ${avail === 'available' ? 'chip-ok' : modelOk ? 'chip-info' : avail === 'checking' ? '' : 'chip-warn'}`}>
            {avail === 'available' ? <IconCheck size={14} /> : modelOk ? <IconDevice size={14} /> : <IconRules size={14} />}
            {avail === 'available' ? 'On-device model ready' : avail === 'downloadable' ? 'Model not downloaded' : avail === 'downloading' ? 'Model downloading' : avail === 'checking' ? 'Checking model…' : 'Local rules only'}
          </span>
          <span className={`chip ${online ? '' : 'chip-warn'}`}>{online ? 'Online' : 'Offline'}</span>
        </div>
      </header>

      <div className="stage">
        <main id="device" className="zone zone-device" aria-labelledby="device-title" tabIndex={-1}>
          <div className="zone-head">
            <h1 id="device-title" className="zone-title"><IconDevice /> On this device</h1>
            <p className="zone-sub">Transactions, categories and query results are computed and stored here (IndexedDB). Since last erase: {plural(deviceCalls, 'on-device call')}.</p>
          </div>

          {!modelOk && avail !== 'checking' && <NoModel avail={avail} />}

          {!hasData ? (
            <section className="card empty" aria-labelledby="empty-title">
              <h2 id="empty-title" className="empty-title">See your spending without uploading your statement</h2>
              <ol className="steps">
                <li><span className="step-n">1</span><div><b>Load a statement</b><span>A CSV from your bank, or a synthetic sample.</span></div></li>
                <li><span className="step-n">2</span><div><b>Classify on this device</b><span>Each row is categorized here. Nothing is uploaded.</span></div></li>
                <li><span className="step-n">3</span><div><b>Ask a question</b><span>The cloud sees only the text you approve at the gate.</span></div></li>
              </ol>
              <div className="empty-actions">
                <button className="btn btn-primary" onClick={() => loadSample('sample-statement-2.csv')}>Try sample · 60 rows</button>
                <button className="btn" onClick={() => loadSample('sample-statement-1.csv')}>Try sample · 247 rows</button>
                <span className="or">or</span>
                <DropZone dragOver={dragOver} setDragOver={setDragOver} onFile={onFile} input={fileInput} />
              </div>
              <p className="fine">Samples use fictional merchants. You can verify the zero-upload claim in DevTools → Network.</p>
            </section>
          ) : (
            <section className="card source" aria-labelledby="source-title">
              <div className="source-row">
                <div className="source-file">
                  <h2 id="source-title" className="card-title">{fileName}</h2>
                  <p className="card-meta">
                    {plural(txs.length, 'transaction')} · {uniqueKeys.length} unique merchants · {level === 'user-detail' ? 'your file' : 'synthetic sample'}{isRestored ? ' · restored from this browser' : ''}
                  </p>
                </div>
                <div className="source-actions">
                  <DropZone compact dragOver={dragOver} setDragOver={setDragOver} onFile={onFile} input={fileInput} />
                  <button className="btn btn-primary" disabled={busy || txs.length === 0} onClick={classify}>
                    {busy ? 'Classifying…' : ready ? 'Classify again' : 'Classify on this device'}
                  </button>
                </div>
              </div>

              {csv && (
                <details className="columns">
                  <summary>Columns: {cols.date || '—'} · {cols.description || '—'} · {isSplit(cols) ? `${cols.debit} / ${cols.credit}` : cols.amount || '—'}</summary>
                  <div className="columns-grid">
                    {(['date', 'description'] as const).map((k) => (
                      <label key={k} className="field"><span>{k === 'date' ? 'Date' : 'Description'}</span>
                        <select value={cols[k]} onChange={(e) => setCols({ ...cols, [k]: e.target.value })}>
                          <option value="">(none)</option>
                          {csv.headers.map((h) => <option key={h}>{h}</option>)}
                        </select>
                      </label>
                    ))}
                    {isSplit(cols) ? (['debit', 'credit'] as const).map((k) => (
                      <label key={k} className="field"><span>{k === 'debit' ? 'Debit' : 'Credit'}</span>
                        <select value={cols[k]} onChange={(e) => setCols({ ...cols, [k]: e.target.value })}>
                          {csv.headers.map((h) => <option key={h}>{h}</option>)}
                        </select>
                      </label>
                    )) : (
                      <label className="field"><span>Amount</span>
                        <select value={cols.amount} onChange={(e) => setCols({ ...cols, amount: e.target.value })}>
                          <option value="">(none)</option>
                          {csv.headers.map((h) => <option key={h}>{h}</option>)}
                        </select>
                      </label>
                    )}
                    {!isSplit(cols) && (
                      <label className="field"><span>Spending is</span>
                        <select value={signSel} onChange={(e) => setSignSel(e.target.value as 'auto' | SignMode)}>
                          <option value="auto">auto ({signMode === 'expenses-negative' ? 'negative' : 'positive'})</option>
                          <option value="expenses-negative">negative numbers</option>
                          <option value="expenses-positive">positive numbers</option>
                        </select>
                      </label>
                    )}
                    {isSplit(cols)
                      ? <button className="btn btn-quiet" onClick={() => setCols({ ...cols, debit: '', credit: '' })}>Use a single amount column</button>
                      : <button className="btn btn-quiet" disabled={csv.headers.length < 4} onClick={() => { const g = guessColumns(csv.headers); setCols({ ...cols, debit: g.debit || csv.headers[0], credit: g.credit || csv.headers[1] }) }}>Use Debit / Credit columns</button>}
                  </div>
                </details>
              )}

              <div className="route-line">
                <SideTag side={decision.side} />
                <code className="mode">{decision.mode}</code>
                <span>{decision.reason}</span>
              </div>

              {busy && (
                <div className="progress" role="status" aria-live="polite">
                  <div className="progress-head">
                    <span className="pulse" aria-hidden="true" />
                    <b>{phase?.label ?? 'Working'}</b>
                    <span className="mono progress-time">{elapsed} s</span>
                  </div>
                  {prog ? (
                    <>
                      <div className="bar" aria-hidden="true"><span style={{ width: `${(prog.done / Math.max(1, prog.total)) * 100}%` }} /></div>
                      <div className="progress-detail">
                        <span className="mono">{prog.done} / {prog.total} merchants</span>
                        {workingKeys.length > 0 && <span>now: <code>{workingKeys.join(', ')}</code></span>}
                        {prog.done === 0 && <span>The first call warms up the model (about 15–30 s); then about 1–2 s per merchant.</span>}
                        {prog.last && <span className="muted">last: {prog.last.key} → {prog.last.category ?? 'unknown'}</span>}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className={`bar ${dl === null || dl === 0 ? 'bar-indef' : ''}`} aria-hidden="true"><span style={{ width: `${(dl ?? 0) * 100}%` }} /></div>
                      <div className="progress-detail">
                        <span>{phase?.detail}</span>
                        {dl !== null && dl > 0 && dl < 1 && <span className="mono">model download {Math.round(dl * 100)}% (about 4 GB, first run only)</span>}
                      </div>
                    </>
                  )}
                </div>
              )}
              {!busy && engine && ready && (
                <p className={`notice ${engine === 'device' ? 'notice-ok' : 'notice-warn'}`}>
                  {engine === 'device' ? <IconCheck size={16} /> : <IconRules size={16} />}
                  <span>
                    {engine === 'device'
                      ? `${plural(doneCount, 'row')} classified by the on-device model${lastClassifyMs ? ` in ${Math.round(lastClassifyMs / 1000)} s` : ''}. Unknown merchants may be wrong; pick a category to correct it.`
                      : `Local keyword rules were used (no model). ${note}`}
                  </span>
                </p>
              )}
              {note && engine !== 'rules' && <p className="notice" role="status">{note}</p>}
            </section>
          )}

          {hasData && (
            <div className="dash">
              <section className="card tx" aria-labelledby="tx-title">
                <div className="card-head">
                  <h2 id="tx-title" className="card-title">Transactions</h2>
                  <span className="card-meta mono">{doneCount} / {txs.length} categorized</span>
                </div>
                <div className="scroll">
                  <table className={`table ${busy ? 'live' : ''}`}>
                    <thead><tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col" className="num">Amount</th><th scope="col">Category</th></tr></thead>
                    <tbody>
                      {classified.map((t) => {
                        const working = workingKeys.includes(normalizeDesc(t.desc))
                        return (
                          <tr key={t.id} className={t.category ? 'done' : working ? 'working' : busy ? 'waiting' : ''}>
                            <td className="mono dim">{t.date}</td>
                            <td className="desc">{t.desc}</td>
                            <td className={`num mono ${t.amount > 0 ? 'pos' : ''}`}>{money(t.amount)}</td>
                            <td>
                              <select className="cat" aria-label={`Category for ${t.desc}`} value={t.category ?? ''} onChange={(e) => e.target.value && correct(t, e.target.value as Category)}>
                                <option value="">{working ? 'classifying…' : '—'}</option>
                                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                              </select>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="card spend" aria-labelledby="spend-title">
                <div className="card-head">
                  <h2 id="spend-title" className="card-title">Spending by category</h2>
                  {totalSpend > 0 && <span className="card-meta mono">{money(totalSpend)} total</span>}
                </div>
                {spendRows.length === 0 ? <p className="muted">Classify to see totals.</p> : (
                  <ul className="bars" aria-label="Spending by category">
                    {spendRows.map(([k, v]) => (
                      <li key={k}>
                        <span className="bars-lbl">{k}</span>
                        <span className="bars-track" aria-hidden="true"><span style={{ width: `${Math.max(1.5, (v / maxSpend) * 100)}%` }} /></span>
                        <span className="bars-val mono">{Math.round(v).toLocaleString('en-US')}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}

          <section className="card ask" aria-labelledby="ask-title">
            <div className="card-head">
              <h2 id="ask-title" className="card-title">Ask about your spending</h2>
              <span className="card-meta">Blind analysis: the plan runs here, on your data</span>
            </div>
            <div className="chips-row" role="group" aria-label="Example questions">
              {EXAMPLE_QUESTIONS.map((q) => <button key={q} className="btn btn-chip" disabled={!ready || askBusy} onClick={() => ask(q)}>{q}</button>)}
            </div>
            <form className="ask-form" onSubmit={(e) => { e.preventDefault(); ask(question) }}>
              <label className="sr-only" htmlFor="q">Your question</label>
              <input id="q" className="input" value={question} placeholder={ready ? 'Ask in one sentence, e.g. How much did I spend on Dining?' : 'Classify a statement first'} onChange={(e) => setQuestion(e.target.value)} disabled={!ready} />
              <button type="submit" className="btn btn-primary" disabled={!ready || askBusy || !question.trim()}>Ask</button>
            </form>
            <p className="fine">
              {cloudOk
                ? 'Before anything is sent, you see the exact text at the outbound gate. Declining uses a fixed pattern picked on this device.'
                : `${cloudWhy} Questions use fixed patterns (on-device model if available, otherwise keywords).`}
            </p>
            {askBusy && phase && !phase.label.includes('budget advice') && (
              <div className={`progress ${phase.where === 'cloud' ? 'progress-cloud' : ''}`} role="status" aria-live="polite">
                <div className="progress-head">
                  <span className="pulse" aria-hidden="true" />
                  <b>{phase.label}</b>
                  <span className="mono progress-time">{elapsed} s</span>
                </div>
                {phase.detail && <div className="progress-detail"><span>{phase.detail}</span></div>}
              </div>
            )}
            {answer && (
              <div className="answer" aria-live="polite">
                <h3 className="answer-q">{answer.q}</h3>
                <p className={`notice ${answer.outcome.unsupported ? 'notice-warn' : ''}`}>
                  <SideTag side={answer.outcome.source === 'none' ? 'none' : answer.outcome.source} />
                  <span>{answer.outcome.note}{answer.outcome.cached ? ' (cached answer, nothing sent)' : ''}</span>
                </p>
                {answer.result ? (
                  <table className="table result">
                    <thead><tr><th scope="col">{answer.result.groupBy ?? 'Result'}</th><th scope="col" className="num">{answer.result.aggregate}</th><th scope="col" className="num">rows</th><th scope="col"><span className="sr-only">Bar</span></th></tr></thead>
                    <tbody>
                      {answer.result.rows.map((r) => (
                        <tr key={r.label}>
                          <td>{r.label}</td><td className="num mono strong">{fmt(r.value, answer.result!.aggregate)}</td><td className="num mono dim">{r.count}</td>
                          <td className="result-bar"><span className="bars-track" aria-hidden="true"><span style={{ width: `${Math.max(1, (Math.abs(r.value) / maxRow) * 100)}%` }} /></span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : !answer.outcome.unsupported && <p className="notice notice-warn">No result.</p>}
              </div>
            )}
          </section>

          <section className="card timeline" aria-labelledby="tl-title">
            <div className="card-head">
              <h2 id="tl-title" className="card-title">Timeline</h2>
              <span className="card-meta mono">{deviceCalls} device · {cloudCalls} cloud · {timeline.length - deviceCalls - cloudCalls} rules</span>
            </div>
            {timeline.length === 0 ? <p className="muted">Every model call and rule run appears here, with where it ran and why.</p> : (
              <ol className="tl" aria-label="Calls, newest first">
                {timeline.slice(-80).reverse().map((e) => (
                  <li key={e.id} className={`tl-row tl-${e.side}`}>
                    <SideTag side={e.side} />
                    <div className="tl-main">
                      <div className="tl-task">{e.task}</div>
                      <div className="tl-why"><code className="mode">{e.mode}</code> {e.reason}</div>
                    </div>
                    <div className="tl-nums mono">
                      <span>{Math.round(e.ms).toLocaleString('en-US')} ms</span>
                      <span className={e.bytesSent ? 'out' : 'dim'}>{e.bytesSent.toLocaleString('en-US')} B sent</span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <div className="zone-foot">
            <p className="fine">Corrections, the timeline, the outbound ledger and your last statement live only in this browser until you erase them.</p>
            <button className="btn btn-danger" onClick={erase}>Erase all local data</button>
          </div>
        </main>

        <div className="boundary" aria-hidden="true">
          <span className="boundary-tag"><IconGate size={14} /> gate</span>
        </div>

        <aside className="zone zone-cloud" aria-labelledby="cloud-title">
          <div className="zone-head">
            <h2 id="cloud-title" className="zone-title"><IconCloud /> Cloud</h2>
            <p className="zone-sub">Outside this device. Text crosses only through the outbound gate, after you press Send.</p>
          </div>

          {!cloudOk && <p className="notice notice-warn"><IconAlert size={16} /><span>{cloudWhy} Cloud features are off; everything else works.</span></p>}

          <section className="card ledger" aria-labelledby="ledger-title">
            <div className="card-head">
              <h3 id="ledger-title" className="card-title">Outbound ledger</h3>
              <span className="card-meta mono">{sentBytes.toLocaleString('en-US')} B total</span>
            </div>
            {ledger.length === 0 ? (
              <p className="ledger-empty"><b>Nothing has left this device.</b> Each request you approve is listed here with the exact text that was sent.</p>
            ) : (
              <ol className="ledger-list">
                {[...ledger].reverse().map((e) => (
                  <li key={e.id}>
                    <details>
                      <summary>
                        <span className="ledger-task">{e.task}</span>
                        <span className="ledger-meta mono">{new Date(e.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} · {e.bytes.toLocaleString('en-US')} B</span>
                      </summary>
                      <div className="ledger-body">
                        <p className="ledger-outcome"><code className="mode">{e.mode}</code> {e.outcome}</p>
                        <div className="gd-label">Message sent</div>
                        <pre className="gd-pre" tabIndex={0}>{e.prompt}</pre>
                        <details className="gd-schema">
                          <summary>Instructions and response structure</summary>
                          <pre className="gd-pre" tabIndex={0}>{e.system}{'\n\n'}{JSON.stringify(e.schema, null, 1)}</pre>
                        </details>
                      </div>
                    </details>
                  </li>
                ))}
              </ol>
            )}
            <p className="fine">Counted since the last erase, across reloads. Verify in DevTools → Network.</p>
          </section>

          <section className="card advice" aria-labelledby="advice-title">
            <h3 id="advice-title" className="card-title">Budget advice</h3>
            <p className="fine">Sends whole-number category percentages only. No transactions, merchants, dates or amounts.</p>
            <button className="btn btn-cloud" disabled={!ready || !cloudOk || askBusy} onClick={prepareAdvice}>Review what would be sent</button>
            {!ready && <p className="fine">Classify a statement first.</p>}
            {askBusy && phase && phase.label.includes('budget advice') && (
              <div className="progress progress-cloud" role="status" aria-live="polite">
                <div className="progress-head"><span className="pulse" aria-hidden="true" /><b>Waiting for the cloud</b><span className="mono progress-time">{elapsed} s</span></div>
                <div className="progress-detail"><span>{phase.detail}</span></div>
              </div>
            )}
            {advice?.error && <p className="notice notice-warn">{advice.error}</p>}
            {advice?.advice && <ol className="tips">{advice.advice.tips.map((t) => <li key={t.title}><b>{t.title}</b><span>{t.detail}</span></li>)}</ol>}
          </section>

          <section className="card modes" aria-labelledby="modes-title">
            <h3 id="modes-title" className="card-title">How each task is routed</h3>
            <ul className="mode-list">
              {MODES.map((m) => (
                <li key={m.mode} className={decision.mode === m.mode && hasData ? 'is-current' : ''}>
                  <div className="mode-top"><SideTag side={m.side} /><code className="mode">{m.mode}</code>{decision.mode === m.mode && hasData && <span className="mode-now">now</span>}</div>
                  <div className="mode-why"><b>{m.use}.</b> {m.why}</div>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>

      {pending && (
        <ManifestDialog
          m={pending.manifest}
          onSend={() => confirmPending(true)}
          onCancel={() => confirmPending(false)}
          cancelText={pending.kind === 'plan' ? "Don't send · use a fixed pattern" : "Don't send"}
        />
      )}
    </div>
  )
}

function SideTag({ side }: { side: Side }) {
  const label = side === 'device' ? 'Device' : side === 'cloud' ? 'Cloud' : side === 'rules' ? 'Rules' : 'Off'
  return (
    <span className={`side side-${side}`}>
      {side === 'device' ? <IconDevice size={13} /> : side === 'cloud' ? <IconCloud size={13} /> : <IconRules size={13} />}
      {label}
    </span>
  )
}

function DropZone({ compact, dragOver, setDragOver, onFile, input }: {
  compact?: boolean; dragOver: boolean; setDragOver: (b: boolean) => void; onFile: (f: File | undefined) => void; input: RefObject<HTMLInputElement | null>
}) {
  return (
    <div
      className={`drop ${compact ? 'drop-compact' : ''} ${dragOver ? 'is-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); onFile(e.dataTransfer.files[0]) }}
    >
      <button type="button" className="btn btn-quiet" onClick={() => input.current?.click()}>
        <IconUpload size={16} /> {compact ? 'Load another CSV' : 'Choose your CSV'}
      </button>
      {!compact && <span className="drop-hint">or drop it here</span>}
      <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = '' }} />
    </div>
  )
}

function NoModel({ avail }: { avail: Availability }) {
  const downloadable = avail === 'downloadable' || avail === 'downloading'
  return (
    <section className={`card nomodel ${downloadable ? 'nomodel-dl' : ''}`} aria-labelledby="nomodel-title">
      <h2 id="nomodel-title" className="card-title"><IconAlert size={18} /> {downloadable ? 'The on-device model is not downloaded yet' : 'No on-device model in this browser'}</h2>
      <dl className="nomodel-grid">
        <div><dt>Detected</dt><dd>{avail === 'unsupported' ? 'Prompt API not found.' : avail === 'unavailable' ? 'Prompt API present, model unavailable on this machine.' : avail === 'downloading' ? 'Model is downloading.' : 'Model can be downloaded (about 4 GB, first run only).'}</dd></div>
        <div><dt>Will use instead</dt><dd>{downloadable ? 'Press Classify to start the download; rows are classified when it finishes.' : 'Local keyword rules. Your statement is still not uploaded.'}</dd></div>
        <div><dt>To enable</dt><dd>Desktop Chrome with the built-in model. Check its status at <code>chrome://on-device-internals</code>.</dd></div>
      </dl>
    </section>
  )
}
