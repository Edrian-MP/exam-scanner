import { useEffect, useMemo, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { API_BASE, apiGet, apiPost } from './lib/api'

const NIGHT_MODE_STORAGE_KEY = 'exam_scanner_night_mode'

const defaultExam = {
  title: '',
  total_items: '',
  answer_key: '',
}

GlobalWorkerOptions.workerSrc = pdfWorkerSrc

function scorePercent(score, total) {
  if (!total) return 0
  return Math.round((score / total) * 100)
}

function createEmptyItems(total) {
  const parsed = Number(total)
  const safeTotal = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
  return Array.from({ length: safeTotal }, () => '')
}

function normalizeItem(value) {
  return value
    .toUpperCase()
    .replace(/[^A-Z/]/g, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

function isValidItem(value) {
  return /^[A-Z](\/[A-Z])*$/.test(value)
}

function extractTotalItemsFromText(text) {
  if (!text) return 0

  // Check for explicit total declaration first
  const explicit = text.match(/Total\s*(?:Items|Questions)\s*[:\-]?\s*(\d{1,3})/i)
  if (explicit) {
    const n = Number(explicit[1])
    if (Number.isFinite(n) && n >= 1 && n <= 200) return n
  }

  // Collect ALL numbers that appear at the start of a line followed by . or )
  // This works even if the answer letter is on a separate text item
  const allNumbers = []
  for (const match of text.matchAll(/(?:^|\n)\s*(\d{1,3})\s*[.\)]/gm)) {
    const n = Number(match[1])
    if (Number.isFinite(n) && n >= 1 && n <= 200) {
      allNumbers.push(n)
    }
  }

  if (allNumbers.length > 0) return Math.max(...allNumbers)
  return 0
}

function extractAnswerKeyFromText(text, totalItems) {
  if (!text || !totalItems) return []

  const answers = {}

  // Match patterns like "1. A", "1.A", "1) A", "1 A" on the same or adjacent lines
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // Try to match "number. letter" on the same line
    const sameLine = line.match(/^(\d{1,3})\s*[.\)]\s*([A-Da-d])$/)
    if (sameLine) {
      answers[Number(sameLine[1])] = sameLine[2].toUpperCase()
      continue
    }

    // Try to match just a number line, then check next line for the letter
    const numOnly = line.match(/^(\d{1,3})\s*[.\)]$/)
    if (numOnly && i + 1 < lines.length) {
      const nextLine = lines[i + 1].trim()
      const letterOnly = nextLine.match(/^([A-Da-d])$/)
      if (letterOnly) {
        answers[Number(numOnly[1])] = letterOnly[1].toUpperCase()
        i++ // skip next line since we consumed it
        continue
      }
    }
  }

  // Build ordered array
  const result = []
  for (let n = 1; n <= totalItems; n++) {
    result.push(answers[n] || '')
  }
  return result
}

async function extractPdfTextWithPdfJs(file) {
  const buffer = await file.arrayBuffer()
  const pdf = await getDocument({ data: buffer }).promise
  const lines = []

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo)
    const content = await page.getTextContent()

    for (const item of content.items) {
      if (!('str' in item)) continue
      const value = (item.str || '').trim()
      if (!value) continue
      // Treat every item as its own line to preserve "1. A" structure
      lines.push(value)
    }
  }

  return lines.join('\n')
}

function App() {
  const [nightMode, setNightMode] = useState(() => {
    if (typeof window === 'undefined') return false
    const stored = window.localStorage.getItem(NIGHT_MODE_STORAGE_KEY)
    if (stored === 'true') return true
    if (stored === 'false') return false
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  })
  const [health, setHealth] = useState(null)
  const [scanner, setScanner] = useState(null)
  const [exams, setExams] = useState([])
  const [examForm, setExamForm] = useState(defaultExam)
  const [answerKeyItems, setAnswerKeyItems] = useState(() => createEmptyItems(defaultExam.total_items))
  const [gradeForm, setGradeForm] = useState({ exam_id: '', student_code: '' })
  const [gradeAnswerItems, setGradeAnswerItems] = useState(() => createEmptyItems(0))
  const [scanRequest, setScanRequest] = useState({ exam_id: '' })
  const [lastResult, setLastResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pdfImportStatus, setPdfImportStatus] = useState('')
  const answerKeyRef = useRef(null)
  const gradeAnswersRef = useRef(null)

  const latestExam = useMemo(() => exams[0] || null, [exams])
  const selectedGradeExam = useMemo(
    () => exams.find((exam) => String(exam.id) === String(gradeForm.exam_id)) || null,
    [exams, gradeForm.exam_id]
  )
  const answerKeyDisplay = useMemo(
    () => answerKeyItems.map((val, i) => `${i + 1}. ${val}`).join('\n'),
    [answerKeyItems]
  )
  const gradeAnswersDisplay = useMemo(
    () => gradeAnswerItems.map((val, i) => `${i + 1}. ${val}`).join('\n'),
    [gradeAnswerItems]
  )

  function getLineIndexFromCursor(ref, display, itemCount) {
    if (itemCount <= 0) return 0
    const el = ref.current
    if (!el) return 0
    const before = display.slice(0, el.selectionStart)
    return Math.min(itemCount - 1, before.split('\n').length - 1)
  }

  function setCursorToLine(ref, lineIndex, items) {
    const el = ref.current
    if (!el) return
    if (!items.length) return
    const safeLine = Math.max(0, Math.min(lineIndex, items.length - 1))
    let pos = 0
    for (let i = 0; i < safeLine; i++) {
      const prefix = `${i + 1}. `
      pos += prefix.length + `${items[i]}`.length + 1
    }
    // Place cursor after the prefix on the target line
    const targetPrefix = `${safeLine + 1}. `
    pos += targetPrefix.length
    requestAnimationFrame(() => {
      el.setSelectionRange(pos, pos)

      // Auto-scroll with one-line context above/below the active line.
      const computedStyle = window.getComputedStyle(el)
      const lineHeight = Number.parseInt(computedStyle.lineHeight, 10) || 20
      const paddingTop = Number.parseInt(computedStyle.paddingTop, 10) || 8

      const lineTop = safeLine * lineHeight + paddingTop
      const lineBottom = lineTop + lineHeight

      const visibleTop = el.scrollTop
      const visibleBottom = el.scrollTop + el.clientHeight

      if (lineBottom > visibleBottom) {
        el.scrollTop = lineBottom - el.clientHeight + lineHeight
      } else if (lineTop < visibleTop) {
        el.scrollTop = lineTop - lineHeight
      }
    })
  }

  async function bootstrap() {
    setError('')
    try {
      const [healthRes, scannerRes, examRes] = await Promise.all([
        apiGet('/health'),
        apiGet('/scanner/status'),
        apiGet('/exams'),
      ])
      setHealth(healthRes)
      setScanner(scannerRes)
      setExams(examRes.data || [])
      if ((examRes.data || [])[0]) {
        const firstId = String(examRes.data[0].id)
        setScanRequest((s) => ({ ...s, exam_id: firstId }))
        setGradeForm((s) => ({ ...s, exam_id: firstId }))
      }
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => {
    bootstrap()
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('night-mode', nightMode)
    window.localStorage.setItem(NIGHT_MODE_STORAGE_KEY, String(nightMode))
  }, [nightMode])

  useEffect(() => {
    const total = Number(selectedGradeExam?.total_items || 0)
    setGradeAnswerItems((prev) => {
      if (prev.length === total) return prev
      if (prev.length > total) return prev.slice(0, total)
      return [...prev, ...Array.from({ length: total - prev.length }, () => '')]
    })
  }, [selectedGradeExam])

  async function onCreateExam(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const totalItems = Number(examForm.total_items)
      if (!Number.isFinite(totalItems) || totalItems < 1) {
        throw new Error('Total items must be at least 1.')
      }
      const normalizedItems = answerKeyItems.map((value) => normalizeItem(value))
      const hasInvalid = normalizedItems.some((value) => value === '' || !isValidItem(value))
      if (normalizedItems.length !== totalItems || hasInvalid) {
        throw new Error('Answer key must have exactly one valid entry per item (use A or A/B format).')
      }

      const payload = {
        ...examForm,
        total_items: totalItems,
        answer_key: normalizedItems.join('\n'),
      }
      await apiPost('/exams', payload)
      setExamForm(defaultExam)
      setAnswerKeyItems(createEmptyItems(defaultExam.total_items))
      setPdfImportStatus('')
      await bootstrap()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function onScan(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = await apiPost('/scanner/scan', scanRequest)
      setLastResult(result)
      await bootstrap()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function onGrade(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const normalizedItems = gradeAnswerItems.map((value) => normalizeItem(value))
      const total = Number(selectedGradeExam?.total_items || 0)
      const hasInvalid = normalizedItems.some((value) => value === '' || !isValidItem(value))
      if (!total || normalizedItems.length !== total || hasInvalid) {
        throw new Error('Answers must have exactly one valid entry per item (use A or A/B format).')
      }

      const result = await apiPost('/grade/submit', {
        ...gradeForm,
        answers: normalizedItems.join('\n'),
      })
      setLastResult(result)
      setGradeForm((s) => ({ ...s, student_code: '' }))
      setGradeAnswerItems(createEmptyItems(total))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function onTotalItemsChange(value) {
    if (value === '') {
      setExamForm((s) => ({ ...s, total_items: '' }))
      setAnswerKeyItems([])
      return
    }
    const parsed = Number(value)
    const safeTotal = Number.isFinite(parsed) ? Math.min(200, Math.max(1, Math.floor(parsed))) : 1
    setExamForm((s) => ({ ...s, total_items: safeTotal }))
    setAnswerKeyItems((prev) => {
      if (prev.length === safeTotal) return prev
      if (prev.length > safeTotal) return prev.slice(0, safeTotal)
      return [...prev, ...Array.from({ length: safeTotal - prev.length }, () => '')]
    })
  }

  async function onExamPdfUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setPdfImportStatus('')
    const titleFromFileName = file.name.replace(/\.[^.]+$/, '').trim()
    const nextStatus = []

    if (titleFromFileName) {
      setExamForm((s) => ({ ...s, title: titleFromFileName }))
      nextStatus.push(`Title from file name: ${titleFromFileName}`)
    }

    try {
      const pdfText = await extractPdfTextWithPdfJs(file)

      const totalItems = extractTotalItemsFromText(pdfText)
      if (totalItems > 0) {
        onTotalItemsChange(String(totalItems))
        nextStatus.push(`Total items detected: ${totalItems}`)
      } else {
        nextStatus.push('Total items not detected from PDF.')
      }

      // Extract answer key letters
      const extractedAnswers = extractAnswerKeyFromText(pdfText, totalItems)
      if (extractedAnswers.length > 0) {
        setAnswerKeyItems(extractedAnswers)
        nextStatus.push(`Answer key extracted: ${extractedAnswers.length} items`)
      } else {
        nextStatus.push('Answer key not detected from PDF.')
      }

    } catch {
      nextStatus.push('Failed to read PDF.')
    }

    setPdfImportStatus(nextStatus.join(' | '))
  }

  function onAnswerKeyKeyDown(e) {
    if (!answerKeyItems.length) return
    const { key } = e
    const line = getLineIndexFromCursor(answerKeyRef, answerKeyDisplay, answerKeyItems.length)
    const current = answerKeyItems[line] || ''

    if (key === 'ArrowUp') {
      e.preventDefault()
      setCursorToLine(answerKeyRef, line - 1, answerKeyItems)
      return
    }
    if (key === 'ArrowDown' || key === 'Enter') {
      e.preventDefault()
      setCursorToLine(answerKeyRef, line + 1, answerKeyItems)
      return
    }
    if (key === 'Backspace' || key === 'Delete') {
      e.preventDefault()
      setAnswerKeyItems((prev) => {
        const next = [...prev]
        next[line] = ''
        return next
      })
      setCursorToLine(answerKeyRef, line, answerKeyItems)
      return
    }
    if (key === '/') {
      e.preventDefault()
      if (/^[A-Z]$/.test(current)) {
        setAnswerKeyItems((prev) => {
          const next = [...prev]
          next[line] = `${current}/`
          return next
        })
        setCursorToLine(answerKeyRef, line, answerKeyItems)
        return
      }
      if (current === '' && line > 0 && /^[A-Z]$/.test(answerKeyItems[line - 1] || '')) {
        setAnswerKeyItems((prev) => {
          const next = [...prev]
          next[line - 1] = `${next[line - 1]}/`
          return next
        })
        setCursorToLine(answerKeyRef, line - 1, answerKeyItems)
        return
      }
      return
    }
    if (/^[a-zA-Z]$/.test(key)) {
      e.preventDefault()
      const upper = key.toUpperCase()
      setAnswerKeyItems((prev) => {
        const next = [...prev]
        const lineValue = next[line] || ''
        if (lineValue.endsWith('/')) {
          next[line] = `${lineValue}${upper}`
        } else {
          next[line] = upper
        }
        return next
      })
      setCursorToLine(answerKeyRef, line + 1, answerKeyItems)
      return
    }
    if (key.length === 1) {
      e.preventDefault()
    }
  }

  function onAnswerKeyPaste(e) {
    if (!answerKeyItems.length) return
    e.preventDefault()
    const raw = e.clipboardData.getData('text') || ''
    if (!raw.trim()) return

    const tokens = raw
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\d+\s*[.)-]?\s*/, '').trim())
      .map((line) => normalizeItem(line))
      .filter(Boolean)

    if (!tokens.length) return

    const startLine = getLineIndexFromCursor(answerKeyRef, answerKeyDisplay, answerKeyItems.length)
    setAnswerKeyItems((prev) => {
      const next = [...prev]
      for (let i = 0; i < tokens.length; i += 1) {
        const idx = startLine + i
        if (idx >= next.length) break
        next[idx] = tokens[i]
      }
      return next
    })
    setCursorToLine(answerKeyRef, Math.min(startLine + tokens.length, answerKeyItems.length - 1), answerKeyItems)
  }

  function onGradeAnswersKeyDown(e) {
    if (!gradeAnswerItems.length) return
    const { key } = e
    const line = getLineIndexFromCursor(gradeAnswersRef, gradeAnswersDisplay, gradeAnswerItems.length)
    const current = gradeAnswerItems[line] || ''

    if (key === 'ArrowUp') {
      e.preventDefault()
      setCursorToLine(gradeAnswersRef, line - 1, gradeAnswerItems)
      return
    }
    if (key === 'ArrowDown' || key === 'Enter') {
      e.preventDefault()
      setCursorToLine(gradeAnswersRef, line + 1, gradeAnswerItems)
      return
    }
    if (key === 'Backspace' || key === 'Delete') {
      e.preventDefault()
      setGradeAnswerItems((prev) => {
        const next = [...prev]
        next[line] = ''
        return next
      })
      setCursorToLine(gradeAnswersRef, line, gradeAnswerItems)
      return
    }
    if (key === '/') {
      e.preventDefault()
      if (/^[A-Z]$/.test(current)) {
        setGradeAnswerItems((prev) => {
          const next = [...prev]
          next[line] = `${current}/`
          return next
        })
        setCursorToLine(gradeAnswersRef, line, gradeAnswerItems)
        return
      }
      if (current === '' && line > 0 && /^[A-Z]$/.test(gradeAnswerItems[line - 1] || '')) {
        setGradeAnswerItems((prev) => {
          const next = [...prev]
          next[line - 1] = `${next[line - 1]}/`
          return next
        })
        setCursorToLine(gradeAnswersRef, line - 1, gradeAnswerItems)
        return
      }
      return
    }
    if (/^[a-zA-Z]$/.test(key)) {
      e.preventDefault()
      const upper = key.toUpperCase()
      setGradeAnswerItems((prev) => {
        const next = [...prev]
        const lineValue = next[line] || ''
        if (lineValue.endsWith('/')) {
          next[line] = `${lineValue}${upper}`
        } else {
          next[line] = upper
        }
        return next
      })
      setCursorToLine(gradeAnswersRef, line + 1, gradeAnswerItems)
      return
    }
    if (key.length === 1) {
      e.preventDefault()
    }
  }

  function onGradeAnswersPaste(e) {
    if (!gradeAnswerItems.length) return
    e.preventDefault()
    const raw = e.clipboardData.getData('text') || ''
    if (!raw.trim()) return

    const tokens = raw
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\d+\s*[.)-]?\s*/, '').trim())
      .map((line) => normalizeItem(line))
      .filter(Boolean)

    if (!tokens.length) return

    const startLine = getLineIndexFromCursor(gradeAnswersRef, gradeAnswersDisplay, gradeAnswerItems.length)
    setGradeAnswerItems((prev) => {
      const next = [...prev]
      for (let i = 0; i < tokens.length; i += 1) {
        const idx = startLine + i
        if (idx >= next.length) break
        next[idx] = tokens[i]
      }
      return next
    })
    setCursorToLine(gradeAnswersRef, Math.min(startLine + tokens.length, gradeAnswerItems.length - 1), gradeAnswerItems)
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <section className="rounded-3xl border border-slate-200/80 bg-white/85 p-6 shadow-panel backdrop-blur sm:p-8">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="inline-flex rounded-full bg-brand-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-brand-700">
              Portable Exam Scanner and Automated Grading Terminal
            </p>
            <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">
              Operations Console
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-600">
              Create exams, trigger scanner jobs, and grade answer sheets from one interface.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 md:items-end">
            <button
              type="button"
              onClick={() => setNightMode((prev) => !prev)}
              className="rounded-xl border border-slate-300 bg-white/90 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
            >
              {nightMode ? 'Switch to day mode' : 'Switch to night mode'}
            </button>
            <div className="rounded-2xl bg-slate-900 px-4 py-3 text-xs text-slate-200">
              <p>API base</p>
              <p className="mt-1 font-mono text-[11px] text-cyan-300">{API_BASE}</p>
            </div>
          </div>
        </div>
      </section>

      {error ? (
        <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      ) : null}

      <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <article className="rounded-2xl bg-white p-4 shadow-panel">
          <p className="text-xs uppercase tracking-wide text-slate-500">Backend</p>
          <p className="mt-2 text-lg font-semibold text-ink">{health?.ok ? 'Online' : 'Unknown'}</p>
        </article>
        <article className="rounded-2xl bg-white p-4 shadow-panel">
          <p className="text-xs uppercase tracking-wide text-slate-500">Database</p>
          <p className="mt-2 text-lg font-semibold text-ink">{health?.db ? 'MySQL Ready' : 'Check DB'}</p>
        </article>
        <article className="rounded-2xl bg-white p-4 shadow-panel">
          <p className="text-xs uppercase tracking-wide text-slate-500">Scanner</p>
          <p className="mt-2 text-lg font-semibold text-ink">
            {scanner?.scanner?.connected ? 'Connected' : 'Offline'}
          </p>
        </article>
        <article className="rounded-2xl bg-white p-4 shadow-panel">
          <p className="text-xs uppercase tracking-wide text-slate-500">Exam Templates</p>
          <p className="mt-2 text-lg font-semibold text-ink">{exams.length}</p>
        </article>
      </section>

      <section className="mt-6 grid gap-6 xl:grid-cols-3">
        <form onSubmit={onCreateExam} className="rounded-2xl bg-white p-5 shadow-panel">
          <h2 className="font-display text-xl font-semibold">Create Exam Template</h2>
          <div className="mt-4 space-y-3 text-sm">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Upload Exam PDF (optional)
              </label>
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={onExamPdfUpload}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-brand-500 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-slate-700 focus:ring"
              />
              {pdfImportStatus ? <p className="mt-1 text-xs text-slate-600">{pdfImportStatus}</p> : null}
            </div>
            <input
              required
              value={examForm.title}
              onChange={(e) => setExamForm((s) => ({ ...s, title: e.target.value }))}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-brand-500 focus:ring"
              placeholder="Course / Exam title"
            />
            <input
              required
              min={1}
              max={200}
              type="number"
              value={examForm.total_items}
              onChange={(e) => onTotalItemsChange(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-brand-500 focus:ring"
              placeholder="Total items"
            />
            <textarea
              required
              ref={answerKeyRef}
              value={answerKeyDisplay}
              onChange={() => {}}
              onKeyDown={onAnswerKeyKeyDown}
              onPaste={onAnswerKeyPaste}
              className="h-28 w-full rounded-xl border border-slate-300 px-3 py-2 font-mono outline-none ring-brand-500 focus:ring"
              placeholder="A"
            />
            <button
              disabled={busy}
              className="w-full rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
            >
              Save Exam
            </button>
          </div>
        </form>

        <form onSubmit={onScan} className="rounded-2xl bg-white p-5 shadow-panel">
          <h2 className="font-display text-xl font-semibold">Scanner Controls</h2>
          <p className="mt-2 text-sm text-slate-600">
            Starts a scan job via PHP API, which forwards to the local Python scan controller.
          </p>
          <div className="mt-4 space-y-3 text-sm">
            <select
              required
              value={scanRequest.exam_id}
              onChange={(e) => setScanRequest({ exam_id: e.target.value })}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-brand-500 focus:ring"
            >
              <option value="">Select exam template</option>
              {exams.map((exam) => (
                <option key={exam.id} value={exam.id}>
                  {exam.title}
                </option>
              ))}
            </select>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
              <p className={scanner?.scanner?.connected ? 'text-emerald-700' : 'animate-pulseSoft text-amber-700'}>
                Scanner status: {scanner?.scanner?.connected ? 'ready' : 'waiting for device'}
              </p>
              <p className="mt-1">Transport: {scanner?.transport || 'n/a'}</p>
            </div>
            <button
              disabled={busy || !scanRequest.exam_id}
              className="w-full rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white transition hover:bg-slate-700 disabled:opacity-60"
            >
              Start Scan Job
            </button>
          </div>
        </form>

        <form onSubmit={onGrade} className="rounded-2xl bg-white p-5 shadow-panel">
          <h2 className="font-display text-xl font-semibold">Manual/Parsed Submission</h2>
          <div className="mt-4 space-y-3 text-sm">
            <select
              required
              value={gradeForm.exam_id}
              onChange={(e) => setGradeForm((s) => ({ ...s, exam_id: e.target.value }))}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-brand-500 focus:ring"
            >
              <option value="">Select exam template</option>
              {exams.map((exam) => (
                <option key={exam.id} value={exam.id}>
                  {exam.title}
                </option>
              ))}
            </select>
            <input
              required
              value={gradeForm.student_code}
              onChange={(e) => setGradeForm((s) => ({ ...s, student_code: e.target.value }))}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-brand-500 focus:ring"
              placeholder="Student code"
            />
            <textarea
              required
              ref={gradeAnswersRef}
              value={gradeAnswersDisplay}
              onChange={() => {}}
              onKeyDown={onGradeAnswersKeyDown}
              onPaste={onGradeAnswersPaste}
              className="h-28 w-full rounded-xl border border-slate-300 px-3 py-2 font-mono outline-none ring-brand-500 focus:ring"
              placeholder="A"
            />
            <button
              disabled={busy || !gradeForm.exam_id}
              className="w-full rounded-xl bg-emerald-600 px-4 py-2 font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
            >
              Grade Submission
            </button>
          </div>
        </form>
      </section>

      <section className="mt-6 grid gap-6 xl:grid-cols-2">
        <article className="rounded-2xl bg-white p-5 shadow-panel">
          <h3 className="font-display text-lg font-semibold">Latest Exam Template</h3>
          {latestExam ? (
            <div className="mt-3 space-y-1 text-sm text-slate-700">
              <p>Title: <span className="font-semibold">{latestExam.title}</span></p>
              <p>Total items: <span className="font-semibold">{latestExam.total_items}</span></p>
              <p>Created: <span className="font-semibold">{latestExam.created_at}</span></p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-600">No exam templates yet.</p>
          )}
        </article>

        <article className="rounded-2xl bg-white p-5 shadow-panel">
          <h3 className="font-display text-lg font-semibold">Last API Result</h3>
          {lastResult?.data?.score !== undefined ? (
            <div className="mt-3 text-sm text-slate-700">
              <p>
                Score: <span className="font-semibold">{lastResult.data.score}</span> / {lastResult.data.total_items}
              </p>
              <p>
                Percent: <span className="font-semibold">{scorePercent(lastResult.data.score, lastResult.data.total_items)}%</span>
              </p>
            </div>
          ) : (
            <pre className="mt-3 max-h-64 overflow-auto rounded-xl bg-slate-950 p-3 text-xs text-cyan-200">
              {JSON.stringify(lastResult, null, 2) || 'No recent actions.'}
            </pre>
          )}
        </article>
      </section>
    </main>
  )
}

export default App
