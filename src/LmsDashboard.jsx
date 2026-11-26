import { useEffect, useId, useMemo, useRef, useState } from 'react'
import ScanReview from './ScanReview'
import { apiDelete, apiGet, apiPost, apiPut } from './lib/api'

const MANUAL_ANSWER_GRID_STYLE = {
  gridTemplateRows: 'repeat(5, minmax(2.75rem, auto))',
  gridAutoFlow: 'column',
  gridAutoColumns: 'minmax(5.75rem, 1fr)',
}

/* CLASSLIST IMPORT HOOK */
function withEducatorId(path, educatorId) {
  if (!educatorId) return path
  const joiner = path.includes('?') ? '&' : '?'
  return path + joiner + 'educator_id=' + encodeURIComponent(String(educatorId))
}

function parseRowsFromSheet(rows) {
  const headerIdx = rows.findIndex(
    (r) => String(r[0] ?? '').toLowerCase().includes('school') ||
           String(r[0] ?? '').toLowerCase().includes('id')
  )
  const dataRows = headerIdx >= 0 ? rows.slice(headerIdx + 1) : rows.slice(3)
  return dataRows
    .filter((r) => r[0] && r[1])
    .map((r) => ({
      student_code: String(r[0]).trim(),
      surname: String(r[1]).trim(),
      given_name: String(r[2] ?? '').trim(),
      middle_name: String(r[3] ?? '').trim(),
      email: String(r[4] ?? '').trim(),
    }))
}

async function parseXlsx(file) {
  const XLSX = await import('xlsx')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 })
        resolve(parseRowsFromSheet(rows))
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

async function parsePdf(file) {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).href

  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const lines = []
  for (let p = 1; p <= pdf.numPages; p += 1) {
    const page = await pdf.getPage(p)
    const content = await page.getTextContent()
    const byY = {}
    for (const item of content.items) {
      const y = Math.round(item.transform[5])
      if (!byY[y]) byY[y] = []
      byY[y].push(item.str)
    }
    const sortedYs = Object.keys(byY).map(Number).sort((a, b) => b - a)
    for (const y of sortedYs) {
      lines.push(byY[y].join('\t'))
    }
  }

  const headerIdx = lines.findIndex(
    (l) => /school\s*id/i.test(l) || /surname/i.test(l)
  )
  const dataLines = headerIdx >= 0 ? lines.slice(headerIdx + 1) : lines

  return dataLines
    .map((l) => l.split(/\t+/).map((s) => s.trim()).filter(Boolean))
    .filter((cols) => cols.length >= 2 && /^\d{4}-\d+/.test(cols[0]))
    .map(([student_code, surname, given_name = '', middle_name = '', email = '']) => ({
      student_code,
      surname,
      given_name,
      middle_name,
      email,
    }))
}

function useImportClasslist({ subjectId, educatorId, onDone }) {
  const [status, setStatus] = useState('idle')
  const [preview, setPreview] = useState(null)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [errorMsg, setErrorMsg] = useState('')
  const inputRef = useRef(null)

  async function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setStatus('parsing')
    setErrorMsg('')
    try {
      const isPdf = file.name.toLowerCase().endsWith('.pdf')
      const students = isPdf ? await parsePdf(file) : await parseXlsx(file)
      if (!students.length) throw new Error('No student rows found. Check the file format.')
      setPreview(students)
      setStatus('idle')
    } catch (err) {
      setErrorMsg(err.message || 'Unable to parse classlist file.')
      setStatus('error')
    }
    e.target.value = ''
  }

  async function handleImport() {
    if (!preview?.length || !subjectId) return
    setStatus('importing')
    setProgress({ done: 0, total: preview.length })
    let done = 0
    const errors = []
    for (const student of preview) {
      try {
        await apiPost(
          withEducatorId('/lms/subjects/' + subjectId + '/students', educatorId),
          student
        )
      } catch (err) {
        const message = err?.message || 'Import failed'
        errors.push(student.student_code + ': ' + message)
      }
      done += 1
      setProgress({ done, total: preview.length })
    }

    setStatus('done')
    setPreview(null)
    setErrorMsg(errors.length ? 'Imported with ' + errors.length + ' error(s):\n' + errors.join('\n') : '')
    if (onDone) await onDone()
  }

  function reset() {
    setPreview(null)
    setStatus('idle')
    setErrorMsg('')
  }

  return {
    status,
    preview,
    progress,
    errorMsg,
    inputRef,
    handleFile,
    handleImport,
    reset,
  }
}
/* ─── form defaults ─────────────────────────────────── */
const emptySubjectForm      = { subject_code: '', title: '', term_label: '', description: '' }
const emptyStudentForm      = { student_code: '', surname: '', given_name: '', middle_name: '', email: '' }
const emptyActivityForm     = { title: '', activity_type: 'exam', exam_id: '', exam_code: '', max_score: '', due_at: '', grading_period: '', publish_status: 'draft' }

/* ─── utils ─────────────────────────────────────────── */
function formatPercent(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return 'N/A'
  return `${Math.round(Number(v))}%`
}

function gradeBg(row) {
  const p = Number(row.published_activities || 0)
  const avg = Number(row.average_percent || 0)
  if (p === 0) return 'bg-slate-100 text-slate-500'
  if (Number(row.completed_activities || 0) < p || avg < 75) return 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
  if (avg >= 90) return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
  return 'bg-sky-50 text-sky-700 ring-1 ring-sky-200'
}

function averageBadgeBg(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) {
    return 'bg-slate-100 text-slate-500 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-600'
  }
  const avg = Number(v)
  if (avg >= 85) return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-900/25 dark:text-emerald-300 dark:ring-emerald-700/70'
  if (avg >= 75) return 'bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-900/25 dark:text-amber-300 dark:ring-amber-700/70'
  return 'bg-rose-50 text-rose-700 ring-1 ring-rose-200 dark:bg-rose-900/25 dark:text-rose-300 dark:ring-rose-700/70'
}

function initials(name = '') {
  return name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase() || '?'
}

function formatStudentFullName(givenName = '', middleName = '', surname = '') {
  const given = String(givenName || '').trim()
  const middle = String(middleName || '').trim()
  const sur = String(surname || '').trim()
  const middleInitial = middle ? ` ${middle[0].toUpperCase()}.` : ''
  const givenPart = given ? `${given}${middleInitial}` : ''
  if (sur && givenPart) return `${sur}, ${givenPart}`
  return sur || givenPart || 'Unnamed Student'
}

function safeFilenamePart(value = '', fallback = 'subject') {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || fallback
}

/* ─── exam results & item analysis ──────────────────── */
function round2(v) {
  return Math.round(Number(v) * 100) / 100
}

function hasScore(row) {
  return row.score !== null && row.score !== undefined
}

function scorePercent(score, total) {
  return total > 0 ? round2((Number(score) / total) * 100) : null
}

function formatSubmittedAt(value) {
  if (!value) return ''
  const d = new Date(String(value).replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString()
}

function describeScores(exam) {
  const scores = (exam?.results || []).filter(hasScore).map((r) => Number(r.score))
  if (!scores.length) return null
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length
  const sd = Math.sqrt(scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length)
  return {
    count: scores.length,
    mean: round2(mean),
    sd: round2(sd),
    highest: Math.max(...scores),
    lowest: Math.min(...scores),
  }
}

// Difficulty index p = proportion of takers who answered correctly
function difficultyLabel(p) {
  if (p === null) return '—'
  if (p <= 0.20) return 'Very Difficult'
  if (p <= 0.40) return 'Difficult'
  if (p <= 0.60) return 'Average'
  if (p <= 0.80) return 'Easy'
  return 'Very Easy'
}

// Discrimination index D = (upper 27% correct − lower 27% correct) / group size
function discriminationLabel(d) {
  if (d === null) return '—'
  if (d < 0) return 'Negative'
  if (d < 0.20) return 'Poor'
  if (d < 0.30) return 'Fair'
  if (d < 0.40) return 'Good'
  return 'Very Good'
}

function itemDecision(p, d) {
  if (p === null || d === null) return '—'
  if (d < 0) return 'Reject'
  const goodP = p > 0.20 && p <= 0.80
  const goodD = d >= 0.20
  if (goodP && goodD) return 'Retain'
  if (goodP || goodD) return 'Revise'
  return 'Reject'
}

function computeItemAnalysis(exam) {
  const key = Array.isArray(exam?.answer_key) ? exam.answer_key : []
  const total = Number(exam?.total_items || key.length)
  const takers = (exam?.results || []).filter((r) => hasScore(r) && Array.isArray(r.answers))
  const n = takers.length
  const groupSize = n >= 2 ? Math.max(1, Math.round(n * 0.27)) : 0
  const ranked = [...takers].sort((a, b) => Number(b.score) - Number(a.score))
  const upper = ranked.slice(0, groupSize)
  const lower = groupSize ? ranked.slice(-groupSize) : []

  const letters = new Set(['A', 'B', 'C', 'D'])
  key.forEach((k) => { if (k) letters.add(k) })
  takers.forEach((r) => r.answers.forEach((a) => { if (a) letters.add(a) }))
  const options = [...letters].sort()

  const items = Array.from({ length: total }, (_, i) => {
    const k = key[i] || ''
    const isCorrect = (r) => Boolean(k) && (r.answers[i] || '') === k
    const counts = Object.fromEntries(options.map((o) => [o, 0]))
    let blank = 0
    takers.forEach((r) => {
      const a = r.answers[i] || ''
      if (a) counts[a] += 1
      else blank += 1
    })
    const correct = takers.filter(isCorrect).length
    const upperCorrect = upper.filter(isCorrect).length
    const lowerCorrect = lower.filter(isCorrect).length
    const p = n ? round2(correct / n) : null
    const d = groupSize ? round2((upperCorrect - lowerCorrect) / groupSize) : null
    return {
      item: i + 1,
      key: k,
      correct,
      p,
      difficulty: difficultyLabel(p),
      upperCorrect,
      lowerCorrect,
      d,
      discrimination: discriminationLabel(d),
      decision: itemDecision(p, d),
      counts,
      blank,
    }
  })

  return { n, groupSize, options, items }
}

function examSheetHeader(exam, subject, extra = []) {
  return [
    ['Subject', [subject?.subject_code, subject?.title].filter(Boolean).join(' — ')],
    ['Section / Term', subject?.term_label || ''],
    ['Exam', exam?.title || ''],
    ['Total Items', Number(exam?.total_items || 0)],
    ...extra,
    ['Exported', new Date().toLocaleString()],
    [],
  ]
}

function examExportFilename(kind, exam, subject) {
  const subjectPart = safeFilenamePart(subject?.subject_code || subject?.title, 'subject')
  const examPart = safeFilenamePart(exam?.title, 'exam')
  return `${kind}-${subjectPart}-${examPart}-${new Date().toISOString().slice(0, 10)}.xlsx`
}

async function exportExamResultsWorkbook(exam, subject) {
  if (!exam) return
  const XLSX = await import('xlsx')
  const total = Number(exam.total_items || 0)
  const rows = exam.results || []
  const stats = describeScores(exam)

  const resultRows = rows.map((r, i) => [
    i + 1,
    r.student_code || '',
    r.surname || '',
    r.given_name || '',
    r.middle_name || '',
    hasScore(r) ? Number(r.score) : '',
    total,
    hasScore(r) ? scorePercent(r.score, total) : '',
    hasScore(r) ? 'Taken' : 'Not taken',
    formatSubmittedAt(r.submitted_at),
  ])
  const summary = stats
    ? [
        [],
        ['Examinees', stats.count],
        ['Mean Score', stats.mean],
        ['Mean (%)', scorePercent(stats.mean, total)],
        ['Standard Deviation', stats.sd],
        ['Highest Score', stats.highest],
        ['Lowest Score', stats.lowest],
      ]
    : [[], ['No scanned results yet.']]

  const resultsSheet = XLSX.utils.aoa_to_sheet([
    ...examSheetHeader(exam, subject),
    ['No.', 'Student Code', 'Surname', 'Given Name', 'Middle Name', 'Score', 'Total Items', 'Percentage (%)', 'Status', 'Submitted At'],
    ...resultRows,
    ...summary,
  ])
  resultsSheet['!cols'] = [6, 14, 18, 20, 16, 8, 11, 14, 11, 22].map((wch) => ({ wch }))

  const itemHeaders = Array.from({ length: total }, (_, i) => `Item ${i + 1}`)
  const responsesSheet = XLSX.utils.aoa_to_sheet([
    ['Student Code', 'Name', 'Score', ...itemHeaders],
    ['ANSWER KEY', '', total, ...(exam.answer_key || [])],
    ...rows.filter(hasScore).map((r) => [
      r.student_code || '',
      formatStudentFullName(r.given_name, r.middle_name, r.surname),
      Number(r.score),
      ...(r.answers || []).map((a) => a || '—'),
    ]),
  ])
  responsesSheet['!cols'] = [{ wch: 14 }, { wch: 28 }, { wch: 7 }, ...itemHeaders.map(() => ({ wch: 7 }))]

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, resultsSheet, 'Exam Results')
  XLSX.utils.book_append_sheet(workbook, responsesSheet, 'Student Responses')
  XLSX.writeFile(workbook, examExportFilename('exam-results', exam, subject))
}

async function exportItemAnalysisWorkbook(exam, subject) {
  if (!exam) return
  const XLSX = await import('xlsx')
  const analysis = computeItemAnalysis(exam)
  const optionHeaders = [...analysis.options, 'Blank']

  const sheet = XLSX.utils.aoa_to_sheet([
    ...examSheetHeader(exam, subject, [
      ['Examinees', analysis.n],
      ['Upper / Lower Group Size (27%)', analysis.groupSize],
    ]),
    [
      'Item', 'Key', 'No. Correct', 'Difficulty Index (p)', 'Difficulty',
      'Upper Group Correct', 'Lower Group Correct', 'Discrimination Index (D)', 'Discrimination', 'Decision',
      ...optionHeaders,
    ],
    ...analysis.items.map((it) => [
      it.item,
      it.key,
      it.correct,
      it.p ?? '',
      it.difficulty,
      it.upperCorrect,
      it.lowerCorrect,
      it.d ?? '',
      it.discrimination,
      it.decision,
      ...analysis.options.map((o) => it.counts[o] || 0),
      it.blank,
    ]),
  ])
  sheet['!cols'] = [6, 6, 11, 18, 14, 18, 18, 22, 14, 10, ...optionHeaders.map(() => 7)].map((wch) => ({ wch }))

  const legend = XLSX.utils.aoa_to_sheet([
    ['Difficulty Index (p)', 'Interpretation'],
    ['0.00 – 0.20', 'Very Difficult'],
    ['0.21 – 0.40', 'Difficult'],
    ['0.41 – 0.60', 'Average'],
    ['0.61 – 0.80', 'Easy'],
    ['0.81 – 1.00', 'Very Easy'],
    [],
    ['Discrimination Index (D)', 'Interpretation'],
    ['0.40 and above', 'Very Good'],
    ['0.30 – 0.39', 'Good'],
    ['0.20 – 0.29', 'Fair'],
    ['0.00 – 0.19', 'Poor'],
    ['Below 0', 'Negative'],
    [],
    ['Decision', 'Rule'],
    ['Retain', 'Difficulty between 0.21 and 0.80 and Discrimination 0.20 or higher'],
    ['Revise', 'Only one of the two conditions above is met'],
    ['Reject', 'Neither condition is met, or Discrimination is negative'],
    [],
    ['p = No. Correct ÷ Examinees.  D = (Upper Correct − Lower Correct) ÷ Group Size, using the top and bottom 27% of examinees by score.'],
  ])
  legend['!cols'] = [{ wch: 26 }, { wch: 70 }]

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, 'Item Analysis')
  XLSX.utils.book_append_sheet(workbook, legend, 'Legend')
  XLSX.writeFile(workbook, examExportFilename('item-analysis', exam, subject))
}

function relativeTime(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const diff = Date.now() - d.getTime()
  const mins  = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days  = Math.floor(diff / 86400000)
  if (mins < 1)   return 'just now'
  if (mins < 60)  return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7)   return `${days}d ago`
  return d.toLocaleDateString()
}

function filenameToTitle(filename = '') {
  return String(filename || '').replace(/\.[^.]+$/, '').trim()
}

function parseAnswerGridDisplay(display = '') {
  return String(display || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+\s*[.)-]?\s*/, '').trim().toUpperCase())
    .filter(Boolean)
}

function isValidAnswerToken(token) {
  return /^[A-Z](\/[A-Z])*$/.test(String(token || '').trim())
}

function normalizeStoredAnswerKey(raw = '') {
  return String(raw || '')
    .split(/[|\r\n]+/)
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean)
    .join('|')
}

/* ─── activity type labels (DB value → display) ────── */
const ACTIVITY_TYPE_LABELS = {
  exam:     'Exam',
  quiz:     'Written Work',
  activity: 'Performance Task',
}
const ACTIVITY_TYPE_GROUP = {
  exam:     'qa',
  quiz:     'ww',
  activity: 'pt',
}
const GRADING_PERIODS = ['Q1', 'Q2', 'Q3', 'Q4']

/* ─── design tokens ────────────────────────────────── */
const TAB_META = {
  roster: {
    label: 'Class List',
    icon: <UsersIcon />,
    accent: { dot: 'bg-sky-500', text: 'text-sky-600', bg: 'bg-sky-50', btn: 'bg-sky-600 hover:bg-sky-700', badge: 'bg-sky-100 text-sky-700' },
  },
  activities: {
    label: 'Activities',
    icon: <ClipboardIcon />,
    accent: { dot: 'bg-violet-500', text: 'text-violet-600', bg: 'bg-violet-50', btn: 'bg-violet-600 hover:bg-violet-700', badge: 'bg-violet-100 text-violet-700' },
  },
  scan: {
    label: 'Scan',
    icon: <ScanIcon />,
    accent: { dot: 'bg-slate-700', text: 'text-slate-700', bg: 'bg-slate-50', btn: 'bg-slate-800 hover:bg-slate-700', badge: 'bg-slate-200 text-slate-700' },
  },
  results: {
    label: 'Exam Results',
    icon: <GradebookIcon />,
    accent: { dot: 'bg-emerald-500', text: 'text-emerald-600', bg: 'bg-emerald-50', btn: 'bg-emerald-600 hover:bg-emerald-700', badge: 'bg-emerald-100 text-emerald-700' },
  },
}

const ACTIVITY_TYPE_STYLES = {
  exam:     'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
  quiz:     'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
  activity: 'bg-teal-50 text-teal-700 ring-1 ring-teal-200',
}
const PUBLISH_STATUS_STYLES = {
  draft:     'bg-slate-100 text-slate-500',
  published: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  archived:  'bg-rose-50 text-rose-600 ring-1 ring-rose-200',
}

/* ═══════════════════════════════════════════════════════
   ATOMIC COMPONENTS
═══════════════════════════════════════════════════════ */

function Field({ label, hint, children, htmlFor: explicitFor }) {
  const autoId = useId()
  const fieldId = explicitFor || autoId
  // Inject id into first child if it's a React element without its own id
  const enhancedChildren = Array.isArray(children)
    ? children.map((child, i) => {
        if (i === 0 && child && typeof child === 'object' && 'props' in child && !child.props.id) {
          return { ...child, props: { ...child.props, id: fieldId } }
        }
        return child
      })
    : (children && typeof children === 'object' && 'props' in children && !children.props.id
        ? { ...children, props: { ...children.props, id: fieldId } }
        : children)

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <label htmlFor={fieldId} className="block text-[11px] font-bold uppercase tracking-widest text-slate-400">{label}</label>
        {hint && <span className="text-[11px] text-slate-400">{hint}</span>}
      </div>
      {enhancedChildren}
    </div>
  )
}

function TextInput({ className = '', ...props }) {
  return (
    <input
      className={`w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 shadow-sm outline-none placeholder:text-slate-300 transition-all duration-150 hover:border-slate-300 focus:border-brand-400 focus:ring-2 focus:ring-brand-100 ${className}`}
      {...props}
    />
  )
}

function SelectInput({ children, className = '', ...props }) {
  return (
    <select
      className={`w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 shadow-sm outline-none transition-all duration-150 hover:border-slate-300 focus:border-brand-400 focus:ring-2 focus:ring-brand-100 ${className}`}
      {...props}
    >
      {children}
    </select>
  )
}

function BoundedSelect({
  value,
  onChange,
  options,
  placeholder = 'Select option',
  className = '',
  searchable = false,
  searchPlaceholder = 'Search...',
  emptySearchText = 'No matching options',
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(-1)
  const wrapRef = useRef(null)
  const listRef = useRef(null)
  const searchRef = useRef(null)
  const listboxId = useId()

  const selected = options.find((opt) => String(opt.value) === String(value))
  const queryNeedle = query.trim().toLowerCase()
  const visibleOptions = queryNeedle
    ? options.filter((opt) => String(opt.searchText || opt.label || '').toLowerCase().includes(queryNeedle))
    : options
  // Prepend the clear (placeholder) entry
  const allItems = [{ value: '', label: placeholder }, ...visibleOptions]

  useEffect(() => {
    function onDocClick(event) {
      if (!wrapRef.current?.contains(event.target)) {
        setOpen(false)
        setQuery('')
        setActiveIdx(-1)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  useEffect(() => {
    if (open && searchable) {
      // Use requestAnimationFrame to focus after mount
      requestAnimationFrame(() => searchRef.current?.focus())
    }
  }, [open, searchable])

  function selectItem(val) {
    onChange(val)
    setOpen(false)
    setQuery('')
    setActiveIdx(-1)
    wrapRef.current?.querySelector('button[role="combobox"]')?.focus()
  }

  function handleTriggerKeyDown(e) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setOpen(true)
      setActiveIdx(0)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  function handleListKeyDown(e) {
    if (e.key === 'Escape') {
      setOpen(false)
      setQuery('')
      setActiveIdx(-1)
      wrapRef.current?.querySelector('button[role="combobox"]')?.focus()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((prev) => Math.min(prev + 1, allItems.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((prev) => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (activeIdx >= 0 && allItems[activeIdx]) {
        selectItem(allItems[activeIdx].value)
      }
    }
  }

  // Scroll active item into view
  useEffect(() => {
    if (!open || activeIdx < 0 || !listRef.current) return
    const item = listRef.current.children[activeIdx]
    item?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  const activeDescendantId = activeIdx >= 0 ? `${listboxId}-item-${activeIdx}` : undefined

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeDescendantId}
        onClick={() => {
          setOpen((prev) => {
            if (prev) { setQuery(''); setActiveIdx(-1) }
            return !prev
          })
        }}
        onKeyDown={handleTriggerKeyDown}
        className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-left text-sm text-slate-800 shadow-sm outline-none transition-all duration-150 hover:border-slate-300 focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
      >
        <span className={selected ? 'truncate text-slate-800' : 'truncate text-slate-400'}>
          {selected ? selected.label : placeholder}
        </span>
        <svg className="h-4 w-4 flex-shrink-0 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg" onKeyDown={handleListKeyDown}>
          {searchable && (
            <div className="border-b border-slate-100 p-2">
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setActiveIdx(0) }}
                placeholder={searchPlaceholder}
                className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
              />
            </div>
          )}
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            tabIndex={-1}
            aria-label={placeholder}
            className="max-h-56 overflow-y-auto py-1"
          >
            {allItems.map((opt, idx) => {
              const isActive = idx === activeIdx
              const isClear = opt.value === ''
              const isSelected = String(opt.value) === String(value)
              return (
                <div
                  key={opt.value === '' ? '__clear__' : opt.value}
                  id={`${listboxId}-item-${idx}`}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => selectItem(opt.value)}
                  className={`cursor-pointer px-3.5 py-2 text-sm transition select-none ${
                    isActive ? 'bg-brand-50 text-brand-700' :
                    isSelected && !isClear ? 'bg-slate-100 font-semibold text-slate-800' :
                    isClear ? 'text-slate-500 hover:bg-slate-50' :
                    'text-slate-700 hover:bg-slate-50'
                  }`}
                  title={opt.label}
                >
                  <span className="block truncate">{opt.label}</span>
                </div>
              )
            })}
            {searchable && visibleOptions.length === 0 && (
              <p className="px-3.5 py-2 text-xs text-slate-400">{emptySearchText}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function TextareaInput({ className = '', ...props }) {
  return (
    <textarea
      className={`w-full resize-none rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 shadow-sm outline-none placeholder:text-slate-300 transition-all duration-150 hover:border-slate-300 focus:border-brand-400 focus:ring-2 focus:ring-brand-100 ${className}`}
      {...props}
    />
  )
}

function SubmitBtn({ children, colorClass, disabled, className = '' }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className={`inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${colorClass} ${className}`}
    >
      {children}
    </button>
  )
}

function GhostBtn({ children, className = '', ...props }) {
  return (
    <button
      className={`inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50 hover:border-slate-300 disabled:opacity-40 ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

function DangerBtn({ children, className = '', ...props }) {
  return (
    <button
      className={`inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-white px-3.5 py-2 text-xs font-semibold text-rose-600 shadow-sm transition hover:bg-rose-50 disabled:opacity-40 ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

function Badge({ children, className = '' }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${className}`}>
      {children}
    </span>
  )
}

function EmptyState({ icon, title, description }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-300">
        {icon}
      </div>
      <p className="text-sm font-semibold text-slate-400">{title}</p>
      {description && <p className="mt-1 text-xs text-slate-300">{description}</p>}
    </div>
  )
}

function StatusPill({ label, ok, okText, failText, count }) {
  if (count !== undefined) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 shadow-sm">
        {label}: <strong>{count}</strong>
      </span>
    )
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold shadow-sm ${ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-500'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-slate-300'}`} />
      {label}: {ok ? okText : failText}
    </span>
  )
}

/* ═══════════════════════════════════════════════════════
   STAT CARD
═══════════════════════════════════════════════════════ */
function StatCard({ icon, label, value, sub, accent }) {
  const a = {
    sky:    { wrap: 'bg-sky-50 border-sky-100',      iconWrap: 'bg-sky-100 text-sky-500',      val: 'text-sky-700' },
    violet: { wrap: 'bg-violet-50 border-violet-100', iconWrap: 'bg-violet-100 text-violet-500', val: 'text-violet-700' },
    emerald:{ wrap: 'bg-emerald-50 border-emerald-100', iconWrap: 'bg-emerald-100 text-emerald-500', val: 'text-emerald-700' },
    amber:  { wrap: 'bg-amber-50 border-amber-100',  iconWrap: 'bg-amber-100 text-amber-500',  val: 'text-amber-700' },
    slate:  { wrap: 'bg-white border-slate-200',     iconWrap: 'bg-slate-100 text-slate-400',  val: 'text-slate-700' },
  }[accent] || { wrap: 'bg-white border-slate-200', iconWrap: 'bg-slate-100 text-slate-400', val: 'text-slate-700' }

  return (
    <div className={`rounded-2xl border p-5 ${a.wrap}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400">{label}</p>
          <p className={`mt-1.5 text-3xl font-bold leading-none ${a.val}`}>{value}</p>
          {sub && <p className="mt-1 truncate text-xs text-slate-500">{sub}</p>}
        </div>
        <div className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl ${a.iconWrap}`}>{icon}</div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════
   MINI STAT (compact header strip)
═══════════════════════════════════════════════════════ */
function MiniStat({ icon, label, value, sub, accent }) {
  const a = {
    sky:     { iconWrap: 'text-sky-500',     val: 'text-sky-700'     },
    violet:  { iconWrap: 'text-violet-500',  val: 'text-violet-700'  },
    emerald: { iconWrap: 'text-emerald-500', val: 'text-emerald-700' },
    amber:   { iconWrap: 'text-amber-500',   val: 'text-amber-700'   },
    slate:   { iconWrap: 'text-slate-400',   val: 'text-slate-700'   },
  }[accent] || { iconWrap: 'text-slate-400', val: 'text-slate-700' }

  return (
    <div className="flex items-center gap-3 px-5 py-3">
      <span className={a.iconWrap}>{icon}</span>
      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{label}</p>
        <p className={`text-xl font-bold leading-tight ${a.val}`}>{value}</p>
        {sub && <p className="text-[11px] text-slate-400">{sub}</p>}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════
   CONFIRM MODAL
═══════════════════════════════════════════════════════ */
function ConfirmModal({ title, message, confirmLabel = 'Delete', onConfirm, onCancel }) {
  const dialogRef = useRef(null)
  const titleId = useId()

  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    const focusable = el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    focusable[0]?.focus()

    function onKeyDown(e) {
      if (e.key === 'Escape') { onCancel(); return }
      if (e.key !== 'Tab') return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last?.focus() }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }

    el.addEventListener('keydown', onKeyDown)
    return () => el.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-sm rounded-2xl border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <p id={titleId} className="text-base font-bold text-slate-800">{title}</p>
          {message && <p className="mt-2 text-sm text-slate-500">{message}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-6 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════
   TOAST STACK
═══════════════════════════════════════════════════════ */
function ToastStack({ toasts, onDismiss }) {
  if (!toasts.length) return null
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          className={`pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 shadow-lg text-sm transition-all ${
            t.type === 'error'
              ? 'border-rose-200 bg-rose-50 text-rose-700'
              : t.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-slate-200 bg-white text-slate-700'
          }`}
        >
          <span className="flex-1">{t.message}</span>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            aria-label="Dismiss notification"
            className="flex-shrink-0 opacity-60 hover:opacity-100 transition"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════
   TAB BAR
═══════════════════════════════════════════════════════ */
function TabBar({ activeTab, tabs, counts, onChange }) {
  return (
    <div role="tablist" className="inline-flex flex-wrap items-center gap-1 rounded-2xl bg-slate-100 p-1.5">
      {tabs.map((key) => {
        const meta   = TAB_META[key]
        const active = activeTab === key
        const count  = counts[key] ?? 0
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(key)}
            className={`relative flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all duration-200 ${
              active ? 'bg-white text-slate-800 shadow-sm ring-1 ring-slate-900/5' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <span className={`transition-colors duration-200 ${active ? meta.accent.text : 'text-slate-400'}`}>
              {meta.icon}
            </span>
            <span>{meta.label}</span>
            {count > 0 && (
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none transition-all duration-200 ${
                active ? meta.accent.badge : 'bg-slate-200 text-slate-500'
              }`}>
                {count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════
   ROSTER TAB
═══════════════════════════════════════════════════════ */
function ImportClasslistButton({ subjectId, educatorId, onDone }) {
  const {
    status,
    preview,
    progress,
    errorMsg,
    inputRef,
    handleFile,
    handleImport,
    reset,
  } = useImportClasslist({ subjectId, educatorId, onDone })

  return (
    <div className="flex flex-col gap-3">
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.pdf"
        className="hidden"
        onChange={handleFile}
      />

      {!preview && status !== 'importing' && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={status === 'parsing'}
          className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-700 transition-colors hover:bg-violet-100 disabled:opacity-50"
        >
          {status === 'parsing' ? (
            <><SpinIcon /> Parsing?</>
          ) : (
            <>
              <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
                <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
              </svg>
              Import Classlist
            </>
          )}
        </button>
      )}

      {status === 'importing' && (
        <div className="rounded-lg border border-violet-100 bg-violet-50 p-3 text-xs text-violet-700">
          <div className="mb-1.5 flex items-center gap-2">
            <SpinIcon /> Importing {progress.done} of {progress.total} students…
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-violet-100">
            <div
              className="h-full rounded-full bg-violet-500 transition-all duration-300"
              style={{ width: progress.total > 0 ? ((progress.done / progress.total) * 100) + '%' : '0%' }}
            />
          </div>
        </div>
      )}

      {preview && status !== "importing" && (
        <div className="overflow-hidden rounded-xl border border-violet-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-violet-100 bg-violet-50 px-3 py-2">
            <span className="text-xs font-bold text-violet-700">
              {preview.length} students found — ready to import
            </span>
            <button type="button" onClick={reset} className="text-slate-400 hover:text-slate-600">
              <XIcon />
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50">
                <tr>
                  {['ID', 'Surname', 'Given Name', 'Middle Name'].map((h) => (
                    <th key={h} className="px-3 py-1.5 text-left font-semibold text-slate-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {preview.map((s, i) => (
                  <tr key={i} className="hover:bg-slate-50">
                    <td className="px-3 py-1.5 font-mono text-slate-700">{s.student_code}</td>
                    <td className="px-3 py-1.5 text-slate-700">{s.surname}</td>
                    <td className="px-3 py-1.5 text-slate-500">{s.given_name}</td>
                    <td className="px-3 py-1.5 text-slate-500">{s.middle_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2 border-t border-slate-100 p-3">
            <button
              type="button"
              onClick={handleImport}
              className="flex-1 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-violet-700"
            >
              Confirm Import
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {status === 'done' && !errorMsg && (
        <p className="text-xs font-semibold text-emerald-600">Import complete!</p>
      )}
      {errorMsg && (
        <p className="whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">{errorMsg}</p>
      )}
    </div>
  )
}
function RosterTab({
  subjectId,
  educatorId,
  students, studentForm, setStudentForm, busyAction,
  editingStudentId, editStudentForm, setEditStudentForm,
  onAddStudent, onStartEditStudent, onEditStudent, onCancelEditStudent, onRemoveStudent, onDeleteSubject,
  onImportDone,
}) {
  const a = TAB_META.roster.accent
  const [showEnrollForm, setShowEnrollForm] = useState(false)

  // Auto-close enroll panel when the form resets after a successful submission
  const prevStudentCode = useRef(studentForm.student_code)
  useEffect(() => {
    if (prevStudentCode.current !== '' && studentForm.student_code === '') {
      setShowEnrollForm(false)
    }
    prevStudentCode.current = studentForm.student_code
  }, [studentForm.student_code])

  return (
    <div className="flex min-h-[520px] flex-col">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-6 py-4 dark:border-slate-700/60">
        <div>
          <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">Enrolled Students</h3>
          <p className="text-xs text-slate-400">{students.length} {students.length === 1 ? 'student' : 'students'}</p>
        </div>
        <div className="flex items-center gap-2">
          <ImportClasslistButton subjectId={subjectId} educatorId={educatorId} onDone={onImportDone} />
          <button
            type="button"
            onClick={() => setShowEnrollForm((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-semibold shadow-sm transition ${
              showEnrollForm
                ? 'border-slate-200 bg-slate-100 text-slate-600 hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300'
                : `border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100 dark:border-sky-700/70 dark:bg-sky-900/25 dark:text-sky-300`
            }`}
          >
            {showEnrollForm ? (
              <><XIcon /> Close</>
            ) : (
              <>
                <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" /></svg>
                Enroll Student
              </>
            )}
          </button>
        </div>
      </div>

      {/* Collapsible enroll form */}
      <div className={`overflow-hidden border-b border-slate-100 transition-all duration-300 ease-in-out dark:border-slate-700/60 ${showEnrollForm ? 'max-h-[600px] opacity-100' : 'max-h-0 opacity-0'}`}>
        <div className="bg-sky-50/50 px-6 py-5 dark:bg-sky-900/10">
          <p className="mb-4 text-xs font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500">New Student</p>
          <form onSubmit={onAddStudent}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Student ID / Code">
                <TextInput required value={studentForm.student_code}
                  onChange={(e) => setStudentForm((p) => ({ ...p, student_code: e.target.value }))}
                  placeholder="e.g. 2021-00142" />
              </Field>
              <Field label="Given Name">
                <TextInput required value={studentForm.given_name}
                  onChange={(e) => setStudentForm((p) => ({ ...p, given_name: e.target.value }))}
                  placeholder="Juan" />
              </Field>
              <Field label="Middle Name">
                <TextInput value={studentForm.middle_name}
                  onChange={(e) => setStudentForm((p) => ({ ...p, middle_name: e.target.value }))}
                  placeholder="Santos" />
              </Field>
              <Field label="Surname">
                <TextInput required value={studentForm.surname}
                  onChange={(e) => setStudentForm((p) => ({ ...p, surname: e.target.value }))}
                  placeholder="Dela Cruz" />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Email" hint="optional">
                  <TextInput type="email" value={studentForm.email}
                    onChange={(e) => setStudentForm((p) => ({ ...p, email: e.target.value }))}
                    placeholder="juan@school.edu" />
                </Field>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <SubmitBtn disabled={busyAction === 'student'} colorClass={a.btn}>
                {busyAction === 'student' ? <><SpinIcon /> Enrolling…</> : 'Enroll Student'}
              </SubmitBtn>
              <GhostBtn type="button" onClick={() => setShowEnrollForm(false)}>
                Cancel
              </GhostBtn>
            </div>
          </form>
        </div>
      </div>

      {/* Student list */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="space-y-2">
          {students.length ? students.map((s) => (
            <div key={s.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 transition hover:border-slate-200 hover:bg-white hover:shadow-sm dark:border-slate-700/60 dark:bg-slate-800/40 dark:hover:bg-slate-800"
            >
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-sky-100 text-[11px] font-bold text-sky-600 dark:bg-sky-900/40 dark:text-sky-300">
                  {initials(`${s.given_name || ''} ${s.surname || ''}`.trim() || s.surname)}
                </div>
                <div className="min-w-0 flex-1">
                  {String(editingStudentId) === String(s.id) ? (
                    <form onSubmit={(e) => onEditStudent(e, s.id)} className="grid gap-2 sm:grid-cols-2">
                      <TextInput required value={editStudentForm.student_code}
                        onChange={(e) => setEditStudentForm((p) => ({ ...p, student_code: e.target.value }))}
                        placeholder="Student ID / Code" />
                      <TextInput required value={editStudentForm.given_name}
                        onChange={(e) => setEditStudentForm((p) => ({ ...p, given_name: e.target.value }))}
                        placeholder="Given Name" />
                      <TextInput value={editStudentForm.middle_name}
                        onChange={(e) => setEditStudentForm((p) => ({ ...p, middle_name: e.target.value }))}
                        placeholder="Middle Name" />
                      <TextInput required value={editStudentForm.surname}
                        onChange={(e) => setEditStudentForm((p) => ({ ...p, surname: e.target.value }))}
                        placeholder="Surname" />
                      <div className="sm:col-span-2">
                        <TextInput type="email" value={editStudentForm.email}
                          onChange={(e) => setEditStudentForm((p) => ({ ...p, email: e.target.value }))}
                          placeholder="Email (optional)" />
                      </div>
                      <div className="sm:col-span-2 flex items-center gap-2">
                        <GhostBtn type="submit" disabled={busyAction === `edit-student-${s.id}`}>
                          {busyAction === `edit-student-${s.id}` ? <SpinIcon /> : <PenIcon />}
                          Save
                        </GhostBtn>
                        <GhostBtn type="button" onClick={onCancelEditStudent} disabled={busyAction === `edit-student-${s.id}`}>
                          <XIcon /> Cancel
                        </GhostBtn>
                      </div>
                    </form>
                  ) : (
                    <>
                      <p className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
                        {formatStudentFullName(s.given_name, s.middle_name, s.surname)}
                      </p>
                      <p className="font-mono text-[11px] text-slate-400">{s.student_code}</p>
                    </>
                  )}
                </div>
              </div>
              {String(editingStudentId) !== String(s.id) && (
                <div className="flex items-center gap-2">
                  <GhostBtn type="button" onClick={() => onStartEditStudent(s)}>
                    <PenIcon />
                  </GhostBtn>
                  <GhostBtn onClick={() => onRemoveStudent(s.id)} disabled={busyAction === `remove-student-${s.id}`}>
                    {busyAction === `remove-student-${s.id}` ? <SpinIcon /> : <XIcon />}
                  </GhostBtn>
                </div>
              )}
            </div>
          )) : (
            <EmptyState icon={<UsersIcon size="lg" />} title="No students enrolled yet" description="Click '+ Enroll Student' above to add your first student." />
          )}
        </div>
      </div>

      {/* Delete Subject — bottom, de-emphasized */}
      <div className="border-t border-slate-100 px-6 py-4 dark:border-slate-700/60">
        <DangerBtn onClick={onDeleteSubject} disabled={busyAction === 'delete-subject'}>
          {busyAction === 'delete-subject' ? <><SpinIcon /> Deleting…</> : <><TrashIcon /> Delete Subject</>}
        </DangerBtn>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════
   ACTIVITIES TAB
═══════════════════════════════════════════════════════ */
function ActivitiesTab({
  activities,
  activityForm,
  setActivityForm,
  scan,
  activityAttachmentName,
  busyAction,
  editingActivityId,
  onActivityExamPdfUpload,
  onRemoveActivityExamPdf,
  onCreateActivity,
  onStartEditActivity,
  onCancelEditActivity,
  onEditActivity,
  onDeleteActivity,
}) {
  const a = TAB_META.activities.accent
  const isCreateMode = !editingActivityId
  const hasAttachment = Boolean(activityAttachmentName)
  const shouldAutoTitle = isCreateMode && hasAttachment
  const uploadAnswerCount = parseAnswerGridDisplay(scan?.answerKeyDisplay || '').length
  const isUploadedAnswerKeyLocked = isCreateMode && hasAttachment && uploadAnswerCount > 0
  const activityPdfInputRef = useRef(null)
  const [showUploadDetails, setShowUploadDetails] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)

  // Form panel is visible when explicitly creating or when an edit is active
  const showFormPanel = showCreateForm || Boolean(editingActivityId)

  // Total Score field: read-only (from PDF) for exam with attachment, editable otherwise
  const isExamWithPdf = activityForm.activity_type === 'exam' && hasAttachment
  const totalScoreReadOnly = isExamWithPdf
  const totalScoreValue = isExamWithPdf
    ? (scan?.examForm?.total_items || '')
    : (activityForm.max_score || '')

  useEffect(() => {
    if (hasAttachment) setShowUploadDetails(true)
    else setShowUploadDetails(false)
  }, [hasAttachment])

  // Auto-close create form when the parent resets activityForm after successful save
  const prevActivityTitle = useRef(activityForm.title)
  useEffect(() => {
    if (prevActivityTitle.current !== '' && activityForm.title === '') {
      setShowCreateForm(false)
    }
    prevActivityTitle.current = activityForm.title
  }, [activityForm.title])

  function handleCancelForm() {
    if (editingActivityId) onCancelEditActivity()
    setShowCreateForm(false)
  }

  function handleToggleCreate() {
    if (showFormPanel) {
      handleCancelForm()
    } else {
      setShowCreateForm(true)
    }
  }

  return (
    <div className="flex min-h-[520px] flex-col">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-6 py-4 dark:border-slate-700/60">
        <div>
          <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">Activities</h3>
          <p className="text-xs text-slate-400">{activities.length} {activities.length === 1 ? 'activity' : 'activities'}</p>
        </div>
        <button
          type="button"
          onClick={handleToggleCreate}
          className={`inline-flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-semibold shadow-sm transition ${
            showFormPanel
              ? 'border-slate-200 bg-slate-100 text-slate-600 hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300'
              : `border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-700/70 dark:bg-violet-900/25 dark:text-violet-300`
          }`}
        >
          {showFormPanel ? (
            <><XIcon /> Close</>
          ) : (
            <>
              <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" /></svg>
              New Activity
            </>
          )}
        </button>
      </div>

      {/* Collapsible activity form */}
      <div className={`overflow-hidden border-b border-slate-100 transition-all duration-300 ease-in-out dark:border-slate-700/60 ${showFormPanel ? 'max-h-[900px] opacity-100' : 'max-h-0 opacity-0'}`}>
        <div className="bg-violet-50/40 px-6 py-5 dark:bg-violet-900/10">
          <p className="mb-4 text-xs font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500">
            {editingActivityId ? 'Edit Activity' : 'New Activity'}
          </p>
          <form onSubmit={editingActivityId ? onEditActivity : onCreateActivity}>
            {/* Row 1: Upload PDF | Activity Title | Total Score | Type */}
            <div className={`grid gap-3 ${scan?.onExamPdfUpload && isCreateMode ? 'grid-cols-1 sm:grid-cols-[1fr_minmax(0,1.5fr)_minmax(72px,0.7fr)_minmax(148px,1fr)]' : 'grid-cols-1 sm:grid-cols-[minmax(0,1.5fr)_minmax(72px,0.7fr)_minmax(148px,1fr)]'}`}>
              {scan?.onExamPdfUpload && isCreateMode && (
                <Field label="Upload PDF" hint="optional">
                  <div className="relative">
                    <input
                      ref={activityPdfInputRef}
                      type="file"
                      accept="application/pdf,.pdf"
                      onChange={onActivityExamPdfUpload}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 pr-8 text-sm shadow-sm outline-none file:mr-2 file:rounded-lg file:border-0 file:bg-brand-50 file:px-2 file:py-1 file:text-xs file:font-semibold file:text-brand-700"
                    />
                    {activityAttachmentName && (
                      <button
                        type="button"
                        title="Remove file"
                        aria-label="Remove file"
                        onClick={() => {
                          onRemoveActivityExamPdf()
                          if (activityPdfInputRef.current) activityPdfInputRef.current.value = ''
                        }}
                        className="absolute right-2 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:border-rose-200 hover:text-rose-600"
                      >
                        <XIcon />
                      </button>
                    )}
                  </div>
                </Field>
              )}
              <Field label="Activity Title" hint={shouldAutoTitle ? 'auto from file' : undefined}>
                <TextInput
                  required
                  value={activityForm.title}
                  onChange={(e) => setActivityForm((p) => ({ ...p, title: e.target.value }))}
                  placeholder="e.g. Midterm Examination"
                  readOnly={shouldAutoTitle}
                />
              </Field>
              <Field label="Total Score" hint={totalScoreReadOnly ? 'from PDF' : undefined}>
                <TextInput
                  type="number"
                  min={1}
                  max={999}
                  required={!totalScoreReadOnly}
                  value={totalScoreValue}
                  readOnly={totalScoreReadOnly}
                  onChange={totalScoreReadOnly ? undefined : (e) =>
                    setActivityForm((p) => ({ ...p, max_score: e.target.value }))
                  }
                  placeholder="100"
                  className={totalScoreReadOnly ? 'bg-slate-50 text-slate-400 cursor-default dark:bg-slate-800 dark:text-slate-500' : undefined}
                />
              </Field>
              <Field label="Type">
                <SelectInput value={activityForm.activity_type}
                  onChange={(e) => setActivityForm((p) => ({ ...p, activity_type: e.target.value }))}>
                  <option value="exam">Exam</option>
                  <option value="quiz">Written Work</option>
                  <option value="activity">Performance Task</option>
                </SelectInput>
              </Field>
            </div>

            {/* PDF details (Total Items + Answer Key) — expands below row 1 when file attached */}
            {scan?.onExamPdfUpload && isCreateMode && hasAttachment && (
              <div className="mt-2 rounded-xl border border-brand-200 bg-brand-50/40 p-3">
                <button
                  type="button"
                  onClick={() => setShowUploadDetails((prev) => !prev)}
                  className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-slate-800"
                >
                  <span>{showUploadDetails ? 'Hide PDF details' : 'Show PDF details'}</span>
                  <span className={`transition ${showUploadDetails ? 'rotate-180' : ''}`}>⌄</span>
                </button>
                {showUploadDetails && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Field label="Total Items">
                      <TextInput
                        type="number" min={1} max={200}
                        value={scan.examForm?.total_items || ''}
                        onChange={(e) => scan.onTotalItemsChange(e.target.value)}
                        placeholder="Leave blank when no template is needed"
                      />
                    </Field>
                    <Field label="Answer Key">
                      <TextareaInput
                        ref={scan.answerKeyRef}
                        value={scan.answerKeyDisplay || ''}
                        onChange={() => {}}
                        onKeyDown={isUploadedAnswerKeyLocked ? undefined : scan.onAnswerKeyKeyDown}
                        onPaste={isUploadedAnswerKeyLocked ? undefined : scan.onAnswerKeyPaste}
                        className="h-28 font-mono text-sm leading-6"
                        placeholder="1. A"
                        readOnly={isUploadedAnswerKeyLocked}
                      />
                      {isUploadedAnswerKeyLocked && (
                        <p className="text-[11px] text-slate-400">Imported from upload (view only).</p>
                      )}
                    </Field>
                  </div>
                )}
              </div>
            )}

            {/* Row 2: Grading Period | Exam Code | Due Date | Status */}
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Grading Period">
                <SelectInput
                  value={activityForm.grading_period}
                  onChange={(e) => setActivityForm((p) => ({ ...p, grading_period: e.target.value }))}
                  required
                >
                  <option value="">Quarter…</option>
                  {GRADING_PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
                </SelectInput>
              </Field>
              <Field label="Exam Code" hint={isCreateMode ? 'optional' : undefined}>
                <TextInput
                  value={activityForm.exam_code || ''}
                  onChange={(e) => setActivityForm((p) => ({
                    ...p,
                    exam_code: e.target.value.replace(/\D/g, '').slice(0, 6),
                  }))}
                  inputMode="numeric"
                  maxLength={6}
                  pattern="[0-9]{6}"
                  placeholder={isCreateMode ? 'Auto-gen' : '000000'}
                  required={!isCreateMode}
                  title="Exam code must be exactly 6 digits."
                />
              </Field>
              <Field label="Due Date" hint="optional">
                <TextInput
                  type="datetime-local" step={60}
                  value={activityForm.due_at}
                  onChange={(e) => setActivityForm((p) => ({ ...p, due_at: e.target.value }))}
                />
              </Field>
              <Field label="Status">
                <SelectInput value={activityForm.publish_status}
                  onChange={(e) => setActivityForm((p) => ({ ...p, publish_status: e.target.value }))}>
                  <option value="draft">Draft</option>
                  <option value="published">Published</option>
                  <option value="archived">Archived</option>
                </SelectInput>
              </Field>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <SubmitBtn
                disabled={busyAction === 'activity' || busyAction === `edit-activity-${editingActivityId}`}
                colorClass={a.btn}
              >
                {busyAction === 'activity' || busyAction === `edit-activity-${editingActivityId}`
                  ? <><SpinIcon /> Saving…</>
                  : (editingActivityId ? 'Save Activity' : 'Create Activity')}
              </SubmitBtn>
              <GhostBtn
                type="button"
                onClick={handleCancelForm}
                disabled={busyAction === 'activity' || busyAction === `edit-activity-${editingActivityId}`}
              >
                Cancel
              </GhostBtn>
            </div>
          </form>
        </div>
      </div>

      {/* Activities list */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="space-y-2.5">
          {activities.length ? activities.map((item) => (
            <div key={item.id}
              className="rounded-xl border border-slate-100 bg-slate-50 p-3 transition hover:border-slate-200 hover:bg-white hover:shadow-sm dark:border-slate-700/60 dark:bg-slate-800/40 dark:hover:bg-slate-800"
            >
              <div className="flex items-start justify-between gap-3">
                {/* Left: title + meta + exam code */}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold leading-snug text-slate-800 dark:text-slate-100">{item.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                    <span>{item.submission_count || 0} submissions</span>
                    {item.due_at && <span>Due {new Date(item.due_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>}
                    {item.max_score && <span>{item.max_score} pts</span>}
                  </div>
                  {item.exam_code && (
                    <div className="mt-1 flex items-center gap-2">
                      <span className="rounded-md border border-slate-200 bg-white px-2 py-0.5 font-mono text-[11px] font-bold tracking-widest text-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400">
                        EXAM CODE: {item.exam_code}
                      </span>
                    </div>
                  )}
                </div>
                {/* Right: badges then action buttons */}
                <div className="flex flex-shrink-0 flex-col items-end gap-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge className={ACTIVITY_TYPE_STYLES[item.activity_type] || 'bg-slate-100 text-slate-500'}>
                      {ACTIVITY_TYPE_LABELS[item.activity_type] ?? item.activity_type}
                    </Badge>
                    {item.grading_period && (
                      <Badge className="bg-slate-100 text-slate-500 ring-1 ring-slate-200 dark:bg-slate-700 dark:text-slate-300">
                        {item.grading_period}
                      </Badge>
                    )}
                    <Badge className={PUBLISH_STATUS_STYLES[item.publish_status] || 'bg-slate-100 text-slate-500'}>
                      {item.publish_status}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <GhostBtn
                      type="button"
                      onClick={() => { setShowCreateForm(false); onStartEditActivity(item) }}
                      disabled={busyAction === `edit-activity-${item.id}`}
                    >
                      <PenIcon /> Edit
                    </GhostBtn>
                    <DangerBtn type="button" onClick={() => onDeleteActivity(item.id)} disabled={busyAction === `delete-activity-${item.id}`}>
                      {busyAction === `delete-activity-${item.id}` ? <SpinIcon /> : <TrashIcon />}
                      Delete
                    </DangerBtn>
                  </div>
                </div>
              </div>
            </div>
          )) : (
            <EmptyState icon={<ClipboardIcon size="lg" />} title="No activities posted yet" description="Click '+ New Activity' above to create your first Exam, Written Work, or Performance Task." />
          )}
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════
   SCAN CENTER TAB
═══════════════════════════════════════════════════════ */
function ScanCenterTab({ scan, templates = [], students = [], manualFocusToken = '', manualContext = null }) {
  const [showManual, setShowManual] = useState(() => {
    try { return sessionStorage.getItem('scanManualOpen') === '1' } catch { return false }
  })
  const scannerConnected  = Boolean(scan.scanner?.scanner?.connected)
  const onlineScanner = scan.scanner?.transport === 'online-scanner'
  const feederReady = !onlineScanner || Boolean(scan.scanner?.scanner?.arduino)
  const scannerPaired = Boolean(scan.scanner?.scanner?.paired)
  const [scannerCode, setScannerCode] = useState('')
  const [pairingError, setPairingError] = useState('')
  const [pairingBusy, setPairingBusy] = useState(false)
  const isSampleForSubject = !scan.preview || scan.scanSession?.examId === templates[0]?.id
  const sessionStatus = isSampleForSubject ? (scan.scanSession?.status ?? null) : null
  const stagedSheets      = scan.stagedSheets ?? []
  const typedStudentCode  = String(scan.gradeForm?.student_code || '').trim()

  async function pairScanner() {
    if (scannerPaired && !window.confirm('Replace the scanner code? The current scanner connection will end.')) return
    setPairingBusy(true)
    setPairingError('')
    try {
      setScannerCode(await scan.onPairScanner())
    } catch (error) {
      setPairingError(error.message)
    } finally {
      setPairingBusy(false)
    }
  }

  const matchedStudent = useMemo(() => {
    if (!typedStudentCode) return null
    const needle = typedStudentCode.toUpperCase()
    return students.find((s) => String(s.student_code || '').trim().toUpperCase() === needle) || null
  }, [students, typedStudentCode])
  const matchedStudentName = matchedStudent
    ? formatStudentFullName(matchedStudent.given_name, matchedStudent.middle_name, matchedStudent.surname)
    : ''

  const studentOptions = useMemo(() => students.map((s) => {
    const fullName = formatStudentFullName(s.given_name, s.middle_name, s.surname)
    return {
      value: s.student_code,
      label: `${s.student_code} — ${fullName}`,
      searchText: `${s.student_code} ${fullName} ${s.surname || ''} ${s.given_name || ''}`,
    }
  }), [students])

  useEffect(() => {
    try { sessionStorage.setItem('scanManualOpen', showManual ? '1' : '0') } catch {}
  }, [showManual])

  useEffect(() => {
    if (!manualFocusToken) return
    setShowManual(true)
  }, [manualFocusToken])

  const gradeItems = Array.isArray(scan.gradeAnswerItems) ? scan.gradeAnswerItems : []
  const answerInputRefs = useRef([])

  // ── Scanning mode ────────────────────────────────────────────────────────────
  if (sessionStatus === 'scanning' || sessionStatus === 'stopping') {
    const isStopping = sessionStatus === 'stopping'
    const isSingle   = scan.scanSession?.mode === 'single'
    const okCount      = stagedSheets.filter((s) => s.status === 'ok').length
    const flaggedCount = stagedSheets.filter((s) => s.status === 'flagged').length
    const lastSheet    = stagedSheets[stagedSheets.length - 1] ?? null

    return (
      <div className="min-h-[520px] p-6 flex flex-col gap-5">
        {scan.error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rosese-700">{scan.error}</div>
        )}
        <section className="rounded-2xl border border-slate-200 bg-white p-6 flex flex-col gap-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-800 text-white animate-pulse">
              <ScanIcon />
            </span>
            <div>
              <h3 className="text-sm font-bold text-slate-800">
                {isStopping ? 'Stopping scanning...' : isSingle ? 'Single scan: insert one sheet' : 'Scanning in progress...'}
              </h3>
              <p className="text-xs text-slate-500">
                {isStopping
                  ? 'Finishing the current hardware step'
                  : isSingle
                    ? 'Feed one answer sheet into the scanner by hand (landscape, long edge first). Waiting up to 60 seconds.'
                    : `${stagedSheets.length} sheet${stagedSheets.length !== 1 ? 's' : ''} processed`}
              </p>
            </div>
          </div>

          {/* Live counts */}
          <div className="flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> OK: {okCount}
            </span>
            {flaggedCount > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" /> Flagged: {flaggedCount}
              </span>
            )}
          </div>

          {/* Last sheet preview */}
          {lastSheet && (
            <div className={`scan-last-card rounded-xl border p-3 text-sm ${lastSheet.status === 'ok' ? 'scan-last-card-ok border-emerald-200 bg-emerald-50' : 'scan-last-card-flagged border-amber-200 bg-amber-50'}`}>
              <span className="scan-last-label text-xs font-bold uppercase tracking-widest text-slate-400 mr-2">Last:</span>
              <span className="scan-last-name font-semibold text-slate-800">
                {lastSheet.student_name ?? lastSheet.student_code ?? 'Unknown'}
              </span>
              {lastSheet.score != null && (
                <span className="scan-last-score ml-2 text-slate-600">{lastSheet.score}/{lastSheet.max_score}</span>
              )}
              {lastSheet.status === 'flagged' && (
                <span className="scan-last-flag ml-2 text-amber-700">⚠ {lastSheet.flag_reasons?.[0] ?? 'flagged'}</span>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={scan.onStopBatchScan}
            disabled={scan.busy || isStopping}
            className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-rose-300 bg-white px-4 py-3 text-sm font-bold text-rose-700 transition hover:bg-rose-50 disabled:opacity-40"
          >
            {isStopping ? 'Stopping scanning...' : 'Stop Scanning'}
          </button>
        </section>
      </div>
    )
  }

  // ── Review mode ──────────────────────────────────────────────────────────────
  if (sessionStatus === 'review') {
    return (
      <div className="min-h-[520px] p-6 flex flex-col gap-5">
        {scan.error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{scan.error}</div>
        )}
        <div className="flex items-center gap-2.5 mb-1">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
            <ScanIcon />
          </span>
          <div>
            <h3 className="text-sm font-bold text-slate-800">Review &amp; Commit</h3>
            <p className="text-xs text-slate-500">Approve, fix, or discard scanned sheets before committing results.</p>
          </div>
        </div>
        <ScanReview
          sessionId={scan.scanSession?.session_id}
          sheets={stagedSheets}
          busy={scan.busy}
          onCommit={scan.onCommitSession}
          onDiscard={scan.onDiscardSession}
          onUpdateSheet={scan.onUpdateStagedSheet}
          onStartNew={scan.scanSession?.mode === 'single' ? scan.onStartSingleScan : scan.onStartBatchScan}
        />
      </div>
    )
  }

  // ── Idle mode ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-[520px] p-6 flex flex-col gap-5">
      {scan.error && (
        <div className="mb-1 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {scan.error}
        </div>
      )}

      {/* Scanner status pill */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
            <ScanIcon />
          </span>
          <h3 className="text-sm font-bold text-slate-800">Scan or Submit</h3>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
          scannerConnected
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'border-amber-200 bg-amber-50 text-amber-700'
        }`}>
          <span className={`h-2 w-2 rounded-full ${scannerConnected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
          {scan.preview ? 'Demo scanner' : scannerConnected ? 'Scanner ready' : 'Scanner not connected'}
        </span>
      </div>

      {onlineScanner && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
          <button
            type="button"
            onClick={pairScanner}
            disabled={pairingBusy || Boolean(scannerCode) || scan.busy}
            className="text-sm font-semibold text-slate-800 underline disabled:opacity-40"
          >
            {scannerPaired ? 'Replace scanner code' : 'Pair scanner PC'}
          </button>
          {pairingError && <p role="alert" className="text-xs text-rose-700">{pairingError}</p>}
          {scannerCode && (
            <div className="space-y-2">
              <label className="block text-xs text-slate-700">
                Paste this code into the scanner service on the Windows PC.
                <input
                  value={scannerCode}
                  readOnly
                  autoComplete="off"
                  spellCheck={false}
                  onFocus={(event) => event.target.select()}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1 font-mono text-sm"
                />
              </label>
              <button type="button" onClick={() => setScannerCode('')} className="text-xs font-semibold underline">
                Hide scanner code
              </button>
            </div>
          )}
        </section>
      )}

      {/* Batch scan card */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
          <p className="text-xs font-semibold text-slate-700">Batch scan workflow</p>
          <p className="mt-0.5 text-xs text-slate-500">
            {scan.preview
              ? 'Review sample sheets and see how the app flags an unmarked answer.'
              : 'Load answer sheets into the feeder, then start scanning. Each sheet is read, graded, and queued for review. The exam code and student code are read from the bubbled grid.'}
          </p>
        </div>
        <button
          type="button"
          onClick={scan.preview ? () => scan.onStartBatchScan(templates[0]) : scan.onStartBatchScan}
          disabled={scan.busy || pairingBusy || !scannerConnected || !feederReady}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {scan.busy ? <><SpinIcon /> Starting…</> : <><ScanIcon /> {scan.preview ? 'Simulate Batch Scan' : 'Start Batch Scan'}</>}
        </button>
        <button
          type="button"
          onClick={scan.preview ? () => scan.onStartSingleScan(templates[0]) : scan.onStartSingleScan}
          disabled={scan.busy || pairingBusy || !scannerConnected}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-bold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ScanIcon /> {scan.preview ? 'Simulate Single Scan' : 'Single Scan (manual feed)'}
        </button>
        {!scan.preview && (
          <p className="text-xs text-slate-500">
            Single Scan skips the feeder: insert one sheet into the scanner by hand to test the checking.
          </p>
        )}
        {!scannerConnected && (
          <p className="text-xs text-amber-700">Scanner service must be running and connected.</p>
        )}
        {scannerConnected && !feederReady && (
          <p className="text-xs text-amber-700">Connect the Arduino feeder to run a batch scan.</p>
        )}
      </section>

      {/* Manual submission toggle */}
      {!scan.preview && (
        <div>
          <button
            type="button"
            onClick={() => setShowManual((v) => !v)}
            className="inline-flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-slate-800 transition"
          >
            <span>{showManual ? '▾' : '▸'}</span>
            Manual Entry {showManual ? '(hide)' : '(show)'}
          </button>
        </div>
      )}

      {!scan.preview && showManual && (
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-5">
          <form onSubmit={scan.onGrade} className="space-y-3">
            {manualContext?.activityTitle && manualContext?.studentCode && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
                Prefilled from exam results: {manualContext.activityTitle} ({manualContext.studentCode})
              </div>
            )}

            {scan.lastResult?.score !== undefined && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
                <p className="text-[11px] font-bold uppercase tracking-widest text-emerald-600">Last Result</p>
                <p className="mt-0.5 text-sm font-bold text-slate-800">
                  {scan.lastResult.student_code} — {scan.lastResult.score}/{scan.lastResult.total_items}
                </p>
              </div>
            )}

            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Exam Template">
                <BoundedSelect
                  value={scan.gradeForm?.exam_id || ''}
                  onChange={(nextValue) => scan.setGradeForm((p) => ({ ...p, exam_id: nextValue }))}
                  placeholder="Select exam template"
                  options={templates.map((ex) => ({ value: ex.id, label: ex.title }))}
                />
              </Field>
              <Field label="Student Code">
                {students.length > 0 ? (
                  <BoundedSelect
                    value={scan.gradeForm?.student_code || ''}
                    onChange={(nextValue) => scan.setGradeForm((p) => ({ ...p, student_code: nextValue }))}
                    placeholder="Select student"
                    options={studentOptions}
                    searchable
                    searchPlaceholder="Search by code or name"
                    emptySearchText="No matching students"
                  />
                ) : (
                  <TextInput
                    required
                    value={scan.gradeForm?.student_code || ''}
                    onChange={(e) => scan.setGradeForm((p) => ({ ...p, student_code: e.target.value }))}
                    placeholder="000001"
                    maxLength={6}
                  />
                )}
                {!!typedStudentCode && (
                  <p className={`mt-1 text-xs ${matchedStudent ? 'text-emerald-700' : 'text-amber-700'}`}>
                    {matchedStudent ? `${matchedStudentName}` : 'Not found in class roster'}
                  </p>
                )}
              </Field>
            </div>

            <Field label="Answers">
              {gradeItems.length > 0 ? (
                <>
                  <div className="mb-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
                    Type A–D to fill and advance. Use arrow keys or click to navigate. Paste a numbered list to auto-fill.
                  </div>
                  <div className="grid gap-1.5 overflow-x-auto pb-1" style={MANUAL_ANSWER_GRID_STYLE}>
                    {gradeItems.map((answer, idx) => (
                      <div key={`answer-item-${idx}`} className="flex min-w-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-1.5 py-2">
                        <span className="w-6 shrink-0 text-right font-mono text-xs font-semibold text-slate-500">{idx + 1}.</span>
                        <input
                          required
                          aria-label={`Answer ${idx + 1}`}
                          ref={(el) => { answerInputRefs.current[idx] = el }}
                          value={answer || ''}
                          onChange={(e) => {
                            const nextValue = String(e.target.value || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 1)
                            scan.onSetGradeAnswerItem?.(idx, nextValue)
                            if (/^[A-Z]$/.test(nextValue) && idx + 1 < gradeItems.length) {
                              requestAnimationFrame(() => {
                                const next = answerInputRefs.current[idx + 1]
                                if (next) { next.focus(); next.select() }
                              })
                            }
                          }}
                          className="w-full min-w-0 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs font-mono text-slate-700 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
                          placeholder="A"
                        />
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-xs text-slate-400">Select an exam template to load answer items.</p>
              )}
            </Field>

            <SubmitBtn disabled={scan.busy || !scan.gradeForm?.exam_id} colorClass="bg-emerald-600 hover:bg-emerald-700">
              {scan.busy ? <><SpinIcon /> Grading…</> : 'Grade Submission'}
            </SubmitBtn>
          </form>
        </section>
      )}
    </div>
  )
}

const DIFFICULTY_STYLES = {
  'Very Difficult': 'bg-rose-50 text-rose-700 ring-1 ring-rose-200 dark:bg-rose-900/25 dark:text-rose-300 dark:ring-rose-700/70',
  'Difficult':      'bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-900/25 dark:text-amber-300 dark:ring-amber-700/70',
  'Average':        'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-900/25 dark:text-emerald-300 dark:ring-emerald-700/70',
  'Easy':           'bg-sky-50 text-sky-700 ring-1 ring-sky-200 dark:bg-sky-900/25 dark:text-sky-300 dark:ring-sky-700/70',
  'Very Easy':      'bg-violet-50 text-violet-700 ring-1 ring-violet-200 dark:bg-violet-900/25 dark:text-violet-300 dark:ring-violet-700/70',
}
const DISCRIMINATION_STYLES = {
  'Very Good': 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-900/25 dark:text-emerald-300 dark:ring-emerald-700/70',
  'Good':      'bg-sky-50 text-sky-700 ring-1 ring-sky-200 dark:bg-sky-900/25 dark:text-sky-300 dark:ring-sky-700/70',
  'Fair':      'bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-900/25 dark:text-amber-300 dark:ring-amber-700/70',
  'Poor':      'bg-rose-50 text-rose-700 ring-1 ring-rose-200 dark:bg-rose-900/25 dark:text-rose-300 dark:ring-rose-700/70',
  'Negative':  'bg-rose-100 text-rose-800 ring-1 ring-rose-300 dark:bg-rose-900/40 dark:text-rose-200 dark:ring-rose-600',
}
const DECISION_STYLES = {
  Retain: 'bg-emerald-600 text-white',
  Revise: 'bg-amber-500 text-white',
  Reject: 'bg-rose-600 text-white',
}
const NEUTRAL_CHIP = 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'

function ExamResultsTab({ exams = [], selectedSubject = null, canScan = false, onScanStudent = () => {} }) {
  const [examId, setExamId]           = useState('')
  const [view, setView]               = useState('results')
  const [searchQuery, setSearchQuery] = useState('')
  const [sortKey, setSortKey]         = useState('name')
  const [showMissing, setShowMissing] = useState(true)

  const exam = useMemo(
    () => exams.find((e) => String(e.activity_id) === String(examId)) || exams[0] || null,
    [exams, examId]
  )
  const total    = Number(exam?.total_items || 0)
  const stats    = useMemo(() => describeScores(exam), [exam])
  const analysis = useMemo(() => computeItemAnalysis(exam), [exam])
  const decisionCounts = useMemo(() => analysis.items.reduce((acc, it) => {
    acc[it.decision] = (acc[it.decision] || 0) + 1
    return acc
  }, {}), [analysis])

  const rows = useMemo(() => {
    const q = searchQuery.toLowerCase()
    let list = (exam?.results || []).filter((r) => {
      if (!showMissing && !hasScore(r)) return false
      if (!q) return true
      const name = formatStudentFullName(r.given_name, r.middle_name, r.surname).toLowerCase()
      return name.includes(q) || String(r.student_code || '').toLowerCase().includes(q)
    })
    const scoreOf = (r) => (hasScore(r) ? Number(r.score) : -1)
    if (sortKey === 'score_desc') list = [...list].sort((a, b) => scoreOf(b) - scoreOf(a))
    else if (sortKey === 'score_asc') list = [...list].sort((a, b) => scoreOf(a) - scoreOf(b))
    return list
  }, [exam, searchQuery, sortKey, showMissing])

  if (!exams.length) {
    return (
      <div className="min-h-[520px] p-4">
        <EmptyState
          icon={<GradebookIcon size="lg" />}
          title="No exams yet"
          description="Create an Exam activity linked to an answer key, then scan answer sheets to see results here."
        />
      </div>
    )
  }

  const controlClass = 'h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-600 shadow-sm outline-none focus:border-brand-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
  const exportClass  = 'inline-flex h-8 items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-3 text-xs font-semibold text-emerald-700 shadow-sm transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-700/70 dark:bg-slate-900 dark:text-emerald-300 dark:hover:bg-emerald-900/25'

  return (
    <div className="min-h-[520px] p-4">
      {/* ── Exam picker + view switch + export ─────────────────── */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={exam ? String(exam.activity_id) : ''}
          onChange={(e) => setExamId(e.target.value)}
          className={`${controlClass} min-w-[200px] max-w-full font-semibold text-slate-700`}
          aria-label="Exam"
        >
          {exams.map((e) => (
            <option key={e.activity_id} value={String(e.activity_id)}>
              {e.title} ({e.total_items} items){e.publish_status !== 'published' ? ` — ${e.publish_status}` : ''}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-1 py-1 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          {[['results', 'Results'], ['items', 'Item Analysis']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setView(key)}
              className={`rounded-md px-2.5 py-0.5 text-[11px] font-semibold transition ${
                view === key
                  ? 'bg-emerald-500 text-white shadow-sm'
                  : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          type="button"
          disabled={!exam}
          onClick={() => (view === 'items' ? exportItemAnalysisWorkbook(exam, selectedSubject) : exportExamResultsWorkbook(exam, selectedSubject))}
          className={`${exportClass} ml-auto`}
          title={view === 'items' ? 'Export item analysis to Excel' : 'Export exam results to Excel'}
        >
          <DocIcon />
          {view === 'items' ? 'Export Item Analysis' : 'Export Results'}
        </button>
      </div>

      {/* ── Summary strip ──────────────────────────────────────── */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[
          ['Examinees', stats ? `${stats.count} / ${exam.results.length}` : `0 / ${exam?.results.length || 0}`],
          ['Mean', stats ? `${stats.mean} (${formatPercent(scorePercent(stats.mean, total))})` : '—'],
          ['Highest', stats ? `${stats.highest} / ${total}` : '—'],
          ['Lowest', stats ? `${stats.lowest} / ${total}` : '—'],
          ['Std. Dev.', stats ? stats.sd : '—'],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{label}</p>
            <p className="mt-0.5 text-sm font-bold text-slate-700 dark:text-slate-100">{value}</p>
          </div>
        ))}
      </div>

      {view === 'results' ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search students…"
              className="h-8 min-w-[160px] flex-1 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-700 placeholder-slate-400 shadow-sm outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            />
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} className={controlClass}>
              <option value="name">Sort: Name A–Z</option>
              <option value="score_desc">Sort: Score ↓</option>
              <option value="score_asc">Sort: Score ↑</option>
            </select>
            <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">
              <input type="checkbox" checked={showMissing} onChange={(e) => setShowMissing(e.target.checked)} />
              Show students without results
            </label>
          </div>

          <div className="max-h-[520px] overflow-auto rounded-2xl border border-slate-200 bg-white/80 dark:border-slate-700/80 dark:bg-slate-900/40">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 z-10 bg-white/95 backdrop-blur dark:bg-slate-950/90">
                <tr className="border-b border-slate-100 text-[11px] font-bold uppercase tracking-widest text-slate-400 dark:border-slate-700/80">
                  <th className="px-3 py-2 text-left">#</th>
                  <th className="px-3 py-2 text-left">Student</th>
                  <th className="px-3 py-2 text-center">Score</th>
                  <th className="px-3 py-2 text-center">Percent</th>
                  <th className="px-3 py-2 text-left">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={5} className="py-8 text-center text-sm text-slate-400">No students match.</td></tr>
                ) : rows.map((r, i) => {
                  const pct = hasScore(r) ? scorePercent(r.score, total) : null
                  return (
                    <tr key={r.student_id} className="border-b border-slate-100 hover:bg-slate-50/60 dark:border-slate-800 dark:hover:bg-slate-800/30">
                      <td className="px-3 py-2 text-xs text-slate-400">{i + 1}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-bold text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                            {initials(`${r.given_name || ''} ${r.surname || ''}`.trim())}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold text-slate-800 dark:text-slate-100">
                              {formatStudentFullName(r.given_name, r.middle_name, r.surname)}
                            </p>
                            <p className="font-mono text-[10px] text-slate-400">{r.student_code}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center">
                        {hasScore(r) ? (
                          <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{r.score}<span className="font-normal text-slate-400">/{total}</span></span>
                        ) : canScan ? (
                          <button
                            type="button"
                            onClick={() => onScanStudent(r, exam)}
                            className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-900/20"
                          >
                            Not taken · Enter
                          </button>
                        ) : (
                          <span className="text-[10px] font-semibold text-slate-400">Not taken</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-bold ${averageBadgeBg(pct)}`}>
                          {formatPercent(pct)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{formatSubmittedAt(r.submitted_at) || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : analysis.n === 0 ? (
        <EmptyState
          icon={<GradebookIcon size="lg" />}
          title="No scanned answers yet"
          description="Item analysis appears once at least one answer sheet for this exam has been scanned."
        />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] font-semibold">
            {['Retain', 'Revise', 'Reject'].map((d) => (
              <span key={d} className={`rounded-full px-2.5 py-0.5 ${DECISION_STYLES[d]}`}>{d}: {decisionCounts[d] || 0}</span>
            ))}
            <span className="text-slate-400">
              {analysis.n} examinees · upper/lower groups of {analysis.groupSize} (27%)
            </span>
          </div>
          {analysis.n < 10 && (
            <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:border-amber-700/70 dark:bg-amber-900/25 dark:text-amber-300">
              Only {analysis.n} examinee{analysis.n === 1 ? '' : 's'} so far. Item statistics are unreliable with this few results.
            </p>
          )}

          <div className="max-h-[520px] overflow-auto rounded-2xl border border-slate-200 bg-white/80 dark:border-slate-700/80 dark:bg-slate-900/40">
            <table className="min-w-full text-xs">
              <thead className="sticky top-0 z-10 bg-white/95 backdrop-blur dark:bg-slate-950/90">
                <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:border-slate-700/80">
                  <th className="px-2 py-2 text-center">Item</th>
                  <th className="px-2 py-2 text-center">Key</th>
                  <th className="px-2 py-2 text-center">Correct</th>
                  <th className="px-2 py-2 text-center">Difficulty (p)</th>
                  <th className="px-2 py-2 text-center">Discrimination (D)</th>
                  <th className="px-2 py-2 text-center">Decision</th>
                  {analysis.options.map((o) => <th key={o} className="border-l border-slate-100 px-2 py-2 text-center dark:border-slate-800">{o}</th>)}
                  <th className="px-2 py-2 text-center">Blank</th>
                </tr>
              </thead>
              <tbody>
                {analysis.items.map((it) => (
                  <tr key={it.item} className="border-b border-slate-100 hover:bg-slate-50/60 dark:border-slate-800 dark:hover:bg-slate-800/30">
                    <td className="px-2 py-1.5 text-center font-semibold text-slate-600 dark:text-slate-300">{it.item}</td>
                    <td className="px-2 py-1.5 text-center font-mono font-bold text-emerald-700 dark:text-emerald-300">{it.key || '—'}</td>
                    <td className="px-2 py-1.5 text-center text-slate-600 dark:text-slate-300">{it.correct}/{analysis.n}</td>
                    <td className="px-2 py-1.5 text-center">
                      <span className="mr-1 font-mono text-slate-600 dark:text-slate-300">{it.p?.toFixed(2) ?? '—'}</span>
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${DIFFICULTY_STYLES[it.difficulty] || NEUTRAL_CHIP}`}>{it.difficulty}</span>
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <span className="mr-1 font-mono text-slate-600 dark:text-slate-300">{it.d?.toFixed(2) ?? '—'}</span>
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${DISCRIMINATION_STYLES[it.discrimination] || NEUTRAL_CHIP}`}>{it.discrimination}</span>
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-[10px] font-bold ${DECISION_STYLES[it.decision] || NEUTRAL_CHIP}`}>{it.decision}</span>
                    </td>
                    {analysis.options.map((o) => (
                      <td
                        key={o}
                        className={`border-l border-slate-100 px-2 py-1.5 text-center dark:border-slate-800 ${
                          o === it.key ? 'bg-emerald-50 font-bold text-emerald-700 dark:bg-emerald-900/25 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {it.counts[o] || 0}
                      </td>
                    ))}
                    <td className="px-2 py-1.5 text-center text-slate-400">{it.blank}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-slate-400 dark:text-slate-500">
            p = share of examinees who answered correctly. D = upper-group minus lower-group correct, divided by group size.
            Retain: p between 0.21–0.80 and D ≥ 0.20. Revise: only one holds. Reject: neither holds, or D is negative.
            Green cells mark the keyed answer; other columns show how many picked each distractor.
          </p>
        </>
      )}
    </div>
  )
}
/* ═══════════════════════════════════════════════════════
   SUBJECT CARDS HOMEPAGE
═══════════════════════════════════════════════════════ */
function SubjectHomepage({ subjects, onSelect, showSubjectForm, setShowSubjectForm, subjectForm, setSubjectForm, busyAction, onCreateSubject }) {
  const totalStudents   = subjects.reduce((n, s) => n + Number(s.student_count || 0), 0)
  const totalActivities = subjects.reduce((n, s) => n + Number(s.activity_count || 0), 0)
  const totalPublished  = subjects.reduce((n, s) => n + Number(s.published_activity_count || 0), 0)

  return (
    <div className="mt-6 space-y-5">

      {/* ── Aggregate stat strip ─────────────────────── */}
      {subjects.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Subjects',    value: subjects.length,   icon: <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" /></svg>,          accent: 'text-brand-600',  bg: 'bg-brand-50'   },
            { label: 'Students',    value: totalStudents,     icon: <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" /></svg>, accent: 'text-sky-600',   bg: 'bg-sky-50'    },
            { label: 'Activities',  value: totalActivities,   icon: <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" /></svg>, accent: 'text-violet-600', bg: 'bg-violet-50' },
            { label: 'Published',   value: totalPublished,    icon: <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,                       accent: 'text-emerald-600', bg: 'bg-emerald-50' },
          ].map(({ label, value, icon, accent, bg }) => (
            <div key={label} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
              <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${bg} ${accent}`}>{icon}</div>
              <div>
                <p className="text-2xl font-bold text-slate-800 leading-none">{value}</p>
                <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-widest text-slate-400">{label}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Subject cards grid ───────────────────────── */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h2 className="text-sm font-bold text-slate-700">Your Subjects</h2>
          {!showSubjectForm && (
            <button
              type="button"
              onClick={() => setShowSubjectForm(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
              New Subject
            </button>
          )}
        </div>

        <div className="p-5 space-y-4">

          {/* Inline create form */}
          {showSubjectForm && (
            <form onSubmit={onCreateSubject} className="grid gap-3 rounded-xl border border-brand-200 bg-brand-50/50 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Subject Code">
                <TextInput required value={subjectForm.subject_code} onChange={(e) => setSubjectForm((p) => ({ ...p, subject_code: e.target.value }))} placeholder="CS101" />
              </Field>
              <Field label="Title">
                <TextInput required value={subjectForm.title} onChange={(e) => setSubjectForm((p) => ({ ...p, title: e.target.value }))} placeholder="Introduction to Computing" />
              </Field>
              <Field label="Term" hint="optional">
                <TextInput value={subjectForm.term_label} onChange={(e) => setSubjectForm((p) => ({ ...p, term_label: e.target.value }))} placeholder="AY 2024–2025 S1" />
              </Field>
              <div className="flex items-end gap-2">
                <SubmitBtn disabled={busyAction === 'subject'} colorClass="bg-brand-600 hover:bg-brand-700" className="flex-1">
                  {busyAction === 'subject' ? <><SpinIcon /> Saving…</> : 'Create'}
                </SubmitBtn>
                <GhostBtn type="button" onClick={() => setShowSubjectForm(false)}><XIcon /></GhostBtn>
              </div>
            </form>
          )}

          {/* Cards */}
          {subjects.length > 0 ? (
            <div className="grid max-h-[calc(190px*2+1rem)] gap-4 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-4">
              {subjects.map((s) => {
                const published = Number(s.published_activity_count || 0)
                const total     = Number(s.activity_count || 0)
                const pct       = total > 0 ? Math.round((published / total) * 100) : 0
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onSelect(String(s.id))}
                    className="group flex min-h-[190px] flex-col rounded-xl border border-slate-200 bg-slate-50 p-5 text-left transition hover:border-brand-300 hover:bg-white hover:shadow-md"
                  >
                    {/* Code + term */}
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-widest text-brand-500">{s.subject_code}</span>
                      {s.term_label && (
                        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-500 group-hover:bg-brand-100 group-hover:text-brand-600 transition">
                          {s.term_label}
                        </span>
                      )}
                    </div>

                    {/* Title */}
                    <p className="mt-2 text-sm font-semibold leading-snug text-slate-800">{s.title}</p>

                    {/* Stats row */}
                    <div className="mt-3 flex items-center gap-3 text-[11px] text-slate-400">
                      <span className="flex items-center gap-1">
                        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" /></svg>
                        {s.student_count}
                      </span>
                      <span className="flex items-center gap-1">
                        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" /></svg>
                        {total}
                      </span>
                    </div>

                    {/* Progress bar — published vs total activities */}
                    {total > 0 && (
                      <div className="mt-3">
                        <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                          <span>{published} published</span>
                          <span>{pct}%</span>
                        </div>
                        <div className="h-1 rounded-full bg-slate-200">
                          <div
                            className="h-1 rounded-full bg-emerald-400 transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Open cue */}
                    <div className="mt-3 flex items-center gap-1 text-[11px] font-semibold text-brand-500 opacity-0 group-hover:opacity-100 transition">
                      Open subject
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" /></svg>
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 py-14 text-center">
              <p className="text-sm font-semibold text-slate-500">No subjects yet</p>
              <p className="mt-1 text-xs text-slate-400">Click <span className="font-semibold">New Subject</span> above to create your first class.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
/* ═══════════════════════════════════════════════════════
   MAIN DASHBOARD
═══════════════════════════════════════════════════════ */
export default function LmsDashboard({ scanCenter = null, educator = null }) {
  const scan          = scanCenter || {}
  const hasScanCenter = Boolean(scan.onCreateExam && scan.onScan && scan.onGrade)
  const educatorId = Number(educator?.id || 0)

  function withEducator(path) {
    if (!educatorId) return path
    const joiner = path.includes('?') ? '&' : '?'
    return `${path}${joiner}educator_id=${encodeURIComponent(String(educatorId))}`
  }

  const [subjects, setSubjects]                   = useState([])
  const [selectedSubjectId, setSelectedSubjectId] = useState('')
  const [students, setStudents]                   = useState([])
  const [activities, setActivities]               = useState([])
  const [examResults, setExamResults]             = useState([])
  const [loading, setLoading]                     = useState(false)
  const [error, setError]                         = useState('')
  const [busyAction, setBusyAction]               = useState('')
  const [toasts, setToasts]                       = useState([])
  const [confirmDialog, setConfirmDialog]         = useState(null) // { title, message, confirmLabel, onConfirm }
  const toastIdRef                                = useRef(0)
  const [subjectsPanelOpen, setSubjectsPanelOpen] = useState(false)
  const [showSubjectForm, setShowSubjectForm]     = useState(false)
  const [subjectSort, setSubjectSort]             = useState('date_desc')
  const [subjectSortMenuOpen, setSubjectSortMenuOpen] = useState(false)
  const [subjectForm, setSubjectForm]             = useState(emptySubjectForm)
  const [subjectTileEditing, setSubjectTileEditing] = useState(false)
  const [editSubjectForm, setEditSubjectForm]     = useState(emptySubjectForm)
  const [studentForm, setStudentForm]             = useState(emptyStudentForm)
  const [editingStudentId, setEditingStudentId]   = useState('')
  const [editStudentForm, setEditStudentForm]     = useState(emptyStudentForm)
  const [activityForm, setActivityForm]           = useState(emptyActivityForm)
  const [activityAttachmentName, setActivityAttachmentName] = useState('')
  const [editingActivityId, setEditingActivityId] = useState('')
  const [activeTab, setActiveTab]                 = useState('roster')
  const [scanManualFocusToken, setScanManualFocusToken] = useState('')
  const [scanManualContext, setScanManualContext] = useState(null)
  const subjectSortMenuRef                         = useRef(null)

  const selectedSubject     = useMemo(() => subjects.find((s) => String(s.id) === String(selectedSubjectId)), [subjects, selectedSubjectId])
  const subjectSortOptions  = useMemo(() => ([
    { value: 'date_desc', label: 'Date added (Newest first)' },
    { value: 'date_asc',  label: 'Date added (Oldest first)' },
    { value: 'alpha_asc', label: 'Alphabetical (A-Z)' },
    { value: 'alpha_desc', label: 'Alphabetical (Z-A)' },
  ]), [])
  const subjectSortLabel = useMemo(
    () => subjectSortOptions.find((opt) => opt.value === subjectSort)?.label || 'Date added (Newest first)',
    [subjectSort, subjectSortOptions]
  )
  const sortedSubjects = useMemo(() => {
    const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
    const normalized = subjects.map((s) => {
      const rawTs = Date.parse(String(s.created_at || ''))
      return {
        subject: s,
        createdTs: Number.isFinite(rawTs) ? rawTs : null,
        alphaKey: String(s.title || s.subject_code || '').trim(),
      }
    })

    normalized.sort((a, b) => {
      if (subjectSort === 'date_asc' || subjectSort === 'date_desc') {
        const dir = subjectSort === 'date_asc' ? 1 : -1
        if (a.createdTs !== null && b.createdTs !== null && a.createdTs !== b.createdTs) {
          return (a.createdTs - b.createdTs) * dir
        }
      } else {
        const dir = subjectSort === 'alpha_desc' ? -1 : 1
        const alphaDiff = collator.compare(a.alphaKey, b.alphaKey)
        if (alphaDiff !== 0) return alphaDiff * dir
      }

      const fallbackDateA = a.createdTs ?? 0
      const fallbackDateB = b.createdTs ?? 0
      if (fallbackDateA !== fallbackDateB) return fallbackDateB - fallbackDateA
      return collator.compare(String(a.subject.subject_code || ''), String(b.subject.subject_code || ''))
    })

    return normalized.map((entry) => entry.subject)
  }, [subjectSort, subjects])
  const publishedActivities = useMemo(() => activities.filter((a) => a.publish_status === 'published'), [activities])
  const scanTemplates = useMemo(() => {
    const allTemplates = scan.exams || []
    if (!allTemplates.length) return []
    const linkedIds = new Set(
      activities
        .map((activity) => activity.exam_id)
        .filter(Boolean)
        .map((id) => String(id))
    )
    const linkedTemplates = allTemplates.filter((exam) => linkedIds.has(String(exam.id)))
    return linkedTemplates.length ? linkedTemplates : allTemplates
  }, [activities, scan.exams])
  // Build tab list dynamically
  const tabs = useMemo(() => {
    const base = ['roster', 'activities']
    if (hasScanCenter) base.push('scan')
    base.push('results')
    return base
  }, [hasScanCenter])

  const tabCounts = useMemo(() => ({
    roster:        students.length,
    activities:    activities.length,
    scan:          scanTemplates.length,
    results:       examResults.length,
  }), [students, activities, scanTemplates.length, examResults])

  async function loadSubjects() {
    const res = await apiGet(withEducator('/lms/subjects'))
    setSubjects(res.data || [])
  }

  async function loadSubjectDetails(id) {
    if (!id) return
    const [sR, aR, erR] = await Promise.all([
      apiGet(withEducator(`/lms/subjects/${id}/students`)),
      apiGet(withEducator(`/lms/subjects/${id}/activities`)),
      apiGet(withEducator(`/lms/subjects/${id}/exam-results`)),
    ])
    setStudents(sR.data || [])
    setActivities(aR.data || [])
    setExamResults(erR.data?.exams || [])
  }

  async function refreshSubjectAndHomepage(id) {
    if (!id) return
    await Promise.all([
      loadSubjectDetails(id),
      loadSubjects(),
    ])
  }

  useEffect(() => {
    if (!educatorId) return
    setLoading(true)
    loadSubjects().catch((e) => setError(e.message)).finally(() => setLoading(false))
  }, [educatorId])

  useEffect(() => {
    if (!selectedSubjectId) return
    onCancelEditSubject()
    onCancelEditStudent()
    onCancelEditActivity()
    setLoading(true)
    setError('')
    loadSubjectDetails(selectedSubjectId).catch((e) => setError(e.message)).finally(() => setLoading(false))
  }, [selectedSubjectId])

  // Batch scan commits happen outside this component, so refetch whenever the tab opens
  useEffect(() => {
    if (activeTab !== 'results' || !selectedSubjectId) return
    apiGet(withEducator(`/lms/subjects/${selectedSubjectId}/exam-results`))
      .then((res) => setExamResults(res.data?.exams || []))
      .catch((e) => showToast(e.message))
  }, [activeTab, selectedSubjectId])

  useEffect(() => {
    const submissionId = scan?.lastResult?.submission_id
    if (!selectedSubjectId || !submissionId) return
    loadSubjectDetails(selectedSubjectId).catch((e) => setError(e.message))
  }, [selectedSubjectId, scan?.lastResult?.submission_id])

  useEffect(() => {
    if (!subjectSortMenuOpen) return
    const onDocPointerDown = (event) => {
      if (!subjectSortMenuRef.current) return
      if (!subjectSortMenuRef.current.contains(event.target)) {
        setSubjectSortMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocPointerDown)
    return () => document.removeEventListener('mousedown', onDocPointerDown)
  }, [subjectSortMenuOpen])

  useEffect(() => {
    if (!activityAttachmentName || editingActivityId) return
    const titleFromFile = filenameToTitle(activityAttachmentName)
    const totalItems = Number(scan?.examForm?.total_items || 0)
    const uploadAnswers = parseAnswerGridDisplay(scan?.answerKeyDisplay || '')
    const normalizedUploadKey = uploadAnswers.join('|')
    const matched = (scan.exams || []).find((exam) => {
      const examTotal = Number(exam?.total_items || 0)
      if (totalItems > 0 && examTotal !== totalItems) return false
      if (normalizedUploadKey) {
        return normalizeStoredAnswerKey(exam.answer_key) === normalizedUploadKey
      }
      return titleFromFile && String(exam.title || '').trim().toLowerCase() === titleFromFile.toLowerCase()
    })
    const nextExamId = matched ? String(matched.id) : ''
    setActivityForm((prev) => {
      const nextTitle = titleFromFile || prev.title
      if (prev.exam_id === nextExamId && prev.title === nextTitle) return prev
      return { ...prev, title: nextTitle, exam_id: nextExamId }
    })
  }, [activityAttachmentName, editingActivityId, scan.exams, scan.examForm?.total_items, scan.answerKeyDisplay])

  function showToast(message, type = 'error') {
    const id = ++toastIdRef.current
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 7000)
  }

  function dismissToast(id) {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  async function onCreateSubject(e) {
    e.preventDefault()
    setBusyAction('subject')
    try {
      await apiPost(withEducator('/lms/subjects'), { ...subjectForm, educator_id: educatorId })
      setSubjectForm(emptySubjectForm)
      setShowSubjectForm(false)
      await loadSubjects()
    } catch (err) { showToast(err.message) } finally { setBusyAction('') }
  }

  function onDeleteSubject() {
    if (!selectedSubject) return
    setConfirmDialog({
      title: `Delete "${selectedSubject.subject_code}"?`,
      message: 'This permanently removes the subject, all enrolled students, activities, and grades. This cannot be undone.',
      confirmLabel: 'Delete Subject',
      onConfirm: async () => {
        setConfirmDialog(null)
        setBusyAction('delete-subject')
        try {
          await apiDelete(withEducator(`/lms/subjects/${selectedSubject.id}`))
          setSelectedSubjectId('')
          setStudents([]); setActivities([]); setExamResults([])
          await loadSubjects()
        } catch (err) { showToast(err.message) } finally { setBusyAction('') }
      },
    })
  }

  function onStartEditSubject() {
    if (!selectedSubject) return
    setEditSubjectForm({
      subject_code: selectedSubject.subject_code || '',
      title: selectedSubject.title || '',
      term_label: selectedSubject.term_label || '',
      description: selectedSubject.description || '',
    })
    setSubjectTileEditing(true)
  }

  function onCancelEditSubject() {
    setSubjectTileEditing(false)
    setEditSubjectForm(emptySubjectForm)
  }

  async function onEditSubject(e) {
    if (e) e.preventDefault()
    if (!selectedSubject) return
    setBusyAction(`edit-subject-${selectedSubject.id}`)
    setError('')
    try {
      await apiPut(withEducator(`/lms/subjects/${selectedSubject.id}`), {
        subject_code: editSubjectForm.subject_code.trim(),
        title: editSubjectForm.title.trim(),
        term_label: editSubjectForm.term_label.trim(),
      })
      onCancelEditSubject()
      await loadSubjects()
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  async function onAddStudent(e) {
    e.preventDefault()
    if (!selectedSubjectId) return
    setBusyAction('student')
    try {
      await apiPost(withEducator(`/lms/subjects/${selectedSubjectId}/students`), {
        student_code: studentForm.student_code.trim(),
        surname: studentForm.surname.trim(),
        given_name: studentForm.given_name.trim(),
        middle_name: studentForm.middle_name.trim(),
        email: studentForm.email.trim(),
      })
      setStudentForm(emptyStudentForm)
      await refreshSubjectAndHomepage(selectedSubjectId)
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  function onStartEditStudent(student) {
    setEditingStudentId(String(student.id))
    setEditStudentForm({
      student_code: student.student_code || '',
      surname: student.surname || '',
      given_name: student.given_name || '',
      middle_name: student.middle_name || '',
      email: student.email || '',
    })
  }

  function onCancelEditStudent() {
    setEditingStudentId('')
    setEditStudentForm(emptyStudentForm)
  }

  function resetActivityTemplateDraft() {
    setActivityAttachmentName('')
    if (scan?.onClearExamDraft) {
      scan.onClearExamDraft()
      return
    }
    if (scan?.setExamForm) {
      scan.setExamForm({ title: '', total_items: '', answer_key: '' })
      if (scan?.onTotalItemsChange) {
        scan.onTotalItemsChange('')
      }
    }
  }

  async function onActivityExamPdfUpload(e) {
    const file = e.target.files?.[0]
    if (!file) {
      setActivityAttachmentName('')
      setActivityForm((p) => ({ ...p, exam_id: '' }))
      return
    }
    setActivityAttachmentName(file.name)
    const titleFromFile = filenameToTitle(file.name)
    if (titleFromFile) {
      setActivityForm((p) => ({ ...p, title: titleFromFile, exam_id: '' }))
    }
    if (scan?.onExamPdfUpload) {
      await scan.onExamPdfUpload(e)
    }
  }

  function onRemoveActivityExamPdf() {
    setActivityForm((p) => ({ ...p, exam_id: '' }))
    resetActivityTemplateDraft()
  }

  async function onEditStudent(e, id) {
    if (e) e.preventDefault()
    if (!selectedSubjectId) return
    setBusyAction(`edit-student-${id}`)
    try {
      await apiPut(withEducator(`/lms/subjects/${selectedSubjectId}/students/${id}`), {
        student_code: editStudentForm.student_code.trim(),
        surname: editStudentForm.surname.trim(),
        given_name: editStudentForm.given_name.trim(),
        middle_name: editStudentForm.middle_name.trim(),
        email: editStudentForm.email.trim(),
      })
      onCancelEditStudent()
      await refreshSubjectAndHomepage(selectedSubjectId)
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  function onRemoveStudent(id) {
    const student = students.find((s) => String(s.id) === String(id))
    const name = student ? formatStudentFullName(student.given_name, student.middle_name, student.surname) : 'this student'
    setConfirmDialog({
      title: `Remove "${name}"?`,
      message: 'This will unenroll the student from this subject. Their account is not deleted.',
      confirmLabel: 'Remove Student',
      onConfirm: async () => {
        setConfirmDialog(null)
        setBusyAction(`remove-student-${id}`)
        try {
          await apiDelete(withEducator(`/lms/subjects/${selectedSubjectId}/students/${id}`))
          if (String(editingStudentId) === String(id)) onCancelEditStudent()
          await refreshSubjectAndHomepage(selectedSubjectId)
        } catch (err) { setError(err.message) } finally { setBusyAction('') }
      },
    })
  }

  async function onCreateActivity(e) {
    e.preventDefault()
    if (!selectedSubjectId) return
    setBusyAction('activity')
    setError('')
    try {
      const selectedTemplate = (scan.exams || []).find((exam) => String(exam.id) === String(activityForm.exam_id))
      let examId = activityForm.exam_id ? Number(activityForm.exam_id) : null
      let totalItems = Number(selectedTemplate?.total_items || 0)

      if (!examId) {
        const draftTotalItems = Number(scan?.examForm?.total_items || 0)
        const draftAnswers = parseAnswerGridDisplay(scan?.answerKeyDisplay || '')
        if (draftTotalItems > 0 || draftAnswers.length > 0) {
          if (draftTotalItems < 1) {
            throw new Error('Total items must be at least 1 when creating a template.')
          }
          if (draftAnswers.length !== draftTotalItems) {
            throw new Error('Answer key must contain exactly one entry per item.')
          }
          if (draftAnswers.some((token) => !isValidAnswerToken(token))) {
            throw new Error('Invalid answer key format. Use A or A/B per item.')
          }

          const resolvedTitle = filenameToTitle(activityAttachmentName) || activityForm.title.trim()
          if (!resolvedTitle) {
            throw new Error('Activity title is required.')
          }
          const createdExam = await apiPost('/exams', {
            title: resolvedTitle,
            total_items: draftTotalItems,
            answer_key: draftAnswers.join('\n'),
          })
          examId = Number(createdExam?.data?.id || 0) || null
          totalItems = draftTotalItems
          if (scan?.onRefreshExams) {
            await scan.onRefreshExams()
          }
        }
      }

      const resolvedTitle = (filenameToTitle(activityAttachmentName) || activityForm.title || '').trim()
      if (!resolvedTitle) {
        throw new Error('Activity title is required.')
      }

      await apiPost(withEducator(`/lms/subjects/${selectedSubjectId}/activities`), {
        ...activityForm,
        title: resolvedTitle,
        exam_id: examId,
        exam_code: String(activityForm.exam_code || '').trim(),
        max_score: Number(totalItems || activityForm.max_score || 100),
      })
      setActivityForm(emptyActivityForm)
      resetActivityTemplateDraft()
      await refreshSubjectAndHomepage(selectedSubjectId)
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  function onStartEditActivity(activity) {
    setEditingActivityId(String(activity.id))
    setActivityForm({
      title: activity.title || '',
      activity_type: activity.activity_type || 'exam',
      exam_id: activity.exam_id ? String(activity.exam_id) : '',
      exam_code: activity.exam_code || '',
      max_score: activity.max_score || 100,
      due_at: activity.due_at ? String(activity.due_at).slice(0, 16) : '',
      grading_period: activity.grading_period || '',
      publish_status: activity.publish_status || 'draft',
    })
    resetActivityTemplateDraft()
  }

  function onCancelEditActivity() {
    setEditingActivityId('')
    setActivityForm(emptyActivityForm)
    resetActivityTemplateDraft()
  }

  async function onEditActivity(e) {
    if (e) e.preventDefault()
    if (!selectedSubjectId || !editingActivityId) return
    setBusyAction(`edit-activity-${editingActivityId}`)
    setError('')
    try {
      const selectedTemplate = (scan.exams || []).find((exam) => String(exam.id) === String(activityForm.exam_id))
      const totalItems = Number(selectedTemplate?.total_items || activityForm.max_score || 100)
      await apiPut(withEducator(`/lms/subjects/${selectedSubjectId}/activities/${editingActivityId}`), {
        ...activityForm,
        exam_id: activityForm.exam_id ? Number(activityForm.exam_id) : null,
        exam_code: String(activityForm.exam_code || '').trim(),
        max_score: totalItems,
      })
      onCancelEditActivity()
      await refreshSubjectAndHomepage(selectedSubjectId)
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  function onDeleteActivity(id) {
    if (!selectedSubjectId) return
    const activity = activities.find((a) => String(a.id) === String(id))
    setConfirmDialog({
      title: `Delete "${activity?.title || 'this activity'}"?`,
      message: 'This permanently removes the activity and all student submissions for it.',
      confirmLabel: 'Delete Activity',
      onConfirm: async () => {
        setConfirmDialog(null)
        setBusyAction(`delete-activity-${id}`)
        try {
          await apiDelete(withEducator(`/lms/subjects/${selectedSubjectId}/activities/${id}`))
          if (String(editingActivityId) === String(id)) {
            onCancelEditActivity()
          }
          await refreshSubjectAndHomepage(selectedSubjectId)
        } catch (err) { showToast(err.message) } finally { setBusyAction('') }
      },
    })
  }

  function onOpenPendingActivity(row, activity) {
    if (!hasScanCenter) return

    const linkedExamId = activity?.exam_id ? String(activity.exam_id) : ''
    const fallbackExam = (scan.exams || []).find(
      (exam) => String(exam?.title || '').trim().toLowerCase() === String(activity?.title || '').trim().toLowerCase()
    )
    const resolvedExamId = linkedExamId || (fallbackExam ? String(fallbackExam.id) : '')
    const studentCode = String(row?.student_code || '').trim()

    if (scan?.setGradeForm) {
      scan.setGradeForm((prev) => ({
        ...prev,
        exam_id: resolvedExamId || prev.exam_id || '',
        student_code: studentCode,
      }))
    }
    if (scan?.setScanRequest && resolvedExamId) {
      scan.setScanRequest({ exam_id: resolvedExamId })
    }

    setScanManualContext({
      activityTitle: String(activity?.title || ''),
      studentCode,
    })
    setScanManualFocusToken(`${Date.now()}-${row?.student_id || ''}-${activity?.activity_id || ''}`)
    setActiveTab('scan')
  }

  /* ── render ─────────────────────────────────────────── */
  return (
    <main className="mx-auto max-w-7xl px-4 pt-3 pb-6 sm:px-6 lg:px-8">

      {/* HEADER */}

      {/* ERROR */}
      {error && (
        <div role="alert" className="mt-4 flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <svg className="mt-0.5 h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          {error}
        </div>
      )}

      {/* SUBJECT BAR */}
      {(selectedSubject || loading) && (
        <section className="mt-5 flex flex-wrap items-center gap-3">
          {selectedSubject && (
            <button
              type="button"
              onClick={() => {
                setSelectedSubjectId('')
                setSubjectsPanelOpen(false)
                setActiveTab('roster')
                onCancelEditStudent()
              }}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 hover:shadow"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="19" y1="12" x2="5" y2="12" />
                <polyline points="12 19 5 12 12 5" />
              </svg>
              Back to Subjects
            </button>
          )}

          {selectedSubject && (
            subjectTileEditing ? (
              <form onSubmit={onEditSubject} className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2">
                <input
                  value={editSubjectForm.subject_code}
                  onChange={(e) => setEditSubjectForm((p) => ({ ...p, subject_code: e.target.value }))}
                  placeholder="Subject Code"
                  className="w-28 rounded-lg border border-brand-200 bg-white px-2.5 py-1.5 text-xs font-bold uppercase tracking-wide text-brand-700 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  required
                />
                <input
                  value={editSubjectForm.title}
                  onChange={(e) => setEditSubjectForm((p) => ({ ...p, title: e.target.value }))}
                  placeholder="Subject Title"
                  className="min-w-[220px] flex-1 rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-sm font-semibold text-brand-800 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  required
                />
                <input
                  value={editSubjectForm.term_label}
                  onChange={(e) => setEditSubjectForm((p) => ({ ...p, term_label: e.target.value }))}
                  placeholder="Section"
                  className="w-28 rounded-lg border border-brand-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-brand-700 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                />
                <button
                  type="submit"
                  disabled={busyAction === `edit-subject-${selectedSubject.id}`}
                  className="inline-flex items-center rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
                >
                  {busyAction === `edit-subject-${selectedSubject.id}` ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={onCancelEditSubject}
                  disabled={busyAction === `edit-subject-${selectedSubject.id}`}
                  className="inline-flex items-center rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-xs font-semibold text-brand-700 transition hover:bg-brand-100 disabled:opacity-50"
                >
                  Cancel
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={onStartEditSubject}
                onDoubleClick={onStartEditSubject}
                className="group flex items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5 text-left transition hover:bg-brand-100"
                title="Click to edit subject details"
                aria-label={`Edit subject: ${selectedSubject.subject_code}`}
              >
                <span className="text-xs font-bold uppercase tracking-widest text-brand-500">{selectedSubject.subject_code}</span>
                <span className="h-3.5 w-px bg-brand-200" />
                <span className="text-sm font-semibold text-brand-800">{selectedSubject.title}</span>
                {selectedSubject.term_label && (
                  <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold text-brand-600">{selectedSubject.term_label}</span>
                )}
                <svg className="h-3.5 w-3.5 flex-shrink-0 text-brand-400 opacity-0 transition group-hover:opacity-100" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4z"/></svg>
              </button>
            )
          )}

          {loading && (
            <span className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
              <SpinIcon /> Loading…
            </span>
          )}
        </section>
      )}

      {/* SUBJECTS PANEL */}
      {subjectsPanelOpen && (
        <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-panel">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <h2 className="text-sm font-bold text-slate-700">Your Subjects</h2>
            <button type="button" onClick={() => setSubjectsPanelOpen(false)}
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">
              <XIcon />
            </button>
          </div>
          <div className="p-5">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {subjects.map((s) => {
                const active = String(s.id) === String(selectedSubjectId)
                return (
                  <button key={s.id} type="button"
                    onClick={() => { setSelectedSubjectId(String(s.id)); setSubjectsPanelOpen(false) }}
                    className={`rounded-xl border p-3.5 text-left transition ${active ? 'border-brand-300 bg-brand-50 ring-2 ring-brand-100' : 'border-slate-200 hover:border-brand-200 hover:bg-slate-50'}`}
                  >
                    <p className="text-[11px] font-bold uppercase tracking-widest text-brand-500">{s.subject_code}</p>
                    <p className="mt-1 text-sm font-semibold text-slate-800 leading-tight">{s.title}</p>
                    <p className="mt-1.5 text-[11px] text-slate-400">{s.student_count} students · {s.activity_count} activities</p>
                  </button>
                )
              })}
              {!subjects.length && (
                <div className="col-span-full rounded-xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">No subjects yet.</div>
              )}
            </div>
            <div className="mt-4 border-t border-slate-100 pt-4">
              {showSubjectForm ? (
                <form onSubmit={onCreateSubject} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Subject Code">
                    <TextInput required value={subjectForm.subject_code} onChange={(e) => setSubjectForm((p) => ({ ...p, subject_code: e.target.value }))} placeholder="CS101" />
                  </Field>
                  <Field label="Title">
                    <TextInput required value={subjectForm.title} onChange={(e) => setSubjectForm((p) => ({ ...p, title: e.target.value }))} placeholder="Introduction to Computing" />
                  </Field>
                  <Field label="Term" hint="optional">
                    <TextInput value={subjectForm.term_label} onChange={(e) => setSubjectForm((p) => ({ ...p, term_label: e.target.value }))} placeholder="AY 2024–2025 S1" />
                  </Field>
                  <div className="flex items-end gap-2">
                    <SubmitBtn disabled={busyAction === 'subject'} colorClass="bg-brand-600 hover:bg-brand-700" className="flex-1">
                      {busyAction === 'subject' ? <><SpinIcon /> Saving…</> : 'Create'}
                    </SubmitBtn>
                    <GhostBtn type="button" onClick={() => setShowSubjectForm(false)}><XIcon /></GhostBtn>
                  </div>
                </form>
              ) : (
                <GhostBtn onClick={() => setShowSubjectForm(true)}>
                  <PlusIcon /> New Subject
                </GhostBtn>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MAIN CONTENT */}
      {selectedSubject ? (
        <div className="mt-6">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-panel">

            {/* Tab bar header */}
            <div className="flex items-center border-b border-slate-100 bg-slate-50/60 px-5 py-3 overflow-x-auto">
              <TabBar
                activeTab={activeTab}
                tabs={tabs}
                counts={tabCounts}
                onChange={setActiveTab}
              />
            </div>

            {/* Tab content */}
            {activeTab === 'roster' && (
              <RosterTab
                subjectId={selectedSubjectId}
                educatorId={educatorId}
                students={students} studentForm={studentForm} setStudentForm={setStudentForm}
                busyAction={busyAction}
                editingStudentId={editingStudentId}
                editStudentForm={editStudentForm}
                setEditStudentForm={setEditStudentForm}
                onAddStudent={onAddStudent}
                onStartEditStudent={onStartEditStudent}
                onEditStudent={onEditStudent}
                onCancelEditStudent={onCancelEditStudent}
                onRemoveStudent={onRemoveStudent}
                onDeleteSubject={onDeleteSubject}
                onImportDone={() => refreshSubjectAndHomepage(selectedSubjectId)}
              />
            )}
            {activeTab === 'activities' && (
              <ActivitiesTab
                activities={activities} activityForm={activityForm} setActivityForm={setActivityForm}
                scan={scan}
                activityAttachmentName={activityAttachmentName}
                busyAction={busyAction} editingActivityId={editingActivityId}
                onActivityExamPdfUpload={onActivityExamPdfUpload}
                onRemoveActivityExamPdf={onRemoveActivityExamPdf}
                onCreateActivity={onCreateActivity}
                onStartEditActivity={onStartEditActivity}
                onCancelEditActivity={onCancelEditActivity}
                onEditActivity={onEditActivity}
                onDeleteActivity={onDeleteActivity}
              />
            )}
            {activeTab === 'scan' && hasScanCenter && (
              <ScanCenterTab
                scan={scan}
                templates={scanTemplates}
                students={students}
                manualFocusToken={scanManualFocusToken}
                manualContext={scanManualContext}
              />
            )}
            {activeTab === 'results' && (
              <ExamResultsTab
                exams={examResults}
                selectedSubject={selectedSubject}
                canScan={hasScanCenter && !scan.preview}
                onScanStudent={onOpenPendingActivity}
              />
            )}
          </div>
        </div>

      ) : (

        <div className="mt-6 space-y-5">

          {/* ── Aggregate stat strip (only when subjects exist) ── */}
          {subjects.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                {
                  label: 'Subjects',
                  value: subjects.length,
                  accent: 'text-brand-600',
                  bg: 'bg-brand-50',
                  icon: (
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                    </svg>
                  ),
                },
                {
                  label: 'Students',
                  value: subjects.reduce((n, s) => n + Number(s.student_count || 0), 0),
                  accent: 'text-sky-600',
                  bg: 'bg-sky-50',
                  icon: (
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
                    </svg>
                  ),
                },
                {
                  label: 'Activities',
                  value: subjects.reduce((n, s) => n + Number(s.activity_count || 0), 0),
                  accent: 'text-violet-600',
                  bg: 'bg-violet-50',
                  icon: (
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
                    </svg>
                  ),
                },
                {
                  label: 'Published',
                  value: subjects.reduce((n, s) => n + Number(s.published_activity_count || 0), 0),
                  accent: 'text-emerald-600',
                  bg: 'bg-emerald-50',
                  icon: (
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  ),
                },
              ].map(({ label, value, accent, bg, icon }) => (
                <div key={label} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
                  <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${bg} ${accent}`}>
                    {icon}
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-slate-800 leading-none">{value}</p>
                    <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-widest text-slate-400">{label}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Subject cards grid ── */}
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <h2 className="text-sm font-bold text-slate-700">Your Subjects</h2>
              <div className="flex items-center gap-2">
                <div ref={subjectSortMenuRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setSubjectSortMenuOpen((prev) => !prev)}
                    title={`Current: ${subjectSortLabel}`}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50"
                  >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 4.5h18M6 12h12m-9 7.5h6" />
                    </svg>
                    <span className="hidden sm:inline">Filter</span>
                    <span className="sm:hidden">Sort</span>
                  </button>
                  {subjectSortMenuOpen && (
                    <div className="absolute right-0 top-full z-20 mt-2 w-56 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
                      {subjectSortOptions.map((opt) => {
                        const selected = subjectSort === opt.value
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => {
                              setSubjectSort(opt.value)
                              setSubjectSortMenuOpen(false)
                            }}
                            className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition ${selected ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}
                          >
                            <span>{opt.label}</span>
                            {selected && <span className="text-[11px] font-semibold">Selected</span>}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>

                {!showSubjectForm && (
                  <button
                    type="button"
                    onClick={() => setShowSubjectForm(true)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50"
                  >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                    New Subject
                  </button>
                )}
              </div>
            </div>

            <div className="p-5 space-y-4">

              {/* Inline create form */}
              {showSubjectForm && (
                <form onSubmit={onCreateSubject} className="grid gap-3 rounded-xl border border-brand-200 bg-brand-50/50 p-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Subject Code">
                    <TextInput required value={subjectForm.subject_code}
                      onChange={(e) => setSubjectForm((p) => ({ ...p, subject_code: e.target.value }))}
                      placeholder="CS101" />
                  </Field>
                  <Field label="Title">
                    <TextInput required value={subjectForm.title}
                      onChange={(e) => setSubjectForm((p) => ({ ...p, title: e.target.value }))}
                      placeholder="Introduction to Computing" />
                  </Field>
                  <Field label="Term" hint="optional">
                    <TextInput value={subjectForm.term_label}
                      onChange={(e) => setSubjectForm((p) => ({ ...p, term_label: e.target.value }))}
                      placeholder="AY 2024–2025 S1" />
                  </Field>
                  <div className="flex items-end gap-2">
                    <SubmitBtn disabled={busyAction === 'subject'} colorClass="bg-brand-600 hover:bg-brand-700" className="flex-1">
                      {busyAction === 'subject' ? <><SpinIcon /> Saving…</> : 'Create'}
                    </SubmitBtn>
                    <GhostBtn type="button" onClick={() => setShowSubjectForm(false)}><XIcon /></GhostBtn>
                  </div>
                </form>
              )}

              {/* Cards */}
              {subjects.length > 0 ? (
                <div className="grid max-h-[calc(190px*2+1rem)] gap-4 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-4">
                  {sortedSubjects.map((s) => {
                    const published = Number(s.published_activity_count || 0)
                    const total     = Number(s.activity_count || 0)
                    const pct       = total > 0 ? Math.round((published / total) * 100) : 0
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSelectedSubjectId(String(s.id))}
                        className="group flex min-h-[190px] flex-col rounded-xl border border-slate-200 bg-slate-50 p-5 text-left transition hover:border-brand-300 hover:bg-white hover:shadow-md"
                      >
                        {/* Code + term badge */}
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-[11px] font-bold uppercase tracking-widest text-brand-500">
                            {s.subject_code}
                          </span>
                          {s.term_label && (
                            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-500 transition group-hover:bg-brand-100 group-hover:text-brand-600">
                              {s.term_label}
                            </span>
                          )}
                        </div>

                        {/* Title */}
                        <p className="mt-2 text-sm font-semibold leading-snug text-slate-800">
                          {s.title}
                        </p>

                        {/* Stats row */}
                        <div className="mt-3 flex items-center gap-3 text-[11px] text-slate-400">
                          <span className="flex items-center gap-1">
                            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                            </svg>
                            {s.student_count}
                          </span>
                          <span className="flex items-center gap-1">
                            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
                            </svg>
                            {total}
                          </span>
                        </div>

                        {/* Published progress bar */}
                        {total > 0 && (
                          <div className="mt-3">
                            <div className="mb-1 flex justify-between text-[10px] text-slate-400">
                              <span>{published} published</span>
                              <span>{pct}%</span>
                            </div>
                            <div className="h-1 rounded-full bg-slate-200">
                              <div
                                className="h-1 rounded-full bg-emerald-400 transition-all"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        )}

                        {/* Hover cue */}
                        <div className="mt-3 flex items-center gap-1 text-[11px] font-semibold text-brand-500 opacity-0 transition group-hover:opacity-100">
                          Open subject
                          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                          </svg>
                        </div>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-slate-200 py-14 text-center">
                  <p className="text-sm font-semibold text-slate-500">No subjects yet</p>
                  <p className="mt-1 text-xs text-slate-400">
                    Click <span className="font-semibold">New Subject</span> above to create your first class.
                  </p>
                </div>
              )}

            </div>
          </div>

        </div>
      )}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      {confirmDialog && (
        <ConfirmModal
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </main>
  )
}

/* ═══════════════════════════════════════════════════════
   ICONS
═══════════════════════════════════════════════════════ */
const SZ = { sm: 'h-3.5 w-3.5', md: 'h-5 w-5', lg: 'h-6 w-6' }
function UsersIcon({ size = 'sm' })     { return <svg className={SZ[size]} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg> }
function ClipboardIcon({ size = 'sm' }) { return <svg className={SZ[size]} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg> }
function ScanIcon({ size = 'sm' })      { return <svg className={SZ[size] || SZ.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/></svg> }
function GradebookIcon({ size = 'sm' }) { return <svg className={SZ[size] || SZ.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> }
function SubjectIcon({ size = 'sm' })   { return <svg className={SZ[size]} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg> }
function DocIcon({ size = 'sm' })       { return <svg className={SZ[size]} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> }
function PenIcon({ size = 'sm' })       { return <svg className={SZ[size]} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4z"/></svg> }
function PlusIcon()                     { return <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> }
function XIcon({ size = 'sm' })         { return <svg className={SZ[size]} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> }
function TrashIcon()                    { return <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg> }
function SpinIcon()                     { return <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0" strokeLinecap="round"/></svg> }
