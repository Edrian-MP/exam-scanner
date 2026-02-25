import { useEffect, useMemo, useState } from 'react'
import { apiDelete, apiGet, apiPost } from './lib/api'

/* ─── form defaults ─────────────────────────────────── */
const emptySubjectForm      = { subject_code: '', title: '', term_label: '', description: '' }
const emptyStudentForm      = { student_code: '', full_name: '', email: '' }
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

function CollapseSection({ open, onToggle, header, children }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-6 py-4 text-left transition hover:bg-slate-50"
      >
        <div className="flex items-center gap-3">{header}</div>
        <svg
          className={`h-4 w-4 flex-shrink-0 text-slate-400 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && <div className="border-t border-slate-100">{children}</div>}
    </div>
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
   TAB BAR
═══════════════════════════════════════════════════════ */
function TabBar({ activeTab, tabs, counts, onChange }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-2xl bg-slate-100 p-1.5">
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
function RosterTab({ students, studentForm, setStudentForm, busyAction, onAddStudent, onRemoveStudent, onDeleteSubject }) {
  const a = TAB_META.roster.accent
  return (
    <div className="grid min-h-[520px] divide-y divide-slate-100 xl:grid-cols-[380px_1fr] xl:divide-x xl:divide-y-0">

      {/* LEFT: form */}
      <div className="flex flex-col gap-5 p-6">
        <div>
          <h3 className="text-base font-bold text-slate-800">Enroll a Student</h3>
          <p className="mt-0.5 text-xs text-slate-500">Add students to this subject's class list.</p>
        </div>

        <form onSubmit={onAddStudent} className="flex flex-1 flex-col gap-4">
          <Field label="Student ID / Code">
            <TextInput required value={studentForm.student_code}
              onChange={(e) => setStudentForm((p) => ({ ...p, student_code: e.target.value }))}
              placeholder="e.g. 2021-00142" />
          </Field>
          <Field label="Full Name">
            <TextInput required value={studentForm.full_name}
              onChange={(e) => setStudentForm((p) => ({ ...p, full_name: e.target.value }))}
              placeholder="Juan Dela Cruz" />
          </Field>
          <Field label="Email" hint="optional">
            <TextInput type="email" value={studentForm.email}
              onChange={(e) => setStudentForm((p) => ({ ...p, email: e.target.value }))}
              placeholder="juan@school.edu" />
          </Field>
          <div className="mt-auto pt-2">
            <SubmitBtn disabled={busyAction === 'student'} colorClass={a.btn}>
              {busyAction === 'student' ? <><SpinIcon /> Enrolling…</> : <><PlusIcon /> Enroll Student</>}
            </SubmitBtn>
          </div>
        </form>

        {/* Danger zone */}
        <div className="rounded-xl border border-rose-100 bg-rose-50 p-3.5">
          <p className="text-[11px] font-bold uppercase tracking-widest text-rose-400">Danger Zone</p>
          <p className="mt-1 text-xs text-slate-500">Permanently deletes this subject, roster, and all activities.</p>
          <DangerBtn type="button" onClick={onDeleteSubject} disabled={busyAction === 'delete-subject'} className="mt-2.5">
            <TrashIcon /> Delete Subject
          </DangerBtn>
        </div>
      </div>

      {/* RIGHT: list */}
      <div className="flex flex-col p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-slate-800">Class List</h3>
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${a.badge}`}>
            {students.length} {students.length === 1 ? 'student' : 'students'}
          </span>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto pr-1">
          {students.length ? students.map((s, i) => (
            <div key={s.id}
              className="group flex items-center gap-3.5 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 transition hover:border-slate-200 hover:bg-white hover:shadow-sm"
            >
              <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold ${a.bg} ${a.text}`}>
                {initials(s.full_name)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-800">{s.full_name}</p>
                <p className="text-xs text-slate-400">{s.student_code}{s.email ? ` · ${s.email}` : ''}</p>
              </div>
              <span className="text-xs text-slate-300 tabular-nums">#{i + 1}</span>
              <button type="button" onClick={() => onRemoveStudent(s.id)} disabled={busyAction === `remove-student-${s.id}`}
                className="rounded-lg p-1.5 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-500 disabled:opacity-40"
                aria-label="Remove student"
              >
                <XIcon />
              </button>
            </div>
          )) : (
            <EmptyState icon={<UsersIcon size="lg" />} title="No students enrolled yet" description="Use the form to add your first student." />
          )}
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════
   ACTIVITIES TAB
═══════════════════════════════════════════════════════ */
function ActivitiesTab({ activities, activityForm, setActivityForm, busyAction, onCreateActivity }) {
  const a = TAB_META.activities.accent
  return (
    <div className="grid min-h-[520px] divide-y divide-slate-100 xl:grid-cols-[380px_1fr] xl:divide-x xl:divide-y-0">

      {/* LEFT: form */}
      <div className="flex flex-col gap-5 p-6">
        <div>
          <h3 className="text-base font-bold text-slate-800">New Activity</h3>
          <p className="mt-0.5 text-xs text-slate-500">Create exams, quizzes, or graded activities.</p>
        </div>

        <form onSubmit={onCreateActivity} className="flex flex-1 flex-col gap-4">
          <Field label="Activity Title">
            <TextInput required value={activityForm.title}
              onChange={(e) => setActivityForm((p) => ({ ...p, title: e.target.value }))}
              placeholder="e.g. Midterm Examination" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <SelectInput value={activityForm.activity_type}
                onChange={(e) => setActivityForm((p) => ({ ...p, activity_type: e.target.value }))}>
                <option value="exam">Exam</option>
                <option value="quiz">Quiz</option>
                <option value="activity">Activity</option>
              </SelectInput>
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
          <div className="grid grid-cols-2 gap-3">
            <Field label="Max Score">
              <TextInput type="number" min={1} value={activityForm.max_score}
                onChange={(e) => setActivityForm((p) => ({ ...p, max_score: e.target.value }))}
                placeholder="100" />
            </Field>
            <Field label="Due Date" hint="optional">
              <TextInput type="datetime-local" value={activityForm.due_at}
                onChange={(e) => setActivityForm((p) => ({ ...p, due_at: e.target.value }))} />
            </Field>
          </div>
          <Field label="Linked Exam ID" hint="optional">
            <TextInput value={activityForm.exam_id}
              onChange={(e) => setActivityForm((p) => ({ ...p, exam_id: e.target.value }))}
              placeholder="Leave blank if none" />
          </Field>
          <div className="mt-auto pt-2">
            <SubmitBtn disabled={busyAction === 'activity'} colorClass={a.btn}>
              {busyAction === 'activity' ? <><SpinIcon /> Saving…</> : <><PlusIcon /> Save Activity</>}
            </SubmitBtn>
          </div>
        </form>
      </div>

      {/* RIGHT: list */}
      <div className="flex flex-col p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-slate-800">Activity Board</h3>
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${a.badge}`}>
            {activities.length} {activities.length === 1 ? 'activity' : 'activities'}
          </span>
        </div>

        <div className="flex-1 space-y-2.5 overflow-y-auto pr-1">
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
function AnnouncementsTab({ announcements, announcementForm, setAnnouncementForm, busyAction, onPostAnnouncement }) {
  const a = TAB_META.announcements.accent
  return (
    <div className="grid min-h-[520px] divide-y divide-slate-100 xl:grid-cols-[380px_1fr] xl:divide-x xl:divide-y-0">

      {/* LEFT: form */}
      <div className="flex flex-col gap-5 p-6">
        <div>
          <h3 className="text-base font-bold text-slate-800">Post Announcement</h3>
          <p className="mt-0.5 text-xs text-slate-500">Broadcast updates, reminders, or notes to your class.</p>
        </div>

        <form onSubmit={onPostAnnouncement} className="flex flex-1 flex-col gap-4">
          <Field label="Subject Line">
            <TextInput required value={announcementForm.title}
              onChange={(e) => setAnnouncementForm((p) => ({ ...p, title: e.target.value }))}
              placeholder="e.g. Exam schedule reminder" />
          </Field>
          <Field label="Message Body">
            <TextareaInput required value={announcementForm.body}
              onChange={(e) => setAnnouncementForm((p) => ({ ...p, body: e.target.value }))}
              placeholder="Write the full announcement here…"
              className="h-40" />
          </Field>
          <div className="mt-auto pt-2">
            <SubmitBtn disabled={busyAction === 'announcement'} colorClass={a.btn}>
              {busyAction === 'announcement' ? <><SpinIcon /> Posting…</> : <>📢 Post Announcement</>}
            </SubmitBtn>
          </div>
        </form>
      </div>

      {/* RIGHT: feed */}
      <div className="flex flex-col p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-slate-800">Announcement Feed</h3>
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${a.badge}`}>
            {announcements.length} posted
          </span>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto pr-1">
          {announcements.length ? announcements.map((item, i) => (
            <div key={item.id}
              className="relative overflow-hidden rounded-xl border border-slate-100 bg-white p-4 shadow-sm transition hover:shadow"
            >
              <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl bg-amber-400" />
              <div className="pl-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-bold text-slate-800 leading-snug">{item.title}</p>
                  <span className="flex-shrink-0 text-[11px] font-medium text-slate-400">{relativeTime(item.created_at)}</span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-500 line-clamp-3">{item.body}</p>
                {i === 0 && <Badge className="mt-2 bg-amber-100 text-amber-600">Latest</Badge>}
              </div>
            </div>
          )) : (
            <EmptyState icon={<BellIcon size="lg" />} title="No announcements yet" description="Post your first update to the class." />
          )}
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════
   MAIN DASHBOARD
═══════════════════════════════════════════════════════ */
export default function LmsDashboard({ scanCenter = null }) {
  const scan          = scanCenter || {}
  const hasScanCenter = Boolean(scan.onCreateExam && scan.onScan && scan.onGrade)

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
  const [studentForm, setStudentForm]             = useState(emptyStudentForm)
  const [activityForm, setActivityForm]           = useState(emptyActivityForm)
  const [announcementForm, setAnnouncementForm]   = useState(emptyAnnouncementForm)
  const [activeTab, setActiveTab]                 = useState('roster')
  const [scanOpen, setScanOpen]                   = useState(false)
  const [gradebookOpen, setGradebookOpen]         = useState(false)

  const selectedSubject     = useMemo(() => subjects.find((s) => String(s.id) === String(selectedSubjectId)), [subjects, selectedSubjectId])
  const publishedActivities = useMemo(() => activities.filter((a) => a.publish_status === 'published'), [activities])
  const atRiskStudents      = useMemo(() => gradebook.filter((r) => {
    const p = Number(r.published_activities || 0)
    return p > 0 && (Number(r.completed_activities || 0) < p || Number(r.average_percent || 0) < 75)
  }), [gradebook])

  async function loadSubjects() {
    const res = await apiGet('/lms/subjects')
    setSubjects(res.data || [])
  }

  async function loadSubjectDetails(id) {
    if (!id) return
    const [sR, aR, anR, gR] = await Promise.all([
      apiGet(`/lms/subjects/${id}/students`),
      apiGet(`/lms/subjects/${id}/activities`),
      apiGet(`/lms/subjects/${id}/announcements`),
      apiGet(`/lms/subjects/${id}/gradebook`),
    ])
    setStudents(sR.data || [])
    setActivities(aR.data || [])
    setAnnouncements(anR.data || [])
    setGradebook(gR.data || [])
  }

  useEffect(() => {
    setLoading(true)
    loadSubjects().catch((e) => setError(e.message)).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!selectedSubjectId) return
    setLoading(true)
    setError('')
    loadSubjectDetails(selectedSubjectId).catch((e) => setError(e.message)).finally(() => setLoading(false))
  }, [selectedSubjectId])

  async function onCreateSubject(e) {
    e.preventDefault()
    setBusyAction('subject')
    setError('')
    try {
      await apiPost('/lms/subjects', subjectForm)
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
      await apiDelete(`/lms/subjects/${selectedSubject.id}`)
      setSelectedSubjectId('')
      setStudents([]); setActivities([]); setAnnouncements([]); setGradebook([])
      await loadSubjects()
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  async function onAddStudent(e) {
    e.preventDefault()
    if (!selectedSubjectId) return
    setBusyAction('student')
    try {
      await apiPost(`/lms/subjects/${selectedSubjectId}/students`, studentForm)
      setStudentForm(emptyStudentForm)
      await loadSubjectDetails(selectedSubjectId)
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  async function onRemoveStudent(id) {
    setBusyAction(`remove-student-${id}`)
    try {
      await apiDelete(`/lms/subjects/${selectedSubjectId}/students/${id}`)
      await loadSubjectDetails(selectedSubjectId)
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  async function onCreateActivity(e) {
    e.preventDefault()
    if (!selectedSubjectId) return
    setBusyAction('activity')
    try {
      await apiPost(`/lms/subjects/${selectedSubjectId}/activities`, {
        ...activityForm,
        exam_id: activityForm.exam_id ? Number(activityForm.exam_id) : null,
        max_score: Number(activityForm.max_score || 100),
      })
      setActivityForm(emptyActivityForm)
      await loadSubjectDetails(selectedSubjectId)
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  async function onPostAnnouncement(e) {
    e.preventDefault()
    if (!selectedSubjectId) return
    setBusyAction('announcement')
    try {
      await apiPost(`/lms/subjects/${selectedSubjectId}/announcements`, announcementForm)
      setAnnouncementForm(emptyAnnouncementForm)
      await loadSubjectDetails(selectedSubjectId)
    } catch (err) { setError(err.message) } finally { setBusyAction('') }
  }

  /* ── render ─────────────────────────────────────────── */
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

      {/* HERO */}
      <section className="relative overflow-hidden rounded-2xl border border-slate-200/80 bg-white/90 shadow-panel backdrop-blur">
        <div className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-sky-400 via-brand-500 to-violet-500" />
        <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-start sm:justify-between sm:p-8">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span className="text-[11px] font-bold uppercase tracking-widest text-emerald-700">Educator LMS</span>
            </div>
            <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Classroom Command</h1>
            <p className="mt-1.5 max-w-md text-sm text-slate-500">Manage subjects, enroll students, post activities, and run exam scans — all in one place.</p>
          </div>
          {hasScanCenter && (
            <div className="flex flex-wrap gap-2 sm:flex-col sm:items-end">
              <StatusPill label="Backend"  ok={scan.health?.ok} okText="Online"      failText="Offline"  />
              <StatusPill label="Database" ok={scan.health?.db} okText="MySQL Ready" failText="Check DB" />
              <StatusPill count={scan.exams?.length || 0} label="Templates" />
            </div>
          )}
        </div>
      </section>

      {/* ERROR */}
      {error && (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <svg className="mt-0.5 h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          {error}
        </div>
      )}

      {/* SUBJECT BAR */}
      <section className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setSubjectsPanelOpen((v) => !v)}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 hover:shadow"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          {subjectsPanelOpen ? 'Close Subjects' : 'Switch Subject'}
        </button>

        {selectedSubject ? (
          <div className="flex items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5">
            <span className="text-xs font-bold uppercase tracking-widest text-brand-500">{selectedSubject.subject_code}</span>
            <span className="h-3.5 w-px bg-brand-200" />
            <span className="text-sm font-semibold text-brand-800">{selectedSubject.title}</span>
            {selectedSubject.term_label && (
              <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold text-brand-600">{selectedSubject.term_label}</span>
            )}
          </div>
        ) : (
          <p className="text-sm text-slate-400">No subject selected — open the panel to choose one.</p>
        )}

        {loading && (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
            <SpinIcon /> Loading…
          </span>
        )}
      </section>

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
                <form onSubmit={onCreateSubject} className="grid gap-3 sm:grid-cols-2">
                  <Field label="Subject Code"><TextInput required value={subjectForm.subject_code} onChange={(e) => setSubjectForm((p) => ({ ...p, subject_code: e.target.value }))} placeholder="CS101" /></Field>
                  <Field label="Title"><TextInput required value={subjectForm.title} onChange={(e) => setSubjectForm((p) => ({ ...p, title: e.target.value }))} placeholder="Course title" /></Field>
                  <Field label="Term" hint="optional"><TextInput value={subjectForm.term_label} onChange={(e) => setSubjectForm((p) => ({ ...p, term_label: e.target.value }))} placeholder="AY 2024–25 Sem 2" /></Field>
                  <Field label="Description" hint="optional"><TextInput value={subjectForm.description} onChange={(e) => setSubjectForm((p) => ({ ...p, description: e.target.value }))} placeholder="Short description" /></Field>
                  <div className="col-span-full flex gap-2">
                    <SubmitBtn disabled={busyAction === 'subject'} colorClass="bg-brand-600 hover:bg-brand-700" className="w-auto px-5">
                      {busyAction === 'subject' ? 'Creating…' : 'Create Subject'}
                    </SubmitBtn>
                    <GhostBtn type="button" onClick={() => setShowSubjectForm(false)}>Cancel</GhostBtn>
                  </div>
                </form>
              ) : (
                <button type="button" onClick={() => setShowSubjectForm(true)}
                  className="inline-flex items-center gap-2 rounded-xl border border-dashed border-brand-300 bg-brand-50 px-4 py-2.5 text-sm font-semibold text-brand-700 transition hover:bg-brand-100">
                  <PlusIcon /> Add New Subject
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* STAT CARDS */}
      <section className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={<SubjectIcon size="md" />}   label="Active Subject"        value={selectedSubject?.subject_code || '—'} sub={selectedSubject?.title} accent="sky" />
        <StatCard icon={<UsersIcon size="md" />}     label="Enrolled Students"     value={students.length}                                                      accent="violet" />
        <StatCard icon={<ClipboardIcon size="md" />} label="Published Activities"  value={publishedActivities.length}                                           accent="emerald" />
        <StatCard icon={<RiskIcon size="md" />}      label="At-Risk Students"      value={atRiskStudents.length}                                                accent={atRiskStudents.length > 0 ? 'amber' : 'slate'} />
      </section>

      {/* MAIN CONTENT */}
      {selectedSubject && (
        <div className="mt-6 space-y-5">

          {/* TABBED PANEL */}
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-panel">
            {/* Tab bar header */}
            <div className="flex items-center border-b border-slate-100 bg-slate-50/60 px-5 py-3">
              <TabBar
                activeTab={activeTab}
                tabs={['roster', 'activities', 'announcements']}
                counts={{ roster: students.length, activities: activities.length, announcements: announcements.length }}
                onChange={setActiveTab}
              />
            </div>

            {/* Tab content */}
            {activeTab === 'roster' && (
              <RosterTab
                students={students} studentForm={studentForm} setStudentForm={setStudentForm}
                busyAction={busyAction} onAddStudent={onAddStudent}
                onRemoveStudent={onRemoveStudent} onDeleteSubject={onDeleteSubject}
              />
            )}
            {activeTab === 'activities' && (
              <ActivitiesTab
                activities={activities} activityForm={activityForm} setActivityForm={setActivityForm}
                busyAction={busyAction} onCreateActivity={onCreateActivity}
              />
            )}
            {activeTab === 'announcements' && (
              <AnnouncementsTab
                announcements={announcements} announcementForm={announcementForm}
                setAnnouncementForm={setAnnouncementForm} busyAction={busyAction}
                onPostAnnouncement={onPostAnnouncement}
              />
            )}
          </div>

          {/* SCAN CENTER */}
          {hasScanCenter && (
            <CollapseSection open={scanOpen} onToggle={() => setScanOpen((v) => !v)}
              header={<>
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-800 text-white"><ScanIcon /></span>
                <div>
                  <p className="text-sm font-bold text-slate-800">Scan Center</p>
                  <p className="text-[11px] text-slate-400">{scan.exams?.length || 0} exam templates</p>
                </div>
                {scan.scanner?.scanner?.connected
                  ? <Badge className="bg-emerald-100 text-emerald-700">Scanner Ready</Badge>
                  : <Badge className="bg-amber-100 text-amber-600">Scanner Offline</Badge>}
              </>}
            >
              <div className="p-6">
                {scan.error && <div className="mb-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{scan.error}</div>}
                <div className="grid gap-6 xl:grid-cols-3">

                  {/* Create exam */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-100 text-brand-600"><DocIcon /></span>
                      <h3 className="text-sm font-bold text-slate-800">Create Exam Template</h3>
                    </div>
                    <form onSubmit={scan.onCreateExam} className="space-y-3">
                      <Field label="Upload PDF" hint="optional">
                        <input type="file" accept="application/pdf,.pdf" onChange={scan.onExamPdfUpload}
                          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm outline-none file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-brand-700" />
                        {scan.pdfImportStatus && <p className="text-xs text-slate-500">{scan.pdfImportStatus}</p>}
                      </Field>
                      <Field label="Exam Title"><TextInput required value={scan.examForm?.title || ''} onChange={(e) => scan.setExamForm((p) => ({ ...p, title: e.target.value }))} placeholder="Midterm Exam — CS101" /></Field>
                      <Field label="Total Items"><TextInput required type="number" min={1} max={200} value={scan.examForm?.total_items || ''} onChange={(e) => scan.onTotalItemsChange(e.target.value)} placeholder="50" /></Field>
                      <Field label="Answer Key">
                        <TextareaInput required ref={scan.answerKeyRef} value={scan.answerKeyDisplay || ''} onChange={() => {}} onKeyDown={scan.onAnswerKeyKeyDown} onPaste={scan.onAnswerKeyPaste} className="h-24 font-mono text-xs" placeholder="A" />
                      </Field>
                      <SubmitBtn disabled={scan.busy} colorClass="bg-brand-600 hover:bg-brand-700">Save Exam</SubmitBtn>
                    </form>
                  </div>

                  {/* Scanner controls */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 text-slate-600"><ScanIcon /></span>
                      <h3 className="text-sm font-bold text-slate-800">Scanner Controls</h3>
                    </div>
                    <form onSubmit={scan.onScan} className="space-y-3">
                      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3">
                        <span className={`h-2 w-2 flex-shrink-0 rounded-full ${scan.scanner?.scanner?.connected ? 'bg-emerald-500' : 'bg-amber-400 animate-pulse'}`} />
                        <span className={`text-xs font-semibold ${scan.scanner?.scanner?.connected ? 'text-emerald-700' : 'text-amber-700'}`}>
                          {scan.scanner?.scanner?.connected ? 'Device Connected' : 'Waiting for device…'}
                        </span>
                        <span className="ml-auto text-[11px] text-slate-400">{scan.scanner?.transport || 'n/a'}</span>
                      </div>
                      <Field label="Exam Template">
                        <SelectInput required value={scan.scanRequest?.exam_id || ''} onChange={(e) => scan.setScanRequest({ exam_id: e.target.value })}>
                          <option value="">Select exam template</option>
                          {(scan.exams || []).map((ex) => <option key={ex.id} value={ex.id}>{ex.title}</option>)}
                        </SelectInput>
                      </Field>
                      <SubmitBtn disabled={scan.busy || !scan.scanRequest?.exam_id} colorClass="bg-slate-800 hover:bg-slate-700">Start Scan Job</SubmitBtn>
                    </form>
                  </div>

                  {/* Manual submission */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600"><PenIcon /></span>
                      <h3 className="text-sm font-bold text-slate-800">Manual Submission</h3>
                    </div>
                    <form onSubmit={scan.onGrade} className="space-y-3">
                      <Field label="Exam Template">
                        <SelectInput required value={scan.gradeForm?.exam_id || ''} onChange={(e) => scan.setGradeForm((p) => ({ ...p, exam_id: e.target.value }))}>
                          <option value="">Select exam template</option>
                          {(scan.exams || []).map((ex) => <option key={ex.id} value={ex.id}>{ex.title}</option>)}
                        </SelectInput>
                      </Field>
                      <Field label="Student Code"><TextInput required value={scan.gradeForm?.student_code || ''} onChange={(e) => scan.setGradeForm((p) => ({ ...p, student_code: e.target.value }))} placeholder="2021-00001" /></Field>
                      <Field label="Answers">
                        <TextareaInput required ref={scan.gradeAnswersRef} value={scan.gradeAnswersDisplay || ''} onChange={() => {}} onKeyDown={scan.onGradeAnswersKeyDown} onPaste={scan.onGradeAnswersPaste} className="h-24 font-mono text-xs" placeholder="A" />
                      </Field>
                      <SubmitBtn disabled={scan.busy || !scan.gradeForm?.exam_id} colorClass="bg-emerald-600 hover:bg-emerald-700">Grade Submission</SubmitBtn>
                    </form>
                  </div>
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
                        <p className="mt-1.5 text-sm font-bold text-slate-800">{scan.lastResult.student_code} — {scan.lastResult.score}/{scan.lastResult.total_items}</p>
                        <p className="mt-0.5 text-xs text-slate-500">{scan.lastResult.exam_title}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </CollapseSection>
          )}

          {/* GRADEBOOK */}
          <CollapseSection open={gradebookOpen} onToggle={() => setGradebookOpen((v) => !v)}
            header={<>
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white"><GradebookIcon /></span>
              <div>
                <p className="text-sm font-bold text-slate-800">Gradebook</p>
                <p className="text-[11px] text-slate-400">Submissions tied to student codes</p>
              </div>
              {gradebook.length > 0 && <Badge className="bg-emerald-100 text-emerald-700">{gradebook.length} students</Badge>}
              {atRiskStudents.length > 0 && <Badge className="bg-amber-100 text-amber-700">{atRiskStudents.length} at-risk</Badge>}
            </>}
          >
            <div className="p-6">
              {gradebook.length ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100">
                        {['Student', 'Code', 'Completed', 'Published', 'Average'].map((h) => (
                          <th key={h} className="pb-3 pr-6 text-left text-[11px] font-bold uppercase tracking-widest text-slate-400">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {gradebook.map((row) => (
                        <tr key={row.student_id} className="border-b border-slate-50 transition hover:bg-slate-50">
                          <td className="py-3 pr-6">
                            <div className="flex items-center gap-2.5">
                              <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-bold text-slate-500">{initials(row.full_name)}</div>
                              <span className="font-semibold text-slate-800">{row.full_name}</span>
                            </div>
                          </td>
                          <td className="py-3 pr-6 font-mono text-xs text-slate-500">{row.student_code}</td>
                          <td className="py-3 pr-6 text-slate-700">{row.completed_activities}</td>
                          <td className="py-3 pr-6 text-slate-700">{row.published_activities}</td>
                          <td className="py-3">
                            <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-bold ${gradeBg(row)}`}>{formatPercent(row.average_percent)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState icon={<GradebookIcon size="lg" />} title="No gradebook data yet" description="Enroll students and post exam activities to see grades here." />
              )}
            </div>
          </CollapseSection>

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
