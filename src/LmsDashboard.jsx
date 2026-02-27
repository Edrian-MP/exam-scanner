import { useEffect, useMemo, useRef, useState } from 'react'
import { apiDelete, apiGet, apiPost, apiPut } from './lib/api'
import * as XLSX from 'xlsx'

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
const emptyActivityForm     = { title: '', activity_type: 'exam', exam_id: '', max_score: 100, due_at: '', publish_status: 'draft' }
const emptyAnnouncementForm = { title: '', body: '' }

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

function initials(name = '') {
  return name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase() || '?'
}

function formatStudentFullName(givenName = '', middleName = '', surname = '') {
  const given = String(givenName || '').trim()
  const middle = String(middleName || '').trim()
  const sur = String(surname || '').trim()
  const middleInitial = middle ? `${middle[0].toUpperCase()}.` : ''
  return [given, middleInitial, sur].filter(Boolean).join(' ') || sur || given || 'Unnamed Student'
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
  announcements: {
    label: 'Announcements',
    icon: <BellIcon />,
    accent: { dot: 'bg-amber-500', text: 'text-amber-600', bg: 'bg-amber-50', btn: 'bg-amber-500 hover:bg-amber-600', badge: 'bg-amber-100 text-amber-700' },
  },
  scan: {
    label: 'Scan',
    icon: <ScanIcon />,
    accent: { dot: 'bg-slate-700', text: 'text-slate-700', bg: 'bg-slate-50', btn: 'bg-slate-800 hover:bg-slate-700', badge: 'bg-slate-200 text-slate-700' },
  },
  gradebook: {
    label: 'Gradebook',
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

function Field({ label, hint, children }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <label className="block text-[11px] font-bold uppercase tracking-widest text-slate-400">{label}</label>
        {hint && <span className="text-[11px] text-slate-400">{hint}</span>}
      </div>
      {children}
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
   TAB BAR
═══════════════════════════════════════════════════════ */
function TabBar({ activeTab, tabs, counts, onChange }) {
  return (
    <div className="inline-flex flex-wrap items-center gap-1 rounded-2xl bg-slate-100 p-1.5">
      {tabs.map((key) => {
        const meta   = TAB_META[key]
        const active = activeTab === key
        const count  = counts[key] ?? 0
        return (
          <button
            key={key}
            type="button"
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
            <SpinIcon /> Importing {progress.done}/{progress.total} students?
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
              {preview.length} students found ? ready to import
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
  return (
    <div className="grid min-h-[520px] divide-y divide-slate-100 xl:grid-cols-[380px_1fr] xl:divide-x xl:divide-y-0">

      {/* LEFT: form */}
      <div className="flex flex-col gap-5 p-6">
        <div>
          <h3 className="text-base font-bold text-slate-800">Enroll a Student</h3>
          <p className="mt-0.5 text-xs text-slate-500">Add students to this subject's class list.</p>
        </div>

        <ImportClasslistButton
          subjectId={subjectId}
          educatorId={educatorId}
          onDone={onImportDone}
        />

        <form onSubmit={onAddStudent} className="flex flex-1 flex-col gap-4">
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
          <Field label="Email" hint="optional">
            <TextInput type="email" value={studentForm.email}
              onChange={(e) => setStudentForm((p) => ({ ...p, email: e.target.value }))}
              placeholder="juan@school.edu" />
          </Field>
          <div className="mt-auto pt-2">
            <SubmitBtn disabled={busyAction === 'student'} colorClass={a.btn}>
              {busyAction === 'student' ? <><SpinIcon /> Enrolling…</> : 'Enroll Student'}
            </SubmitBtn>
          </div>
        </form>

        <div className="border-t border-slate-100 pt-4">
          <DangerBtn onClick={onDeleteSubject} disabled={busyAction === 'delete-subject'} className="w-full justify-center">
            {busyAction === 'delete-subject' ? <><SpinIcon /> Deleting…</> : <><TrashIcon /> Delete Subject</>}
          </DangerBtn>
        </div>
      </div>

      {/* RIGHT: list */}
      <div className="flex flex-col gap-4 p-6 xl:h-0 xl:min-h-full xl:overflow-hidden">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-slate-800">Enrolled Students</h3>
          <span className="text-xs text-slate-400">
            {students.length} {students.length === 1 ? 'student' : 'students'}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto space-y-2 pr-1">
          {students.length ? students.map((s) => (
            <div key={s.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 transition hover:border-slate-200 hover:bg-white hover:shadow-sm"
            >
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-sky-100 text-[11px] font-bold text-sky-600">
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
                      <p className="truncate text-sm font-semibold text-slate-800">
                        {[s.given_name, s.middle_name, s.surname].filter(Boolean).join(' ')}
                      </p>
                      <p className="text-[11px] text-slate-400 font-mono">{s.student_code}</p>
                    </>
                  )}
                </div>
              </div>
              {String(editingStudentId) !== String(s.id) && (
                <div className="flex items-center gap-2">
                  <GhostBtn type="button" onClick={() => {
                    onStartEditStudent(s)
                  }}>
                    <PenIcon />
                  </GhostBtn>
                  <GhostBtn onClick={() => onRemoveStudent(s.id)} disabled={busyAction === `remove-student-${s.id}`}>
                    {busyAction === `remove-student-${s.id}` ? <SpinIcon /> : <XIcon />}
                  </GhostBtn>
                </div>
              )}
            </div>
          )) : (
            <EmptyState icon={<UsersIcon size="lg" />} title="No students enrolled yet" description="Use the form to enroll your first student." />
          )}
        </div>
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
  busyAction,
  editingActivityId,
  onCreateActivity,
  onStartEditActivity,
  onCancelEditActivity,
  onEditActivity,
  onDeleteActivity,
}) {
  const a = TAB_META.activities.accent
  return (
    <div className="grid min-h-[520px] divide-y divide-slate-100 xl:grid-cols-[380px_1fr] xl:divide-x xl:divide-y-0">

      {/* LEFT: form */}
      <div className="flex flex-col gap-5 p-6">
        <div>
          <h3 className="text-base font-bold text-slate-800">{editingActivityId ? 'Edit Activity' : 'New Activity'}</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {editingActivityId ? 'Update this activity details.' : 'Create exams, quizzes, or graded activities.'}
          </p>
        </div>

        <form onSubmit={editingActivityId ? onEditActivity : onCreateActivity} className="flex flex-1 flex-col gap-4">
          <Field label="Activity Title">
            <TextInput required value={activityForm.title}
              onChange={(e) => setActivityForm((p) => ({ ...p, title: e.target.value }))}
              placeholder="e.g. Midterm Examination" />
          </Field>
          <Field label="Type">
            <SelectInput value={activityForm.activity_type}
              onChange={(e) => setActivityForm((p) => ({ ...p, activity_type: e.target.value }))}>
              <option value="exam">Exam</option>
              <option value="quiz">Quiz</option>
              <option value="activity">Activity</option>
            </SelectInput>
          </Field>
          <Field label="Linked Exam ID" hint="optional">
            <TextInput type="number" value={activityForm.exam_id}
              onChange={(e) => setActivityForm((p) => ({ ...p, exam_id: e.target.value }))}
              placeholder="Leave blank if none" />
          </Field>
          <Field label="Max Score">
            <TextInput type="number" min={1} value={activityForm.max_score}
              onChange={(e) => setActivityForm((p) => ({ ...p, max_score: e.target.value }))} />
          </Field>
          <Field label="Due Date" hint="optional">
            <TextInput type="datetime-local" value={activityForm.due_at}
              onChange={(e) => setActivityForm((p) => ({ ...p, due_at: e.target.value }))} />
          </Field>
          <Field label="Status">
            <SelectInput value={activityForm.publish_status}
              onChange={(e) => setActivityForm((p) => ({ ...p, publish_status: e.target.value }))}>
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="archived">Archived</option>
            </SelectInput>
          </Field>
          <div className="mt-auto pt-2">
            <SubmitBtn disabled={busyAction === 'activity' || busyAction === `edit-activity-${editingActivityId}`} colorClass={a.btn}>
              {busyAction === 'activity' || busyAction === `edit-activity-${editingActivityId}`
                ? <><SpinIcon /> Saving…</>
                : (editingActivityId ? 'Save Activity' : 'Create Activity')}
            </SubmitBtn>
            {editingActivityId && (
              <GhostBtn type="button" onClick={onCancelEditActivity} className="mt-2 w-full justify-center" disabled={busyAction === `edit-activity-${editingActivityId}`}>
                <XIcon /> Cancel
              </GhostBtn>
            )}
          </div>
        </form>
      </div>

      {/* RIGHT: list */}
      <div className="flex flex-col gap-4 p-6 xl:h-0 xl:min-h-full xl:overflow-hidden">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-slate-800">Posted Activities</h3>
          <span className="text-xs text-slate-400">
            {activities.length} {activities.length === 1 ? 'activity' : 'activities'}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto space-y-2.5 pr-1">
          {activities.length ? activities.map((item) => (
            <div key={item.id}
              className="rounded-xl border border-slate-100 bg-slate-50 p-4 transition hover:border-slate-200 hover:bg-white hover:shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold text-slate-800 leading-snug">{item.title}</p>
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  <Badge className={ACTIVITY_TYPE_STYLES[item.activity_type] || 'bg-slate-100 text-slate-500'}>
                    {item.activity_type}
                  </Badge>
                  <Badge className={PUBLISH_STATUS_STYLES[item.publish_status] || 'bg-slate-100 text-slate-500'}>
                    {item.publish_status}
                  </Badge>
                </div>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
                <span>{item.submission_count || 0} submissions</span>
                {item.exam_id && <span>Exam #{item.exam_id}</span>}
                {item.due_at && <span>Due {new Date(item.due_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>}
                {item.max_score && <span>{item.max_score} pts</span>}
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <GhostBtn type="button" onClick={() => onStartEditActivity(item)} disabled={busyAction === `edit-activity-${item.id}`}>
                  <PenIcon />
                  Edit
                </GhostBtn>
                <DangerBtn type="button" onClick={() => onDeleteActivity(item.id)} disabled={busyAction === `delete-activity-${item.id}`}>
                  {busyAction === `delete-activity-${item.id}` ? <SpinIcon /> : <TrashIcon />}
                  Delete
                </DangerBtn>
              </div>
            </div>
          )) : (
            <EmptyState icon={<ClipboardIcon size="lg" />} title="No activities posted yet" description="Create your first exam, quiz, or activity." />
          )}
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════
   ANNOUNCEMENTS TAB
═══════════════════════════════════════════════════════ */
function AnnouncementsTab({
  announcements,
  announcementForm,
  setAnnouncementForm,
  busyAction,
  editingAnnouncementId,
  onPostAnnouncement,
  onStartEditAnnouncement,
  onCancelEditAnnouncement,
  onEditAnnouncement,
  onDeleteAnnouncement,
}) {
  const a = TAB_META.announcements.accent
  return (
    <div className="grid min-h-[520px] divide-y divide-slate-100 xl:h-[520px] xl:max-h-[520px] xl:grid-cols-[380px_1fr] xl:divide-x xl:divide-y-0">

      {/* LEFT: form */}
      <div className="flex flex-col gap-5 p-6">
        <div>
          <h3 className="text-base font-bold text-slate-800">{editingAnnouncementId ? 'Edit Announcement' : 'Post Announcement'}</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {editingAnnouncementId ? 'Update your announcement and save changes.' : 'Broadcast updates, reminders, or notes to your class.'}
          </p>
        </div>

        <form onSubmit={editingAnnouncementId ? onEditAnnouncement : onPostAnnouncement} className="flex flex-1 flex-col gap-4">
          <Field label="Subject Line">
            <TextInput required value={announcementForm.title}
              onChange={(e) => setAnnouncementForm((p) => ({ ...p, title: e.target.value }))}
              placeholder="e.g. Reminder: Exam next Monday" />
          </Field>
          <Field label="Message">
            <TextareaInput required rows={6} value={announcementForm.body}
              onChange={(e) => setAnnouncementForm((p) => ({ ...p, body: e.target.value }))}
              placeholder="Write your announcement here…" />
          </Field>
          <div className="mt-auto pt-2">
            <SubmitBtn disabled={busyAction === 'announcement' || busyAction === `edit-announcement-${editingAnnouncementId}`} colorClass={a.btn}>
              {busyAction === 'announcement' || busyAction === `edit-announcement-${editingAnnouncementId}`
                ? <><SpinIcon /> Saving…</>
                : (editingAnnouncementId ? 'Save Announcement' : 'Post Announcement')}
            </SubmitBtn>
            {editingAnnouncementId && (
              <GhostBtn type="button" onClick={onCancelEditAnnouncement} className="mt-2 w-full justify-center" disabled={busyAction === `edit-announcement-${editingAnnouncementId}`}>
                <XIcon /> Cancel
              </GhostBtn>
            )}
          </div>
        </form>
      </div>

      {/* RIGHT: list */}
      <div className="flex min-h-0 flex-col gap-4 p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-slate-800">Recent Announcements</h3>
          <span className="text-xs text-slate-400">{announcements.length} posted</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto space-y-3 pr-1">
          {announcements.length ? announcements.map((item) => (
            <div key={item.id} className="rounded-xl border border-slate-100 bg-slate-50 p-4 transition hover:border-slate-200 hover:bg-white hover:shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold text-slate-800">{item.title}</p>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <span className="text-[11px] text-slate-400">{relativeTime(item.created_at)}</span>
                  <GhostBtn type="button" onClick={() => onStartEditAnnouncement(item)} disabled={busyAction === `edit-announcement-${item.id}`}>
                    <PenIcon />
                    Edit
                  </GhostBtn>
                  <DangerBtn type="button" onClick={() => onDeleteAnnouncement(item.id)} disabled={busyAction === `delete-announcement-${item.id}`}>
                    {busyAction === `delete-announcement-${item.id}` ? <SpinIcon /> : <TrashIcon />}
                    Delete
                  </DangerBtn>
                </div>
              </div>
              {item.body && <p className="mt-2 text-xs text-slate-500 leading-relaxed line-clamp-3">{item.body}</p>}
            </div>
          )) : (
            <EmptyState icon={<BellIcon size="lg" />} title="No announcements yet" description="Post your first announcement to notify your class." />
          )}
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════
   SCAN CENTER TAB
═══════════════════════════════════════════════════════ */
function ScanCenterTab({ scan }) {
  const [actionMode, setActionMode] = useState('scan')
  const scannerConnected = Boolean(scan.scanner?.scanner?.connected)

  return (
    <div className="min-h-[520px] p-6">
      {scan.error && (
        <div className="mb-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {scan.error}
        </div>
      )}

      <div className={`mb-6 rounded-2xl border px-4 py-4 shadow-sm ${scannerConnected ? 'border-emerald-200 bg-emerald-50' : 'border-amber-300 bg-amber-50'}`}>
        <div className="flex flex-wrap items-center gap-3">
          <span className={`h-3 w-3 rounded-full ${scannerConnected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
          <p className={`text-sm font-bold ${scannerConnected ? 'text-emerald-800' : 'text-amber-800'}`}>
            {scannerConnected ? 'Scanner ready' : 'Scanner not connected'}
          </p>
          <span className="rounded-full border border-white/60 bg-white/70 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
            Transport: {scan.scanner?.transport || 'n/a'}
          </span>
        </div>
        
      </div>

      <div className="mb-4 grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs sm:grid-cols-2">
        <div className="rounded-lg border border-brand-200 bg-white px-3 py-2 text-brand-700">
          <span className="font-bold">Step 1:</span> Setup exam template
        </div>
        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-700">
          <span className="font-bold">Step 2:</span> Scan or manual submit
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(320px,420px)_1fr]">
        <section className="rounded-2xl border border-brand-200 bg-brand-50/40 p-5">
          <div className="mb-4 flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-100 text-brand-600">
              <DocIcon />
            </span>
            <div>
              <h3 className="text-sm font-bold text-slate-800">Step 1: Create Exam Template</h3>
              <p className="text-xs text-slate-500">Import from PDF or enter details manually.</p>
            </div>
          </div>
          <form onSubmit={scan.onCreateExam} className="space-y-3">
            <Field label="Upload PDF" hint="optional">
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={scan.onExamPdfUpload}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm outline-none file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-brand-700"
              />
              {scan.pdfImportStatus && <p className="text-xs text-slate-500">{scan.pdfImportStatus}</p>}
            </Field>
            <Field label="Exam Title">
              <TextInput
                required
                value={scan.examForm?.title || ''}
                onChange={(e) => scan.setExamForm((p) => ({ ...p, title: e.target.value }))}
                placeholder="Midterm Exam - CS101"
              />
            </Field>
            <Field label="Total Items">
              <TextInput
                required
                type="number"
                min={1}
                max={200}
                value={scan.examForm?.total_items || ''}
                onChange={(e) => scan.onTotalItemsChange(e.target.value)}
                placeholder="50"
              />
            </Field>
            <Field label="Answer Key">
              <TextareaInput
                required
                ref={scan.answerKeyRef}
                value={scan.answerKeyDisplay || ''}
                onChange={() => {}}
                onKeyDown={scan.onAnswerKeyKeyDown}
                onPaste={scan.onAnswerKeyPaste}
                className="h-36 font-mono text-sm leading-6"
                placeholder="A"
              />
            </Field>
            <SubmitBtn disabled={scan.busy} colorClass="bg-brand-600 hover:bg-brand-700">
              {scan.busy ? <><SpinIcon /> Saving...</> : 'Save Exam Template'}
            </SubmitBtn>
          </form>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                <ScanIcon />
              </span>
              <div>
                <h3 className="text-sm font-bold text-slate-800">Step 2: Scan or Submit</h3>
                <p className="text-xs text-slate-500">Primary flow is scanner-first. Manual is fallback.</p>
              </div>
            </div>
            <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
              <button
                type="button"
                onClick={() => setActionMode('scan')}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${actionMode === 'scan' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                Scanner Controls
              </button>
              <button
                type="button"
                onClick={() => setActionMode('manual')}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${actionMode === 'manual' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                Manual Submission
              </button>
            </div>
          </div>

          {actionMode === 'scan' ? (
            <form onSubmit={scan.onScan} className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold text-slate-600">Recommended workflow</p>
                <p className="mt-1 text-xs text-slate-500">Select a template, load paper, then run scan job.</p>
              </div>
              <Field label="Exam Template">
                <SelectInput
                  required
                  value={scan.scanRequest?.exam_id || ''}
                  onChange={(e) => scan.setScanRequest({ exam_id: e.target.value })}
                >
                  <option value="">Select exam template</option>
                  {(scan.exams || []).map((ex) => <option key={ex.id} value={ex.id}>{ex.title}</option>)}
                </SelectInput>
              </Field>
              <button
                type="submit"
                disabled={scan.busy || !scan.scanRequest?.exam_id || !scannerConnected}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {scan.busy ? <><SpinIcon /> Running scan...</> : <><ScanIcon /> Start Scan Job</>}
              </button>
              {!scannerConnected && (
                <p className="text-xs text-amber-700">Scanner is required for this action.</p>
              )}
            </form>
          ) : (
            <form onSubmit={scan.onGrade} className="space-y-3">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                <p className="text-xs font-semibold text-emerald-700">Fallback workflow</p>
                <p className="mt-1 text-xs text-emerald-700/80">Use this when scanner is unavailable or for corrections.</p>
              </div>
              <Field label="Exam Template">
                <SelectInput
                  required
                  value={scan.gradeForm?.exam_id || ''}
                  onChange={(e) => scan.setGradeForm((p) => ({ ...p, exam_id: e.target.value }))}
                >
                  <option value="">Select exam template</option>
                  {(scan.exams || []).map((ex) => <option key={ex.id} value={ex.id}>{ex.title}</option>)}
                </SelectInput>
              </Field>
              <Field label="Student Code">
                <TextInput
                  required
                  value={scan.gradeForm?.student_code || ''}
                  onChange={(e) => scan.setGradeForm((p) => ({ ...p, student_code: e.target.value }))}
                  placeholder="2021-00001"
                />
              </Field>
              <Field label="Answers">
                <TextareaInput
                  required
                  ref={scan.gradeAnswersRef}
                  value={scan.gradeAnswersDisplay || ''}
                  onChange={() => {}}
                  onKeyDown={scan.onGradeAnswersKeyDown}
                  onPaste={scan.onGradeAnswersPaste}
                  className="h-36 font-mono text-sm leading-6"
                  placeholder="A"
                />
              </Field>
              <SubmitBtn disabled={scan.busy || !scan.gradeForm?.exam_id} colorClass="bg-emerald-600 hover:bg-emerald-700">
                {scan.busy ? <><SpinIcon /> Grading...</> : 'Grade Submission'}
              </SubmitBtn>
            </form>
          )}
        </section>
      </div>

      {(scan.latestExam || scan.lastResult) && (
        <div className="mt-6 grid gap-4 border-t border-slate-100 pt-5 sm:grid-cols-2">
          {scan.latestExam && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Latest Template</p>
              <p className="mt-1.5 text-sm font-bold text-slate-800">{scan.latestExam.title}</p>
              <p className="mt-0.5 text-xs text-slate-500">{scan.latestExam.total_items} items</p>
            </div>
          )}
          {scan.lastResult && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-[11px] font-bold uppercase tracking-widest text-emerald-500">Last Result</p>
              <p className="mt-1.5 text-sm font-bold text-slate-800">{scan.lastResult.student_code} - {scan.lastResult.score}/{scan.lastResult.total_items}</p>
              <p className="mt-0.5 text-xs text-slate-500">{scan.lastResult.exam_title}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
function GradebookTab({ gradebook, atRiskStudents }) {
  return (
    <div className="min-h-[520px] p-6">
      {/* Summary pills */}
      {gradebook.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-semibold text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {gradebook.length} students enrolled
          </span>
          {atRiskStudents.length > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-semibold text-amber-700">
              <RiskIcon />
              {atRiskStudents.length} at-risk
            </span>
          )}
        </div>
      )}

      {gradebook.length ? (
        <div className="max-h-[564px] overflow-y-auto">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 bg-white z-10">
              <tr className="border-b border-slate-100">
                {['Student', 'Code', 'Completed', 'Published', 'Average'].map((h) => (
                  <th key={h} className="pb-3 pr-6 text-left text-[11px] font-bold uppercase tracking-widest text-slate-400">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {gradebook.map((row) => {
                const displayName = formatStudentFullName(row.given_name, row.middle_name, row.surname)
                return (
                  <tr key={row.student_id} className="border-b border-slate-50 transition hover:bg-slate-50">
                    <td className="py-3 pr-6">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-bold text-slate-500">
                          {initials(displayName)}
                        </div>
                        <span className="font-semibold text-slate-800">{displayName}</span>
                      </div>
                    </td>
                    <td className="py-3 pr-6 font-mono text-xs text-slate-500">{row.student_code}</td>
                    <td className="py-3 pr-6 text-slate-700">{row.completed_activities}</td>
                    <td className="py-3 pr-6 text-slate-700">{row.published_activities}</td>
                    <td className="py-3">
                      <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-bold ${gradeBg(row)}`}>
                        {formatPercent(row.average_percent)}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={<GradebookIcon size="lg" />}
          title="No gradebook data yet"
          description="Enroll students and post exam activities to see grades here."
        />
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
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {subjects.map((s) => {
                const published = Number(s.published_activity_count || 0)
                const total     = Number(s.activity_count || 0)
                const pct       = total > 0 ? Math.round((published / total) * 100) : 0
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onSelect(String(s.id))}
                    className="group flex flex-col rounded-xl border border-slate-200 bg-slate-50 p-4 text-left transition hover:border-brand-300 hover:bg-white hover:shadow-md"
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
  const [announcements, setAnnouncements]         = useState([])
  const [gradebook, setGradebook]                 = useState([])
  const [loading, setLoading]                     = useState(false)
  const [error, setError]                         = useState('')
  const [busyAction, setBusyAction]               = useState('')
  const [subjectsPanelOpen, setSubjectsPanelOpen] = useState(false)
  const [showSubjectForm, setShowSubjectForm]     = useState(false)
  const [subjectForm, setSubjectForm]             = useState(emptySubjectForm)
  const [subjectTileEditing, setSubjectTileEditing] = useState(false)
  const [editSubjectForm, setEditSubjectForm]     = useState(emptySubjectForm)
  const [studentForm, setStudentForm]             = useState(emptyStudentForm)
  const [editingStudentId, setEditingStudentId]   = useState('')
  const [editStudentForm, setEditStudentForm]     = useState(emptyStudentForm)
  const [activityForm, setActivityForm]           = useState(emptyActivityForm)
  const [announcementForm, setAnnouncementForm]   = useState(emptyAnnouncementForm)
  const [editingActivityId, setEditingActivityId] = useState('')
  const [editingAnnouncementId, setEditingAnnouncementId] = useState('')
  const [activeTab, setActiveTab]                 = useState('roster')

  const selectedSubject     = useMemo(() => subjects.find((s) => String(s.id) === String(selectedSubjectId)), [subjects, selectedSubjectId])
  const publishedActivities = useMemo(() => activities.filter((a) => a.publish_status === 'published'), [activities])
  const atRiskStudents      = useMemo(() => gradebook.filter((r) => {
    const p = Number(r.published_activities || 0)
    return p > 0 && (Number(r.completed_activities || 0) < p || Number(r.average_percent || 0) < 75)
  }), [gradebook])

  // Build tab list dynamically
  const tabs = useMemo(() => {
    const base = ['roster', 'activities', 'announcements']
    if (hasScanCenter) base.push('scan')
    base.push('gradebook')
    return base
  }, [hasScanCenter])

  const tabCounts = useMemo(() => ({
    roster:        students.length,
    activities:    activities.length,
    announcements: announcements.length,
    scan:          scan.exams?.length || 0,
    gradebook:     gradebook.length,
  }), [students, activities, announcements, scan.exams, gradebook])

  async function loadSubjects() {
    const res = await apiGet(withEducator('/lms/subjects'))
    setSubjects(res.data || [])
  }

  async function loadSubjectDetails(id) {
    if (!id) return
    const [sR, aR, anR, gR] = await Promise.all([
      apiGet(withEducator(`/lms/subjects/${id}/students`)),
      apiGet(withEducator(`/lms/subjects/${id}/activities`)),
      apiGet(withEducator(`/lms/subjects/${id}/announcements`)),
      apiGet(withEducator(`/lms/subjects/${id}/gradebook`)),
    ])
    setStudents(sR.data || [])
    setActivities(aR.data || [])
    setAnnouncements(anR.data || [])
    setGradebook(gR.data || [])
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
    onCancelEditAnnouncement()
    setLoading(true)
    setError('')
    loadSubjectDetails(selectedSubjectId).catch((e) => setError(e.message)).finally(() => setLoading(false))
  }, [selectedSubjectId])

  async function onCreateSubject(e) {
    e.preventDefault()
    setBusyAction('subject')
    setError('')
    try {
      await apiPost(withEducator('/lms/subjects'), { ...subjectForm, educator_id: educatorId })
      setSubjectForm(emptySubjectForm)
      setShowSubjectForm(false)
      await loadSubjects()
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  async function onDeleteSubject() {
    if (!selectedSubject) return
    if (!window.confirm(`Delete "${selectedSubject.subject_code}"? This removes the list and activities.`)) return
    setBusyAction('delete-subject')
    try {
      await apiDelete(withEducator(`/lms/subjects/${selectedSubject.id}`))
      setSelectedSubjectId('')
      setStudents([]); setActivities([]); setAnnouncements([]); setGradebook([])
      await loadSubjects()
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
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

  async function onRemoveStudent(id) {
    setBusyAction(`remove-student-${id}`)
    try {
      await apiDelete(withEducator(`/lms/subjects/${selectedSubjectId}/students/${id}`))
      if (String(editingStudentId) === String(id)) {
        onCancelEditStudent()
      }
      await refreshSubjectAndHomepage(selectedSubjectId)
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  async function onCreateActivity(e) {
    e.preventDefault()
    if (!selectedSubjectId) return
    setBusyAction('activity')
    try {
      await apiPost(withEducator(`/lms/subjects/${selectedSubjectId}/activities`), {
        ...activityForm,
        exam_id: activityForm.exam_id ? Number(activityForm.exam_id) : null,
        max_score: Number(activityForm.max_score || 100),
      })
      setActivityForm(emptyActivityForm)
      await refreshSubjectAndHomepage(selectedSubjectId)
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  function onStartEditActivity(activity) {
    setEditingActivityId(String(activity.id))
    setActivityForm({
      title: activity.title || '',
      activity_type: activity.activity_type || 'exam',
      exam_id: activity.exam_id ? String(activity.exam_id) : '',
      max_score: activity.max_score || 100,
      due_at: activity.due_at ? String(activity.due_at).slice(0, 16) : '',
      publish_status: activity.publish_status || 'draft',
    })
  }

  function onCancelEditActivity() {
    setEditingActivityId('')
    setActivityForm(emptyActivityForm)
  }

  async function onEditActivity(e) {
    if (e) e.preventDefault()
    if (!selectedSubjectId || !editingActivityId) return
    setBusyAction(`edit-activity-${editingActivityId}`)
    try {
      await apiPut(withEducator(`/lms/subjects/${selectedSubjectId}/activities/${editingActivityId}`), {
        ...activityForm,
        exam_id: activityForm.exam_id ? Number(activityForm.exam_id) : null,
        max_score: Number(activityForm.max_score || 100),
      })
      onCancelEditActivity()
      await refreshSubjectAndHomepage(selectedSubjectId)
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  async function onDeleteActivity(id) {
    if (!selectedSubjectId) return
    if (!window.confirm('Delete this activity?')) return
    setBusyAction(`delete-activity-${id}`)
    try {
      await apiDelete(withEducator(`/lms/subjects/${selectedSubjectId}/activities/${id}`))
      if (String(editingActivityId) === String(id)) {
        onCancelEditActivity()
      }
      await refreshSubjectAndHomepage(selectedSubjectId)
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  async function onPostAnnouncement(e) {
    e.preventDefault()
    if (!selectedSubjectId) return
    setBusyAction('announcement')
    try {
      await apiPost(withEducator(`/lms/subjects/${selectedSubjectId}/announcements`), announcementForm)
      setAnnouncementForm(emptyAnnouncementForm)
      await loadSubjectDetails(selectedSubjectId)
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  function onStartEditAnnouncement(announcement) {
    setEditingAnnouncementId(String(announcement.id))
    setAnnouncementForm({
      title: announcement.title || '',
      body: announcement.body || '',
    })
  }

  function onCancelEditAnnouncement() {
    setEditingAnnouncementId('')
    setAnnouncementForm(emptyAnnouncementForm)
  }

  async function onEditAnnouncement(e) {
    if (e) e.preventDefault()
    if (!selectedSubjectId || !editingAnnouncementId) return
    setBusyAction(`edit-announcement-${editingAnnouncementId}`)
    try {
      await apiPut(withEducator(`/lms/subjects/${selectedSubjectId}/announcements/${editingAnnouncementId}`), announcementForm)
      onCancelEditAnnouncement()
      await loadSubjectDetails(selectedSubjectId)
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  async function onDeleteAnnouncement(id) {
    if (!selectedSubjectId) return
    if (!window.confirm('Delete this announcement?')) return
    setBusyAction(`delete-announcement-${id}`)
    try {
      await apiDelete(withEducator(`/lms/subjects/${selectedSubjectId}/announcements/${id}`))
      if (String(editingAnnouncementId) === String(id)) {
        onCancelEditAnnouncement()
      }
      await loadSubjectDetails(selectedSubjectId)
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  /* ── render ─────────────────────────────────────────── */
  return (
    <main className="mx-auto max-w-7xl px-4 pt-3 pb-6 sm:px-6 lg:px-8">

      {/* HEADER */}

      {/* ERROR */}
      {error && (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
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
                className="flex items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5 text-left transition hover:bg-brand-100"
                title="Click to edit subject details"
              >
                <span className="text-xs font-bold uppercase tracking-widest text-brand-500">{selectedSubject.subject_code}</span>
                <span className="h-3.5 w-px bg-brand-200" />
                <span className="text-sm font-semibold text-brand-800">{selectedSubject.title}</span>
                {selectedSubject.term_label && (
                  <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold text-brand-600">{selectedSubject.term_label}</span>
                )}
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
                busyAction={busyAction} editingActivityId={editingActivityId}
                onCreateActivity={onCreateActivity}
                onStartEditActivity={onStartEditActivity}
                onCancelEditActivity={onCancelEditActivity}
                onEditActivity={onEditActivity}
                onDeleteActivity={onDeleteActivity}
              />
            )}
            {activeTab === 'announcements' && (
              <AnnouncementsTab
                announcements={announcements} announcementForm={announcementForm}
                setAnnouncementForm={setAnnouncementForm} busyAction={busyAction}
                editingAnnouncementId={editingAnnouncementId}
                onPostAnnouncement={onPostAnnouncement}
                onStartEditAnnouncement={onStartEditAnnouncement}
                onCancelEditAnnouncement={onCancelEditAnnouncement}
                onEditAnnouncement={onEditAnnouncement}
                onDeleteAnnouncement={onDeleteAnnouncement}
              />
            )}
            {activeTab === 'scan' && hasScanCenter && (
              <ScanCenterTab scan={scan} />
            )}
            {activeTab === 'gradebook' && (
              <GradebookTab gradebook={gradebook} atRiskStudents={atRiskStudents} />
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
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {subjects.map((s) => {
                    const published = Number(s.published_activity_count || 0)
                    const total     = Number(s.activity_count || 0)
                    const pct       = total > 0 ? Math.round((published / total) * 100) : 0
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSelectedSubjectId(String(s.id))}
                        className="group flex flex-col rounded-xl border border-slate-200 bg-slate-50 p-4 text-left transition hover:border-brand-300 hover:bg-white hover:shadow-md"
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
    </main>
  )
}

/* ═══════════════════════════════════════════════════════
   ICONS
═══════════════════════════════════════════════════════ */
const SZ = { sm: 'h-3.5 w-3.5', md: 'h-5 w-5', lg: 'h-6 w-6' }
function UsersIcon({ size = 'sm' })     { return <svg className={SZ[size]} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg> }
function ClipboardIcon({ size = 'sm' }) { return <svg className={SZ[size]} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg> }
function BellIcon({ size = 'sm' })      { return <svg className={SZ[size]} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg> }
function ScanIcon({ size = 'sm' })      { return <svg className={SZ[size] || SZ.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/></svg> }
function GradebookIcon({ size = 'sm' }) { return <svg className={SZ[size] || SZ.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> }
function SubjectIcon({ size = 'sm' })   { return <svg className={SZ[size]} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg> }
function RiskIcon({ size = 'sm' })      { return <svg className={SZ[size]} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> }
function DocIcon({ size = 'sm' })       { return <svg className={SZ[size]} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> }
function PenIcon({ size = 'sm' })       { return <svg className={SZ[size]} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4z"/></svg> }
function PlusIcon()                     { return <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> }
function XIcon({ size = 'sm' })         { return <svg className={SZ[size]} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> }
function TrashIcon()                    { return <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg> }
function SpinIcon()                     { return <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0" strokeLinecap="round"/></svg> }
