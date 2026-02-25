import { useEffect, useMemo, useState } from 'react'
import { apiDelete, apiGet, apiPost } from './lib/api'

/* ─── constants ─────────────────────────────────────── */
const emptySubjectForm   = { subject_code: '', title: '', term_label: '', description: '' }
const emptyStudentForm   = { student_code: '', full_name: '', email: '' }
const emptyActivityForm  = { title: '', activity_type: 'exam', exam_id: '', max_score: 100, due_at: '', publish_status: 'draft' }
const emptyAnnouncementForm = { title: '', body: '' }

/* ─── helpers ───────────────────────────────────────── */
function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'N/A'
  return `${Math.round(Number(value))}%`
}

function statusTone(row) {
  const completed = Number(row.completed_activities || 0)
  const published  = Number(row.published_activities || 0)
  const avg        = Number(row.average_percent || 0)
  if (published === 0)                          return 'text-slate-500'
  if (completed < published || avg < 75)        return 'text-amber-600'
  if (avg >= 90)                                return 'text-emerald-600'
  return 'text-brand-600'
}

function statusBg(row) {
  const completed = Number(row.completed_activities || 0)
  const published  = Number(row.published_activities || 0)
  const avg        = Number(row.average_percent || 0)
  if (published === 0)                          return 'bg-slate-100 text-slate-500'
  if (completed < published || avg < 75)        return 'bg-amber-50 text-amber-700 border border-amber-200'
  if (avg >= 90)                                return 'bg-emerald-50 text-emerald-700 border border-emerald-200'
  return 'bg-blue-50 text-blue-700 border border-blue-200'
}

/* ─── tiny sub-components ───────────────────────────── */
function SectionHeader({ icon, title, accent = 'blue' }) {
  const colors = {
    blue:   'from-blue-500 to-indigo-500',
    emerald:'from-emerald-500 to-teal-500',
    amber:  'from-amber-400 to-orange-500',
    rose:   'from-rose-500 to-pink-500',
    violet: 'from-violet-500 to-purple-500',
  }
  return (
    <div className="flex items-center gap-3">
      <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${colors[accent]} text-white shadow-sm`}>
        {icon}
      </div>
      <h3 className="font-display text-lg font-semibold text-slate-800">{title}</h3>
    </div>
  )
}

function FormField({ label, children }) {
  return (
    <div className="space-y-1">
      <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      {children}
    </div>
  )
}

function Input({ className = '', ...props }) {
  return (
    <input
      className={`w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 ${className}`}
      {...props}
    />
  )
}

function Select({ className = '', children, ...props }) {
  return (
    <select
      className={`w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 ${className}`}
      {...props}
    >
      {children}
    </select>
  )
}

function Textarea({ className = '', ...props }) {
  return (
    <textarea
      className={`w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 ${className}`}
      {...props}
    />
  )
}

function PrimaryBtn({ children, accent = 'blue', className = '', ...props }) {
  const colors = {
    blue:   'bg-brand-600 hover:bg-brand-700',
    emerald:'bg-emerald-600 hover:bg-emerald-700',
    amber:  'bg-amber-500 hover:bg-amber-600',
    slate:  'bg-slate-800 hover:bg-slate-700',
    rose:   'bg-rose-600 hover:bg-rose-700',
  }
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition disabled:opacity-50 ${colors[accent]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

function GhostBtn({ children, className = '', ...props }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50 ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

function EmptyState({ message }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 py-8 text-center">
      <p className="text-sm text-slate-400">{message}</p>
    </div>
  )
}

function CollapseToggle({ open, onToggle, label }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white px-5 py-4 text-left shadow-sm transition hover:bg-slate-50"
    >
      <span className="text-sm font-semibold text-slate-700">{label}</span>
      <svg
        className={`h-4 w-4 text-slate-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  )
}

/* ─── badge helpers ─────────────────────────────────── */
function ActivityBadge({ type }) {
  const styles = {
    exam:     'bg-blue-100 text-blue-700',
    quiz:     'bg-violet-100 text-violet-700',
    activity: 'bg-teal-100 text-teal-700',
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${styles[type] || 'bg-slate-100 text-slate-600'}`}>
      {type}
    </span>
  )
}

function StatusBadge({ status }) {
  const styles = {
    draft:     'bg-slate-100 text-slate-600',
    published: 'bg-emerald-100 text-emerald-700',
    archived:  'bg-rose-100 text-rose-600',
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${styles[status] || 'bg-slate-100 text-slate-600'}`}>
      {status}
    </span>
  )
}

/* ═══════════════════════════════════════════════════
   MAIN COMPONENT
══════════════════════════════════════════════════════ */
export default function LmsDashboard({ scanCenter = null }) {
  const scan        = scanCenter || {}
  const hasScanCenter = Boolean(scan.onCreateExam && scan.onScan && scan.onGrade)

  /* state */
  const [subjects, setSubjects]                     = useState([])
  const [selectedSubjectId, setSelectedSubjectId]   = useState('')
  const [students, setStudents]                     = useState([])
  const [activities, setActivities]                 = useState([])
  const [announcements, setAnnouncements]           = useState([])
  const [gradebook, setGradebook]                   = useState([])
  const [loading, setLoading]                       = useState(false)
  const [error, setError]                           = useState('')
  const [busyAction, setBusyAction]                 = useState('')
  const [subjectsPanelOpen, setSubjectsPanelOpen]   = useState(false)
  const [showSubjectForm, setShowSubjectForm]       = useState(false)
  const [subjectForm, setSubjectForm]               = useState(emptySubjectForm)
  const [studentForm, setStudentForm]               = useState(emptyStudentForm)
  const [activityForm, setActivityForm]             = useState(emptyActivityForm)
  const [announcementForm, setAnnouncementForm]     = useState(emptyAnnouncementForm)

  /* NEW: collapsible section states */
  const [scanOpen, setScanOpen]           = useState(false)
  const [gradebookOpen, setGradebookOpen] = useState(false)

  /* derived */
  const selectedSubject       = useMemo(() => subjects.find((s) => String(s.id) === String(selectedSubjectId)), [subjects, selectedSubjectId])
  const publishedActivities   = useMemo(() => activities.filter((a) => a.publish_status === 'published'), [activities])
  const atRiskStudents        = useMemo(() => gradebook.filter((r) => {
    const p = Number(r.published_activities || 0)
    return p > 0 && (Number(r.completed_activities || 0) < p || Number(r.average_percent || 0) < 75)
  }), [gradebook])

  /* data loaders */
  async function loadSubjects() {
    const res = await apiGet('/lms/subjects')
    setSubjects(res.data || [])
  }

  async function loadSubjectDetails(subjectId) {
    if (!subjectId) return
    const [studentsRes, activitiesRes, announcementsRes, gradebookRes] = await Promise.all([
      apiGet(`/lms/subjects/${subjectId}/students`),
      apiGet(`/lms/subjects/${subjectId}/activities`),
      apiGet(`/lms/subjects/${subjectId}/announcements`),
      apiGet(`/lms/subjects/${subjectId}/gradebook`),
    ])
    setStudents(studentsRes.data || [])
    setActivities(activitiesRes.data || [])
    setAnnouncements(announcementsRes.data || [])
    setGradebook(gradebookRes.data || [])
  }

  async function bootstrap() {
    setLoading(true)
    setError('')
    try { await loadSubjects() }
    catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { bootstrap() }, [])

  useEffect(() => {
    if (!selectedSubjectId) return
    setLoading(true)
    setError('')
    loadSubjectDetails(selectedSubjectId)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [selectedSubjectId])

  /* subject CRUD */
  async function onCreateSubject(e) {
    e.preventDefault()
    setBusyAction('subject')
    setError('')
    try {
      await apiPost('/lms/subjects', subjectForm)
      setSubjectForm(emptySubjectForm)
      setShowSubjectForm(false)
      await loadSubjects()
    } catch (err) { setError(err.message) }
    finally { setBusyAction('') }
  }

  async function onDeleteSubject() {
    if (!selectedSubject) return
    const ok = window.confirm(`Delete subject ${selectedSubject.subject_code}? This removes roster and activities.`)
    if (!ok) return
    setBusyAction('delete-subject')
    setError('')
    try {
      await apiDelete(`/lms/subjects/${selectedSubject.id}`)
      setSelectedSubjectId('')
      setStudents([])
      setActivities([])
      setAnnouncements([])
      setGradebook([])
      await loadSubjects()
    } catch (err) { setError(err.message) }
    finally { setBusyAction('') }
  }

  /* student CRUD */
  async function onAddStudent(e) {
    e.preventDefault()
    if (!selectedSubjectId) return
    setBusyAction('student')
    setError('')
    try {
      await apiPost(`/lms/subjects/${selectedSubjectId}/students`, studentForm)
      setStudentForm(emptyStudentForm)
      await loadSubjectDetails(selectedSubjectId)
    } catch (err) { setError(err.message) }
    finally { setBusyAction('') }
  }

  async function onRemoveStudent(studentId) {
    if (!selectedSubjectId) return
    setBusyAction(`remove-student-${studentId}`)
    setError('')
    try {
      await apiDelete(`/lms/subjects/${selectedSubjectId}/students/${studentId}`)
      await loadSubjectDetails(selectedSubjectId)
    } catch (err) { setError(err.message) }
    finally { setBusyAction('') }
  }

  /* activity CRUD */
  async function onCreateActivity(e) {
    e.preventDefault()
    if (!selectedSubjectId) return
    setBusyAction('activity')
    setError('')
    try {
      await apiPost(`/lms/subjects/${selectedSubjectId}/activities`, {
        ...activityForm,
        exam_id: activityForm.exam_id ? Number(activityForm.exam_id) : null,
        max_score: Number(activityForm.max_score || 100),
      })
      setActivityForm(emptyActivityForm)
      await loadSubjectDetails(selectedSubjectId)
    } catch (err) { setError(err.message) }
    finally { setBusyAction('') }
  }

  /* announcement CRUD */
  async function onPostAnnouncement(e) {
    e.preventDefault()
    if (!selectedSubjectId) return
    setBusyAction('announcement')
    setError('')
    try {
      await apiPost(`/lms/subjects/${selectedSubjectId}/announcements`, announcementForm)
      setAnnouncementForm(emptyAnnouncementForm)
      await loadSubjectDetails(selectedSubjectId)
    } catch (err) { setError(err.message) }
    finally { setBusyAction('') }
  }

  /* ── render ─────────────────────────────────────── */
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

      {/* ── HERO HEADER ────────────────────────────── */}
      <section className="relative overflow-hidden rounded-2xl border border-slate-200/80 bg-white/90 p-6 shadow-panel backdrop-blur sm:p-8">
        {/* subtle gradient accent strip */}
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-brand-500 via-indigo-400 to-sky-400 rounded-t-2xl" />

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Educator LMS Dashboard
            </span>
            <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
              Classroom Command
            </h1>
            <p className="mt-1.5 text-sm text-slate-500">
              Manage subjects, students, activities, and exam scanning in one place.
            </p>
          </div>

          {/* system status pills */}
          {hasScanCenter && (
            <div className="flex flex-wrap gap-2 sm:flex-col sm:items-end">
              <StatusPill label="Backend"  ok={scan.health?.ok}  okText="Online"     failText="Offline" />
              <StatusPill label="Database" ok={scan.health?.db}  okText="MySQL Ready" failText="Check DB" />
              <StatusPill label="Templates" count={scan.exams?.length || 0} />
            </div>
          )}
        </div>
      </section>

      {/* ── ERROR BANNER ───────────────────────────── */}
      {error && (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <svg className="mt-0.5 h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {error}
        </div>
      )}

      {/* ── SUBJECT SWITCHER BAR ────────────────────── */}
      <section className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setSubjectsPanelOpen(true)}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 hover:shadow"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
          Subjects
        </button>
        {selectedSubject ? (
          <div className="flex items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5">
            <span className="text-xs font-bold uppercase tracking-wide text-brand-600">{selectedSubject.subject_code}</span>
            <span className="h-3.5 w-px bg-brand-200" />
            <span className="text-sm font-medium text-brand-800">{selectedSubject.title}</span>
          </div>
        ) : (
          <p className="text-sm text-slate-500">No subject selected — open the panel to choose one.</p>
        )}
      </section>

      {/* ── SUBJECTS SIDE PANEL ─────────────────────── */}
      {subjectsPanelOpen && (
        <aside className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-panel">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-semibold text-slate-800">Your Subjects</h2>
            <button
              type="button"
              onClick={() => setSubjectsPanelOpen(false)}
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              aria-label="Close panel"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {subjects.map((subject) => (
              <button
                key={subject.id}
                type="button"
                onClick={() => { setSelectedSubjectId(String(subject.id)); setSubjectsPanelOpen(false) }}
                className={`rounded-xl border p-3.5 text-left transition ${
                  String(subject.id) === String(selectedSubjectId)
                    ? 'border-brand-400 bg-brand-50 ring-2 ring-brand-100'
                    : 'border-slate-200 bg-white hover:border-brand-200 hover:bg-slate-50'
                }`}
              >
                <p className="text-xs font-bold uppercase tracking-wide text-brand-600">{subject.subject_code}</p>
                <p className="mt-1 text-sm font-semibold text-slate-800">{subject.title}</p>
                <p className="mt-1 text-xs text-slate-500">{subject.student_count} students · {subject.activity_count} activities</p>
              </button>
            ))}
            {!subjects.length && (
              <div className="col-span-full rounded-xl border border-dashed border-slate-300 py-6 text-center text-sm text-slate-400">
                No subjects yet. Create one below.
              </div>
            )}
          </div>

          {/* new subject form */}
          <div className="mt-4 border-t border-slate-100 pt-4">
            {showSubjectForm ? (
              <form onSubmit={onCreateSubject} className="grid gap-3 sm:grid-cols-2">
                <FormField label="Subject Code">
                  <Input required value={subjectForm.subject_code} onChange={(e) => setSubjectForm((p) => ({ ...p, subject_code: e.target.value }))} placeholder="e.g. CS101" />
                </FormField>
                <FormField label="Title">
                  <Input required value={subjectForm.title} onChange={(e) => setSubjectForm((p) => ({ ...p, title: e.target.value }))} placeholder="Course title" />
                </FormField>
                <FormField label="Term">
                  <Input value={subjectForm.term_label} onChange={(e) => setSubjectForm((p) => ({ ...p, term_label: e.target.value }))} placeholder="e.g. AY 2024-25 Sem 2" />
                </FormField>
                <FormField label="Description">
                  <Input value={subjectForm.description} onChange={(e) => setSubjectForm((p) => ({ ...p, description: e.target.value }))} placeholder="Optional description" />
                </FormField>
                <div className="col-span-full flex gap-2">
                  <PrimaryBtn type="submit" disabled={busyAction === 'subject'} accent="blue">
                    {busyAction === 'subject' ? 'Saving…' : 'Create Subject'}
                  </PrimaryBtn>
                  <GhostBtn type="button" onClick={() => setShowSubjectForm(false)}>Cancel</GhostBtn>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setShowSubjectForm(true)}
                className="inline-flex items-center gap-2 rounded-lg border border-dashed border-brand-300 bg-brand-50 px-4 py-2 text-sm font-semibold text-brand-700 transition hover:bg-brand-100"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add New Subject
              </button>
            )}
          </div>
        </aside>
      )}

      {/* ── STATS ROW ──────────────────────────────── */}
      <section className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={<SubjectIcon />} label="Active Subject"
          value={selectedSubject ? selectedSubject.subject_code : '—'}
          sub={selectedSubject?.title || 'No class selected'}
          accent="blue" />
        <StatCard icon={<StudentsIcon />} label="Enrolled Students"
          value={students.length} accent="indigo" />
        <StatCard icon={<ActivityIcon />} label="Published Activities"
          value={publishedActivities.length} accent="emerald" />
        <StatCard icon={<RiskIcon />} label="At-Risk Students"
          value={atRiskStudents.length}
          accent={atRiskStudents.length > 0 ? 'amber' : 'slate'} />
      </section>

      {/* ── MAIN CONTENT AREA ────────────────────────── */}
      {selectedSubject && (
        <div className="mt-6 space-y-6">

          {/* ── 3-COLUMN TILES ─────────────────────── */}
          <div className="grid gap-6 xl:grid-cols-3">

            {/* ── ROSTER ─────────────────────────────── */}
            <article className="flex flex-col rounded-2xl border border-slate-200 bg-white shadow-panel">
              <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
                <SectionHeader
                  icon={<UsersIcon />}
                  title="Roster"
                  accent="blue"
                />
                <button
                  type="button"
                  onClick={onDeleteSubject}
                  disabled={busyAction === 'delete-subject'}
                  className="flex items-center gap-1 rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
                >
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                  Delete Subject
                </button>
              </div>

              <div className="flex-1 overflow-auto p-5">
                {/* Add student form */}
                <form onSubmit={onAddStudent} className="space-y-2.5">
                  <div className="grid grid-cols-2 gap-2">
                    <FormField label="Student Code">
                      <Input required value={studentForm.student_code}
                        onChange={(e) => setStudentForm((p) => ({ ...p, student_code: e.target.value }))}
                        placeholder="e.g. 2021-00001" />
                    </FormField>
                    <FormField label="Full Name">
                      <Input required value={studentForm.full_name}
                        onChange={(e) => setStudentForm((p) => ({ ...p, full_name: e.target.value }))}
                        placeholder="Juan Dela Cruz" />
                    </FormField>
                  </div>
                  <FormField label="Email (optional)">
                    <Input type="email" value={studentForm.email}
                      onChange={(e) => setStudentForm((p) => ({ ...p, email: e.target.value }))}
                      placeholder="student@school.edu" />
                  </FormField>
                  <PrimaryBtn type="submit" disabled={busyAction === 'student'} accent="blue" className="w-full">
                    {busyAction === 'student' ? 'Adding…' : '+ Enroll Student'}
                  </PrimaryBtn>
                </form>

                {/* Student list */}
                <div className="mt-4 max-h-64 space-y-2 overflow-auto pr-1">
                  {students.length ? students.map((s) => (
                    <div key={s.id} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">
                          {(s.full_name || '?').charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-slate-800 leading-tight">{s.full_name}</p>
                          <p className="text-xs text-slate-500">{s.student_code}</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onRemoveStudent(s.id)}
                        disabled={busyAction === `remove-student-${s.id}`}
                        className="ml-2 rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-500 disabled:opacity-50"
                        aria-label="Remove student"
                      >
                        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                      </button>
                    </div>
                  )) : <EmptyState message="No students enrolled yet." />}
                </div>
              </div>
            </article>

            {/* ── ACTIVITIES ─────────────────────────── */}
            <article className="flex flex-col rounded-2xl border border-slate-200 bg-white shadow-panel">
              <div className="border-b border-slate-100 px-5 py-4">
                <SectionHeader icon={<ClipboardIcon />} title="Activities" accent="emerald" />
              </div>

              <div className="flex-1 overflow-auto p-5">
                {/* Create activity form */}
                <form onSubmit={onCreateActivity} className="space-y-2.5">
                  <FormField label="Title">
                    <Input required value={activityForm.title}
                      onChange={(e) => setActivityForm((p) => ({ ...p, title: e.target.value }))}
                      placeholder="Activity title" />
                  </FormField>
                  <div className="grid grid-cols-2 gap-2">
                    <FormField label="Type">
                      <Select value={activityForm.activity_type}
                        onChange={(e) => setActivityForm((p) => ({ ...p, activity_type: e.target.value }))}>
                        <option value="exam">Exam</option>
                        <option value="quiz">Quiz</option>
                        <option value="activity">Activity</option>
                      </Select>
                    </FormField>
                    <FormField label="Status">
                      <Select value={activityForm.publish_status}
                        onChange={(e) => setActivityForm((p) => ({ ...p, publish_status: e.target.value }))}>
                        <option value="draft">Draft</option>
                        <option value="published">Published</option>
                        <option value="archived">Archived</option>
                      </Select>
                    </FormField>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <FormField label="Max Score">
                      <Input type="number" min={1} value={activityForm.max_score}
                        onChange={(e) => setActivityForm((p) => ({ ...p, max_score: e.target.value }))}
                        placeholder="100" />
                    </FormField>
                    <FormField label="Due Date">
                      <Input type="datetime-local" value={activityForm.due_at}
                        onChange={(e) => setActivityForm((p) => ({ ...p, due_at: e.target.value }))} />
                    </FormField>
                  </div>
                  <FormField label="Linked Exam ID (optional)">
                    <Input value={activityForm.exam_id}
                      onChange={(e) => setActivityForm((p) => ({ ...p, exam_id: e.target.value }))}
                      placeholder="Leave blank if none" />
                  </FormField>
                  <PrimaryBtn type="submit" disabled={busyAction === 'activity'} accent="emerald" className="w-full">
                    {busyAction === 'activity' ? 'Saving…' : '+ Save Activity'}
                  </PrimaryBtn>
                </form>

                {/* Activity list */}
                <div className="mt-4 max-h-64 space-y-2 overflow-auto pr-1">
                  {activities.length ? activities.map((item) => (
                    <div key={item.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-semibold text-slate-800 leading-tight">{item.title}</p>
                        <div className="flex flex-shrink-0 gap-1">
                          <ActivityBadge type={item.activity_type} />
                          <StatusBadge status={item.publish_status} />
                        </div>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-slate-500">
                        <span>Exam: {item.exam_id || 'none'}</span>
                        <span>Submissions: {item.submission_count || 0}</span>
                        {item.due_at && <span>Due: {new Date(item.due_at).toLocaleDateString()}</span>}
                      </div>
                    </div>
                  )) : <EmptyState message="No activities posted yet." />}
                </div>
              </div>
            </article>

            {/* ── ANNOUNCEMENTS ──────────────────────── */}
            <article className="flex flex-col rounded-2xl border border-slate-200 bg-white shadow-panel">
              <div className="border-b border-slate-100 px-5 py-4">
                <SectionHeader icon={<BellIcon />} title="Announcements" accent="amber" />
              </div>

              <div className="flex-1 overflow-auto p-5">
                {/* Post form */}
                <form onSubmit={onPostAnnouncement} className="space-y-2.5">
                  <FormField label="Title">
                    <Input required value={announcementForm.title}
                      onChange={(e) => setAnnouncementForm((p) => ({ ...p, title: e.target.value }))}
                      placeholder="Announcement title" />
                  </FormField>
                  <FormField label="Details">
                    <Textarea required value={announcementForm.body}
                      onChange={(e) => setAnnouncementForm((p) => ({ ...p, body: e.target.value }))}
                      placeholder="Write the announcement body…"
                      className="h-20" />
                  </FormField>
                  <PrimaryBtn type="submit" disabled={busyAction === 'announcement'} accent="amber" className="w-full">
                    {busyAction === 'announcement' ? 'Posting…' : '📢 Post Announcement'}
                  </PrimaryBtn>
                </form>

                {/* Announcement feed */}
                <div className="mt-4 max-h-64 space-y-2 overflow-auto pr-1">
                  {announcements.length ? announcements.map((item) => (
                    <div key={item.id} className="rounded-xl border-l-4 border-amber-400 bg-amber-50 px-3 py-2.5">
                      <p className="text-sm font-semibold text-slate-800">{item.title}</p>
                      <p className="mt-1 text-xs text-slate-600 leading-relaxed">{item.body}</p>
                      <p className="mt-1.5 text-[11px] text-slate-400">
                        {item.created_at ? new Date(item.created_at).toLocaleString() : ''}
                      </p>
                    </div>
                  )) : <EmptyState message="No announcements yet." />}
                </div>
              </div>
            </article>
          </div>

          {/* ── SCAN CENTER (collapsible) ─────────────── */}
          {hasScanCenter && (
            <div className="space-y-2">
              <CollapseToggle
                open={scanOpen}
                onToggle={() => setScanOpen((v) => !v)}
                label={
                  <span className="flex items-center gap-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-slate-700 to-slate-900 text-white">
                      <ScanIcon />
                    </span>
                    <span>Scan Center</span>
                    <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                      {scan.exams?.length || 0} templates
                    </span>
                  </span>
                }
              />

              {scanOpen && (
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-panel">
                  {scan.error && (
                    <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{scan.error}</div>
                  )}
                  <div className="grid gap-5 xl:grid-cols-3">

                    {/* Create exam template */}
                    <div className="space-y-1">
                      <div className="mb-3 flex items-center gap-2">
                        <SectionHeader icon={<DocIcon />} title="Create Exam Template" accent="violet" />
                      </div>
                      <form onSubmit={scan.onCreateExam} className="space-y-3">
                        <FormField label="Upload Exam PDF (optional)">
                          <input type="file" accept="application/pdf,.pdf" onChange={scan.onExamPdfUpload}
                            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none file:mr-3 file:rounded-lg file:border-0 file:bg-brand-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-brand-700" />
                          {scan.pdfImportStatus && (
                            <p className="mt-1 text-xs text-slate-500">{scan.pdfImportStatus}</p>
                          )}
                        </FormField>
                        <FormField label="Course / Exam Title">
                          <Input required value={scan.examForm?.title || ''}
                            onChange={(e) => scan.setExamForm((p) => ({ ...p, title: e.target.value }))}
                            placeholder="e.g. Midterm Exam — CS101" />
                        </FormField>
                        <FormField label="Total Items">
                          <Input required type="number" min={1} max={200} value={scan.examForm?.total_items || ''}
                            onChange={(e) => scan.onTotalItemsChange(e.target.value)} placeholder="50" />
                        </FormField>
                        <FormField label="Answer Key">
                          <Textarea required ref={scan.answerKeyRef} value={scan.answerKeyDisplay || ''}
                            onChange={() => {}} onKeyDown={scan.onAnswerKeyKeyDown} onPaste={scan.onAnswerKeyPaste}
                            className="h-24 font-mono" placeholder="A" />
                        </FormField>
                        <PrimaryBtn type="submit" disabled={scan.busy} accent="blue" className="w-full">
                          Save Exam
                        </PrimaryBtn>
                      </form>
                    </div>

                    {/* Scanner controls */}
                    <div className="space-y-1">
                      <div className="mb-3">
                        <SectionHeader icon={<ScanIconLg />} title="Scanner Controls" accent="slate" />
                      </div>
                      <form onSubmit={scan.onScan} className="space-y-3">
                        <p className="text-xs text-slate-500 leading-relaxed">
                          Starts a scan job via PHP API, which forwards to the local Python scan controller.
                        </p>
                        <FormField label="Exam Template">
                          <Select required value={scan.scanRequest?.exam_id || ''}
                            onChange={(e) => scan.setScanRequest({ exam_id: e.target.value })}>
                            <option value="">Select exam template</option>
                            {(scan.exams || []).map((exam) => (
                              <option key={exam.id} value={exam.id}>{exam.title}</option>
                            ))}
                          </Select>
                        </FormField>
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                          <div className="flex items-center gap-2">
                            <span className={`h-2 w-2 rounded-full flex-shrink-0 ${scan.scanner?.scanner?.connected ? 'bg-emerald-500' : 'bg-amber-400 animate-pulse'}`} />
                            <span className={`text-xs font-semibold ${scan.scanner?.scanner?.connected ? 'text-emerald-700' : 'text-amber-700'}`}>
                              {scan.scanner?.scanner?.connected ? 'Scanner Ready' : 'Waiting for device…'}
                            </span>
                          </div>
                          <p className="mt-1 text-[11px] text-slate-500">Transport: {scan.scanner?.transport || 'n/a'}</p>
                        </div>
                        <PrimaryBtn type="submit" disabled={scan.busy || !scan.scanRequest?.exam_id} accent="slate" className="w-full">
                          Start Scan Job
                        </PrimaryBtn>
                      </form>
                    </div>

                    {/* Manual submission */}
                    <div className="space-y-1">
                      <div className="mb-3">
                        <SectionHeader icon={<PenIcon />} title="Manual Submission" accent="emerald" />
                      </div>
                      <form onSubmit={scan.onGrade} className="space-y-3">
                        <FormField label="Exam Template">
                          <Select required value={scan.gradeForm?.exam_id || ''}
                            onChange={(e) => scan.setGradeForm((p) => ({ ...p, exam_id: e.target.value }))}>
                            <option value="">Select exam template</option>
                            {(scan.exams || []).map((exam) => (
                              <option key={exam.id} value={exam.id}>{exam.title}</option>
                            ))}
                          </Select>
                        </FormField>
                        <FormField label="Student Code">
                          <Input required value={scan.gradeForm?.student_code || ''}
                            onChange={(e) => scan.setGradeForm((p) => ({ ...p, student_code: e.target.value }))}
                            placeholder="2021-00001" />
                        </FormField>
                        <FormField label="Answers">
                          <Textarea required ref={scan.gradeAnswersRef} value={scan.gradeAnswersDisplay || ''}
                            onChange={() => {}} onKeyDown={scan.onGradeAnswersKeyDown} onPaste={scan.onGradeAnswersPaste}
                            className="h-24 font-mono" placeholder="A" />
                        </FormField>
                        <PrimaryBtn type="submit" disabled={scan.busy || !scan.gradeForm?.exam_id} accent="emerald" className="w-full">
                          Grade Submission
                        </PrimaryBtn>
                      </form>
                    </div>
                  </div>

                  {/* Latest exam + last result */}
                  {(scan.latestExam || scan.lastResult) && (
                    <div className="mt-5 grid gap-4 border-t border-slate-100 pt-5 xl:grid-cols-2">
                      {scan.latestExam && (
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Latest Template</p>
                          <p className="mt-1 text-sm font-semibold text-slate-800">{scan.latestExam.title}</p>
                          <p className="mt-0.5 text-xs text-slate-500">{scan.latestExam.total_items} items</p>
                        </div>
                      )}
                      {scan.lastResult && (
                        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">Last Result</p>
                          <p className="mt-1 text-sm font-semibold text-slate-800">
                            {scan.lastResult.student_code} — {scan.lastResult.score}/{scan.lastResult.total_items}
                          </p>
                          <p className="mt-0.5 text-xs text-slate-500">{scan.lastResult.exam_title}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── GRADEBOOK STATUS (collapsible) ────────── */}
          <div className="space-y-2">
            <CollapseToggle
              open={gradebookOpen}
              onToggle={() => setGradebookOpen((v) => !v)}
              label={
                <span className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-white">
                    <GradebookIcon />
                  </span>
                  <span>Gradebook Status</span>
                  {gradebook.length > 0 && (
                    <span className="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 uppercase tracking-wide">
                      {gradebook.length} students
                    </span>
                  )}
                  {atRiskStudents.length > 0 && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 uppercase tracking-wide">
                      {atRiskStudents.length} at-risk
                    </span>
                  )}
                </span>
              }
            />

            {gradebookOpen && (
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-panel">
                <p className="mb-4 text-sm text-slate-500">
                  Based on shared submissions data tied to each student code and linked exam activity.
                </p>
                {gradebook.length ? (
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-slate-100">
                          <th className="pb-3 pr-5 text-xs font-semibold uppercase tracking-wide text-slate-500">Student</th>
                          <th className="pb-3 pr-5 text-xs font-semibold uppercase tracking-wide text-slate-500">Code</th>
                          <th className="pb-3 pr-5 text-xs font-semibold uppercase tracking-wide text-slate-500">Completed</th>
                          <th className="pb-3 pr-5 text-xs font-semibold uppercase tracking-wide text-slate-500">Published</th>
                          <th className="pb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Average</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gradebook.map((row) => (
                          <tr key={row.student_id} className="border-b border-slate-50 hover:bg-slate-50">
                            <td className="py-2.5 pr-5 font-semibold text-slate-800">{row.full_name}</td>
                            <td className="py-2.5 pr-5 text-slate-500">{row.student_code}</td>
                            <td className="py-2.5 pr-5 text-slate-700">{row.completed_activities}</td>
                            <td className="py-2.5 pr-5 text-slate-700">{row.published_activities}</td>
                            <td className="py-2.5">
                              <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-bold ${statusBg(row)}`}>
                                {formatPercent(row.average_percent)}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState message="No gradebook rows yet. Enroll students and post exam activities." />
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── LOADING ────────────────────────────────── */}
      {loading && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0" strokeLinecap="round" />
          </svg>
          Loading data…
        </div>
      )}
    </main>
  )
}

/* ═══════════════════════════════════════════════════
   STAT CARD
══════════════════════════════════════════════════════ */
function StatCard({ icon, label, value, sub, accent = 'blue' }) {
  const accents = {
    blue:   { bg: 'bg-blue-50',   icon: 'bg-blue-100 text-blue-600',   val: 'text-blue-700' },
    indigo: { bg: 'bg-indigo-50', icon: 'bg-indigo-100 text-indigo-600', val: 'text-indigo-700' },
    emerald:{ bg: 'bg-emerald-50',icon: 'bg-emerald-100 text-emerald-600', val: 'text-emerald-700' },
    amber:  { bg: 'bg-amber-50',  icon: 'bg-amber-100 text-amber-600',  val: 'text-amber-700' },
    slate:  { bg: 'bg-white',     icon: 'bg-slate-100 text-slate-600',  val: 'text-slate-700' },
  }
  const c = accents[accent] || accents.blue
  return (
    <div className={`rounded-2xl border border-slate-200 ${c.bg} p-4 shadow-sm`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
          <p className={`mt-1.5 text-2xl font-bold ${c.val}`}>{value}</p>
          {sub && <p className="mt-0.5 text-xs text-slate-500 truncate">{sub}</p>}
        </div>
        <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${c.icon}`}>{icon}</div>
      </div>
    </div>
  )
}

/* ─── StatusPill ─────────────────────────────────── */
function StatusPill({ label, ok, okText, failText, count }) {
  if (count !== undefined) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs shadow-sm">
        <span className="text-slate-500 font-medium">{label}:</span>
        <span className="font-bold text-slate-700">{count}</span>
      </div>
    )
  }
  return (
    <div className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs shadow-sm ${ok ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-white'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-slate-300'}`} />
      <span className="text-slate-500 font-medium">{label}:</span>
      <span className={`font-bold ${ok ? 'text-emerald-700' : 'text-slate-500'}`}>{ok ? okText : failText}</span>
    </div>
  )
}

/* ─── Icons ──────────────────────────────────────── */
function UsersIcon()     { return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg> }
function ClipboardIcon() { return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg> }
function BellIcon()      { return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg> }
function ScanIcon()      { return <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/></svg> }
function ScanIconLg()    { return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/></svg> }
function GradebookIcon() { return <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> }
function SubjectIcon()   { return <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg> }
function StudentsIcon()  { return <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg> }
function ActivityIcon()  { return <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> }
function RiskIcon()      { return <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> }
function DocIcon()       { return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> }
function PenIcon()       { return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/></svg> }
