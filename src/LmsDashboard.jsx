import { useEffect, useMemo, useState } from 'react'
import { apiDelete, apiGet, apiPost } from './lib/api'

const emptySubjectForm = {
  subject_code: '',
  title: '',
  term_label: '',
  description: '',
}

const emptyStudentForm = {
  student_code: '',
  full_name: '',
  email: '',
}

const emptyActivityForm = {
  title: '',
  activity_type: 'exam',
  exam_id: '',
  max_score: 100,
  due_at: '',
  publish_status: 'draft',
}

const emptyAnnouncementForm = {
  title: '',
  body: '',
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'N/A'
  return `${Math.round(Number(value))}%`
}

function statusTone(row) {
  const completed = Number(row.completed_activities || 0)
  const published = Number(row.published_activities || 0)
  const avg = Number(row.average_percent || 0)
  if (published === 0) return 'text-slate-500'
  if (completed < published || avg < 75) return 'text-amber-700'
  if (avg >= 90) return 'text-emerald-700'
  return 'text-brand-700'
}

function scorePercent(score, total) {
  if (!total) return 0
  return Math.round((score / total) * 100)
}

export default function LmsDashboard({
  scanCenter = null,
}) {
  const scan = scanCenter || {}
  const hasScanCenter = Boolean(scan.onCreateExam && scan.onScan && scan.onGrade)
  const [subjects, setSubjects] = useState([])
  const [selectedSubjectId, setSelectedSubjectId] = useState('')
  const [students, setStudents] = useState([])
  const [activities, setActivities] = useState([])
  const [announcements, setAnnouncements] = useState([])
  const [gradebook, setGradebook] = useState([])
  const [subjectForm, setSubjectForm] = useState(emptySubjectForm)
  const [studentForm, setStudentForm] = useState(emptyStudentForm)
  const [activityForm, setActivityForm] = useState(emptyActivityForm)
  const [announcementForm, setAnnouncementForm] = useState(emptyAnnouncementForm)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busyAction, setBusyAction] = useState('')
  const [subjectsPanelOpen, setSubjectsPanelOpen] = useState(false)
  const [showSubjectForm, setShowSubjectForm] = useState(false)

  const selectedSubject = useMemo(
    () => subjects.find((subject) => String(subject.id) === String(selectedSubjectId)) || null,
    [subjects, selectedSubjectId],
  )

  const publishedActivities = useMemo(
    () => activities.filter((item) => item.publish_status === 'published'),
    [activities],
  )

  const atRiskStudents = useMemo(
    () =>
      gradebook.filter((row) => {
        const avg = Number(row.average_percent || 0)
        const completed = Number(row.completed_activities || 0)
        const published = Number(row.published_activities || 0)
        return published > 0 && (avg < 75 || completed < published)
      }),
    [gradebook],
  )

  async function loadSubjects() {
    const response = await apiGet('/lms/subjects')
    const rows = response.data || []
    setSubjects(rows)
    if (rows.length && !rows.some((row) => String(row.id) === String(selectedSubjectId))) {
      setSelectedSubjectId(String(rows[0].id))
    }
    if (!rows.length) {
      setSelectedSubjectId('')
      setStudents([])
      setActivities([])
      setAnnouncements([])
      setGradebook([])
    }
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
    try {
      await loadSubjects()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    bootstrap()
  }, [])

  useEffect(() => {
    if (!selectedSubjectId) return
    setLoading(true)
    setError('')
    loadSubjectDetails(selectedSubjectId)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
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
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyAction('')
    }
  }

  async function onDeleteSubject() {
    if (!selectedSubject) return
    const ok = window.confirm(`Delete subject ${selectedSubject.subject_code}? This removes roster and activities.`)
    if (!ok) return
    setBusyAction('delete-subject')
    setError('')
    try {
      await apiDelete(`/lms/subjects/${selectedSubject.id}`)
      await loadSubjects()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyAction('')
    }
  }

  async function onAddStudent(e) {
    e.preventDefault()
    if (!selectedSubjectId) return
    setBusyAction('student')
    setError('')
    try {
      await apiPost(`/lms/subjects/${selectedSubjectId}/students`, studentForm)
      setStudentForm(emptyStudentForm)
      await loadSubjectDetails(selectedSubjectId)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyAction('')
    }
  }

  async function onRemoveStudent(studentId) {
    if (!selectedSubjectId) return
    setBusyAction(`remove-student-${studentId}`)
    setError('')
    try {
      await apiDelete(`/lms/subjects/${selectedSubjectId}/students/${studentId}`)
      await loadSubjectDetails(selectedSubjectId)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyAction('')
    }
  }

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
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyAction('')
    }
  }

  async function onPostAnnouncement(e) {
    e.preventDefault()
    if (!selectedSubjectId) return
    setBusyAction('announcement')
    setError('')
    try {
      await apiPost(`/lms/subjects/${selectedSubjectId}/announcements`, announcementForm)
      setAnnouncementForm(emptyAnnouncementForm)
      await loadSubjectDetails(selectedSubjectId)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyAction('')
    }
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <section className="rounded-3xl border border-slate-200/80 bg-white/85 p-6 shadow-panel backdrop-blur sm:p-8">
        <p className="inline-flex rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-700">
          Educator LMS Dashboard
        </p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">Classroom Command</h1>
        {hasScanCenter ? (
          <div className="mt-5 border-t border-slate-200 pt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">System Status</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <article>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Backend</p>
                <p className="mt-1 text-sm font-semibold text-ink">{scan.health?.ok ? 'Online' : 'Unknown'}</p>
              </article>
              <article>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Database</p>
                <p className="mt-1 text-sm font-semibold text-ink">{scan.health?.db ? 'MySQL Ready' : 'Check DB'}</p>
              </article>
              <article>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Exam Templates</p>
                <p className="mt-1 text-sm font-semibold text-ink">{scan.exams?.length || 0}</p>
              </article>
            </div>
          </div>
        ) : null}
      </section>

      {error ? (
        <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      ) : null}

      <section className="mt-6 space-y-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setSubjectsPanelOpen(true)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 shadow-panel transition hover:bg-slate-50"
            aria-label="Open subjects panel"
          >
            <span className="sr-only">Open subjects panel</span>
            <span className="flex flex-col gap-1.5">
              <span className="block h-0.5 w-5 rounded bg-slate-700" />
              <span className="block h-0.5 w-5 rounded bg-slate-700" />
              <span className="block h-0.5 w-5 rounded bg-slate-700" />
            </span>
          </button>
          <p className="text-sm text-slate-600">
            Open the side panel to switch subjects or add a classroom.
          </p>
        </div>

        {subjectsPanelOpen ? (
          <div className="fixed inset-0 z-50">
            <button
              type="button"
              aria-label="Close subjects panel"
              onClick={() => setSubjectsPanelOpen(false)}
              className="absolute inset-0 bg-slate-900/35"
            />
            <aside className="absolute left-0 top-0 h-full w-full max-w-sm overflow-y-auto border-r border-slate-200 bg-white p-4 shadow-2xl">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-display text-lg font-semibold">Subjects</h2>
                  <p className="mt-1 text-xs text-slate-500">Choose a classroom for this dashboard.</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowSubjectForm((prev) => !prev)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-600 text-xl font-semibold text-white transition hover:bg-emerald-700"
                    aria-label="Add subject"
                    title="Add subject"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    onClick={() => setSubjectsPanelOpen(false)}
                    className="rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-700 hover:bg-slate-50"
                    aria-label="Close panel"
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="mt-4 space-y-2">
                {subjects.map((subject) => {
                  const selected = String(subject.id) === String(selectedSubjectId)
                  return (
                    <button
                      type="button"
                      key={subject.id}
                      onClick={() => {
                        setSelectedSubjectId(String(subject.id))
                        setSubjectsPanelOpen(false)
                      }}
                      className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                        selected
                          ? 'border-brand-400 bg-brand-50 text-brand-700'
                          : 'border-slate-200 bg-white text-slate-700 hover:border-brand-200 hover:bg-slate-50'
                      }`}
                    >
                      <p className="text-xs font-semibold uppercase tracking-wide">{subject.subject_code}</p>
                      <p className="mt-1 text-sm font-semibold">{subject.title}</p>
                      <p className="mt-1 text-xs opacity-80">
                        {subject.student_count} students • {subject.activity_count} activities
                      </p>
                    </button>
                  )
                })}
                {!subjects.length ? (
                  <p className="rounded-xl border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500">
                    No subjects yet.
                  </p>
                ) : null}
              </div>

              {showSubjectForm ? (
                <form onSubmit={onCreateSubject} className="mt-5 space-y-2 border-t border-slate-200 pt-4">
                  <h3 className="text-sm font-semibold text-slate-700">New Subject</h3>
                  <input
                    required
                    value={subjectForm.subject_code}
                    onChange={(e) => setSubjectForm((prev) => ({ ...prev, subject_code: e.target.value }))}
                    placeholder="Code (e.g. MATH101)"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-brand-500 focus:ring"
                  />
                  <input
                    required
                    value={subjectForm.title}
                    onChange={(e) => setSubjectForm((prev) => ({ ...prev, title: e.target.value }))}
                    placeholder="Subject title"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-brand-500 focus:ring"
                  />
                  <input
                    value={subjectForm.term_label}
                    onChange={(e) => setSubjectForm((prev) => ({ ...prev, term_label: e.target.value }))}
                    placeholder="Term / section"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-brand-500 focus:ring"
                  />
                  <textarea
                    value={subjectForm.description}
                    onChange={(e) => setSubjectForm((prev) => ({ ...prev, description: e.target.value }))}
                    placeholder="Short description"
                    className="h-20 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-brand-500 focus:ring"
                  />
                  <button
                    disabled={busyAction === 'subject'}
                    className="w-full rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
                  >
                    Create Subject
                  </button>
                </form>
              ) : null}
            </aside>
          </div>
        ) : null}
        <div className="space-y-6">
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <article className="rounded-2xl bg-white p-4 shadow-panel">
              <p className="text-xs uppercase tracking-wide text-slate-500">Selected Subject</p>
              <p className="mt-2 text-lg font-semibold text-ink">
                {selectedSubject ? selectedSubject.subject_code : 'Choose Subject'}
              </p>
              <p className="text-xs text-slate-500">{selectedSubject?.title || 'No class selected'}</p>
            </article>
            <article className="rounded-2xl bg-white p-4 shadow-panel">
              <p className="text-xs uppercase tracking-wide text-slate-500">Enrolled Students</p>
              <p className="mt-2 text-lg font-semibold text-ink">{students.length}</p>
            </article>
            <article className="rounded-2xl bg-white p-4 shadow-panel">
              <p className="text-xs uppercase tracking-wide text-slate-500">Published Activities</p>
              <p className="mt-2 text-lg font-semibold text-ink">{publishedActivities.length}</p>
            </article>
            <article className="rounded-2xl bg-white p-4 shadow-panel">
              <p className="text-xs uppercase tracking-wide text-slate-500">At-Risk Students</p>
              <p className="mt-2 text-lg font-semibold text-ink">{atRiskStudents.length}</p>
            </article>
          </section>

          {selectedSubject ? (
            <>
              <section className="grid gap-6 xl:grid-cols-3">
              <article className="rounded-2xl bg-white p-5 shadow-panel xl:col-span-1">
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-xl font-semibold">Roster</h3>
                  <button
                    type="button"
                    onClick={onDeleteSubject}
                    disabled={busyAction === 'delete-subject'}
                    className="rounded-lg border border-rose-300 px-2 py-1 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 disabled:opacity-60"
                  >
                    Delete Subject
                  </button>
                </div>
                <form onSubmit={onAddStudent} className="mt-3 space-y-2">
                  <input
                    required
                    value={studentForm.student_code}
                    onChange={(e) => setStudentForm((prev) => ({ ...prev, student_code: e.target.value }))}
                    placeholder="Student code"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-brand-500 focus:ring"
                  />
                  <input
                    required
                    value={studentForm.full_name}
                    onChange={(e) => setStudentForm((prev) => ({ ...prev, full_name: e.target.value }))}
                    placeholder="Full name"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-brand-500 focus:ring"
                  />
                  <input
                    value={studentForm.email}
                    onChange={(e) => setStudentForm((prev) => ({ ...prev, email: e.target.value }))}
                    placeholder="Email (optional)"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-brand-500 focus:ring"
                  />
                  <button
                    disabled={busyAction === 'student'}
                    className="w-full rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-60"
                  >
                    Add or Update Student
                  </button>
                </form>

                <div className="mt-4 max-h-[300px] space-y-2 overflow-auto pr-1">
                  {students.map((student) => (
                    <div key={student.id} className="rounded-xl border border-slate-200 p-3">
                      <p className="text-sm font-semibold text-ink">{student.full_name}</p>
                      <p className="text-xs text-slate-600">{student.student_code}</p>
                      <div className="mt-2 flex items-center justify-between">
                        <p className="text-xs text-slate-500">{student.email || 'No email'}</p>
                        <button
                          type="button"
                          onClick={() => onRemoveStudent(student.id)}
                          disabled={busyAction === `remove-student-${student.id}`}
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                  {!students.length ? <p className="text-sm text-slate-500">No students enrolled yet.</p> : null}
                </div>
              </article>

              <article className="rounded-2xl bg-white p-5 shadow-panel xl:col-span-1">
                <h3 className="font-display text-xl font-semibold">Activities</h3>
                <form onSubmit={onCreateActivity} className="mt-3 space-y-2">
                  <input
                    required
                    value={activityForm.title}
                    onChange={(e) => setActivityForm((prev) => ({ ...prev, title: e.target.value }))}
                    placeholder="Activity title"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-brand-500 focus:ring"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <select
                      value={activityForm.activity_type}
                      onChange={(e) => setActivityForm((prev) => ({ ...prev, activity_type: e.target.value }))}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-brand-500 focus:ring"
                    >
                      <option value="exam">Exam</option>
                      <option value="quiz">Quiz</option>
                      <option value="activity">Activity</option>
                    </select>
                    <select
                      value={activityForm.publish_status}
                      onChange={(e) => setActivityForm((prev) => ({ ...prev, publish_status: e.target.value }))}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-brand-500 focus:ring"
                    >
                      <option value="draft">Draft</option>
                      <option value="published">Published</option>
                      <option value="closed">Closed</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="number"
                      min={1}
                      value={activityForm.max_score}
                      onChange={(e) => setActivityForm((prev) => ({ ...prev, max_score: e.target.value }))}
                      placeholder="Max score"
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-brand-500 focus:ring"
                    />
                    <input
                      type="datetime-local"
                      value={activityForm.due_at}
                      onChange={(e) => setActivityForm((prev) => ({ ...prev, due_at: e.target.value }))}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-brand-500 focus:ring"
                    />
                  </div>
                  <input
                    value={activityForm.exam_id}
                    onChange={(e) => setActivityForm((prev) => ({ ...prev, exam_id: e.target.value }))}
                    placeholder="Linked exam id (optional)"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-brand-500 focus:ring"
                  />
                  <button
                    disabled={busyAction === 'activity'}
                    className="w-full rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
                  >
                    Save Activity
                  </button>
                </form>

                <div className="mt-4 max-h-[300px] space-y-2 overflow-auto pr-1">
                  {activities.map((item) => (
                    <div key={item.id} className="rounded-xl border border-slate-200 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm font-semibold text-ink">{item.title}</p>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] uppercase tracking-wide text-slate-700">
                          {item.publish_status}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-600">
                        {item.activity_type} â€¢ Exam {item.exam_id || 'none'} â€¢ submissions {item.submission_count}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">Due: {item.due_at || 'No due date'}</p>
                    </div>
                  ))}
                  {!activities.length ? <p className="text-sm text-slate-500">No activities posted yet.</p> : null}
                </div>
              </article>

              <article className="rounded-2xl bg-white p-5 shadow-panel xl:col-span-1">
                <h3 className="font-display text-xl font-semibold">Announcements</h3>
                <form onSubmit={onPostAnnouncement} className="mt-3 space-y-2">
                  <input
                    required
                    value={announcementForm.title}
                    onChange={(e) => setAnnouncementForm((prev) => ({ ...prev, title: e.target.value }))}
                    placeholder="Announcement title"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-brand-500 focus:ring"
                  />
                  <textarea
                    required
                    value={announcementForm.body}
                    onChange={(e) => setAnnouncementForm((prev) => ({ ...prev, body: e.target.value }))}
                    placeholder="Announcement details"
                    className="h-24 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-brand-500 focus:ring"
                  />
                  <button
                    disabled={busyAction === 'announcement'}
                    className="w-full rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600 disabled:opacity-60"
                  >
                    Post Announcement
                  </button>
                </form>

                <div className="mt-4 max-h-[300px] space-y-2 overflow-auto pr-1">
                  {announcements.map((item) => (
                    <div key={item.id} className="rounded-xl border border-slate-200 p-3">
                      <p className="text-sm font-semibold text-ink">{item.title}</p>
                      <p className="mt-1 text-xs text-slate-600">{item.body}</p>
                      <p className="mt-2 text-[11px] text-slate-500">{item.created_at}</p>
                    </div>
                  ))}
                  {!announcements.length ? <p className="text-sm text-slate-500">No announcements yet.</p> : null}
                </div>
              </article>
              </section>

              {hasScanCenter ? (
                <section className="space-y-6">
                  {scan.error ? (
                    <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{scan.error}</div>
                  ) : null}

                  <section className="grid gap-6 xl:grid-cols-3">
                    <form onSubmit={scan.onCreateExam} className="rounded-2xl bg-white p-5 shadow-panel">
                      <h2 className="font-display text-xl font-semibold">Create Exam Template</h2>
                      <div className="mt-4 space-y-3 text-sm">
                        <div>
                          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Upload Exam PDF (optional)
                          </label>
                          <input
                            type="file"
                            accept="application/pdf,.pdf"
                            onChange={scan.onExamPdfUpload}
                            className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-brand-500 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-slate-700 focus:ring"
                          />
                          {scan.pdfImportStatus ? <p className="mt-1 text-xs text-slate-600">{scan.pdfImportStatus}</p> : null}
                        </div>
                        <input
                          required
                          value={scan.examForm?.title || ''}
                          onChange={(e) => scan.setExamForm((prev) => ({ ...prev, title: e.target.value }))}
                          className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-brand-500 focus:ring"
                          placeholder="Course / Exam title"
                        />
                        <input
                          required
                          min={1}
                          max={200}
                          type="number"
                          value={scan.examForm?.total_items || ''}
                          onChange={(e) => scan.onTotalItemsChange(e.target.value)}
                          className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-brand-500 focus:ring"
                          placeholder="Total items"
                        />
                        <textarea
                          required
                          ref={scan.answerKeyRef}
                          value={scan.answerKeyDisplay || ''}
                          onChange={() => {}}
                          onKeyDown={scan.onAnswerKeyKeyDown}
                          onPaste={scan.onAnswerKeyPaste}
                          className="h-28 w-full rounded-xl border border-slate-300 px-3 py-2 font-mono outline-none ring-brand-500 focus:ring"
                          placeholder="A"
                        />
                        <button
                          disabled={scan.busy}
                          className="w-full rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
                        >
                          Save Exam
                        </button>
                      </div>
                    </form>

                    <form onSubmit={scan.onScan} className="rounded-2xl bg-white p-5 shadow-panel">
                      <h2 className="font-display text-xl font-semibold">Scanner Controls</h2>
                      <p className="mt-2 text-sm text-slate-600">
                        Starts a scan job via PHP API, which forwards to the local Python scan controller.
                      </p>
                      <div className="mt-4 space-y-3 text-sm">
                        <select
                          required
                          value={scan.scanRequest?.exam_id || ''}
                          onChange={(e) => scan.setScanRequest({ exam_id: e.target.value })}
                          className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-brand-500 focus:ring"
                        >
                          <option value="">Select exam template</option>
                          {(scan.exams || []).map((exam) => (
                            <option key={exam.id} value={exam.id}>
                              {exam.title}
                            </option>
                          ))}
                        </select>
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                          <p className={scan.scanner?.scanner?.connected ? 'text-emerald-700' : 'animate-pulseSoft text-amber-700'}>
                            Scanner status: {scan.scanner?.scanner?.connected ? 'ready' : 'waiting for device'}
                          </p>
                          <p className="mt-1">Transport: {scan.scanner?.transport || 'n/a'}</p>
                        </div>
                        <button
                          disabled={scan.busy || !scan.scanRequest?.exam_id}
                          className="w-full rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white transition hover:bg-slate-700 disabled:opacity-60"
                        >
                          Start Scan Job
                        </button>
                      </div>
                    </form>

                    <form onSubmit={scan.onGrade} className="rounded-2xl bg-white p-5 shadow-panel">
                      <h2 className="font-display text-xl font-semibold">Manual/Parsed Submission</h2>
                      <div className="mt-4 space-y-3 text-sm">
                        <select
                          required
                          value={scan.gradeForm?.exam_id || ''}
                          onChange={(e) => scan.setGradeForm((prev) => ({ ...prev, exam_id: e.target.value }))}
                          className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-brand-500 focus:ring"
                        >
                          <option value="">Select exam template</option>
                          {(scan.exams || []).map((exam) => (
                            <option key={exam.id} value={exam.id}>
                              {exam.title}
                            </option>
                          ))}
                        </select>
                        <input
                          required
                          value={scan.gradeForm?.student_code || ''}
                          onChange={(e) => scan.setGradeForm((prev) => ({ ...prev, student_code: e.target.value }))}
                          className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-brand-500 focus:ring"
                          placeholder="Student code"
                        />
                        <textarea
                          required
                          ref={scan.gradeAnswersRef}
                          value={scan.gradeAnswersDisplay || ''}
                          onChange={() => {}}
                          onKeyDown={scan.onGradeAnswersKeyDown}
                          onPaste={scan.onGradeAnswersPaste}
                          className="h-28 w-full rounded-xl border border-slate-300 px-3 py-2 font-mono outline-none ring-brand-500 focus:ring"
                          placeholder="A"
                        />
                        <button
                          disabled={scan.busy || !scan.gradeForm?.exam_id}
                          className="w-full rounded-xl bg-emerald-600 px-4 py-2 font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
                        >
                          Grade Submission
                        </button>
                      </div>
                    </form>
                  </section>

                  <section className="grid gap-6 xl:grid-cols-2">
                    <article className="rounded-2xl bg-white p-5 shadow-panel">
                      <h3 className="font-display text-lg font-semibold">Latest Exam Template</h3>
                      {scan.latestExam ? (
                        <div className="mt-3 space-y-1 text-sm text-slate-700">
                          <p>Title: <span className="font-semibold">{scan.latestExam.title}</span></p>
                          <p>Total items: <span className="font-semibold">{scan.latestExam.total_items}</span></p>
                          <p>Created: <span className="font-semibold">{scan.latestExam.created_at}</span></p>
                        </div>
                      ) : (
                        <p className="mt-3 text-sm text-slate-600">No exam templates yet.</p>
                      )}
                    </article>

                    <article className="rounded-2xl bg-white p-5 shadow-panel">
                      <h3 className="font-display text-lg font-semibold">Last API Result</h3>
                      {scan.lastResult?.data?.score !== undefined ? (
                        <div className="mt-3 text-sm text-slate-700">
                          <p>
                            Score: <span className="font-semibold">{scan.lastResult.data.score}</span> / {scan.lastResult.data.total_items}
                          </p>
                          <p>
                            Percent: <span className="font-semibold">{scorePercent(scan.lastResult.data.score, scan.lastResult.data.total_items)}%</span>
                          </p>
                        </div>
                      ) : (
                        <pre className="mt-3 max-h-64 overflow-auto rounded-xl bg-slate-950 p-3 text-xs text-cyan-200">
                          {JSON.stringify(scan.lastResult, null, 2) || 'No recent actions.'}
                        </pre>
                      )}
                    </article>
                  </section>
                </section>
              ) : null}
            </>
          ) : (
            <article className="rounded-2xl bg-white p-5 shadow-panel">
              <h3 className="font-display text-xl font-semibold">No Subject Selected</h3>
              <p className="mt-2 text-sm text-slate-600">
                Create or select a subject to unlock roster management, activity posting, gradebook tracking, and scanning tools.
              </p>
            </article>
          )}

          {selectedSubject ? (
            <section className="rounded-2xl bg-white p-5 shadow-panel">
              <h3 className="font-display text-xl font-semibold">Gradebook Status</h3>
              <p className="mt-1 text-sm text-slate-600">
                Based on shared submissions data tied to each student code and linked exam activity.
              </p>
              <div className="mt-4 overflow-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="pb-2 pr-4">Student</th>
                      <th className="pb-2 pr-4">Code</th>
                      <th className="pb-2 pr-4">Completed</th>
                      <th className="pb-2 pr-4">Published</th>
                      <th className="pb-2 pr-4">Average</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gradebook.map((row) => (
                      <tr key={row.student_id} className="border-t border-slate-200">
                        <td className="py-2 pr-4 font-semibold text-ink">{row.full_name}</td>
                        <td className="py-2 pr-4 text-slate-600">{row.student_code}</td>
                        <td className="py-2 pr-4 text-slate-700">{row.completed_activities}</td>
                        <td className="py-2 pr-4 text-slate-700">{row.published_activities}</td>
                        <td className={`py-2 pr-4 font-semibold ${statusTone(row)}`}>{formatPercent(row.average_percent)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!gradebook.length ? (
                  <p className="mt-3 text-sm text-slate-500">No gradebook rows yet. Enroll students and post exam activities.</p>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      </section>

      {loading ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">Loading data...</div>
      ) : null}
    </main>
  )
}
