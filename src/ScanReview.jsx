import { useState } from 'react'

const LETTERS = ['A', 'B', 'C', 'D']
const ANSWER_GRID_STYLE = {
  gridTemplateRows: 'repeat(5, minmax(2.25rem, auto))',
  gridAutoFlow: 'column',
  gridAutoColumns: 'minmax(4.25rem, 1fr)',
}
const ANSWER_EDIT_GRID_STYLE = {
  gridTemplateRows: 'repeat(5, minmax(2.5rem, auto))',
  gridAutoFlow: 'column',
  gridAutoColumns: 'minmax(5rem, 1fr)',
}

function Badge({ children, className = '' }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${className}`}>
      {children}
    </span>
  )
}

function GhostBtn({ children, className = '', ...props }) {
  return (
    <button
      className={`inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50 hover:border-slate-300 disabled:opacity-40 ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

/* ── View modal (read-only) ─────────────────────────────────────────────────── */
function ViewModal({ sheet, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="relative w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <p className="text-sm font-bold text-slate-800">
              Sheet #{sheet.sheet_index} — {sheet.student_name ?? sheet.student_code ?? '—'}
            </p>
            <p className="text-xs text-slate-500">{sheet.activity_title ?? `Exam code ${sheet.exam_code}`}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none">&times;</button>
        </div>

        {sheet.scan_image && (
          <div className="border-b border-slate-100 p-4 flex justify-center">
            <img
              src={`data:image/jpeg;base64,${sheet.scan_image}`}
              alt="Scanned sheet"
              className="max-h-48 rounded-lg border border-slate-200 object-contain"
            />
          </div>
        )}

        <div className="p-5">
          <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">
            Score: {sheet.score ?? '—'}/{sheet.max_score ?? '—'}
          </p>
          {sheet.raw_answers?.length > 0 ? (
            <div className="grid gap-1.5 overflow-x-auto pb-1" style={ANSWER_GRID_STYLE}>
              {sheet.raw_answers.map((ans, i) => (
                <div key={i} className="flex min-w-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-1.5 py-1.5">
                  <span className="w-6 shrink-0 text-right font-mono text-[10px] font-semibold text-slate-400">{i + 1}.</span>
                  <span className={`font-mono text-sm font-bold ${ans ? 'text-slate-700' : 'text-slate-300'}`}>
                    {ans || '—'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-400">No answers recorded.</p>
          )}
        </div>

        <div className="border-t border-slate-100 px-5 py-3 flex justify-end">
          <GhostBtn onClick={onClose}>Close</GhostBtn>
        </div>
      </div>
    </div>
  )
}

/* ── Fix modal (editable) ───────────────────────────────────────────────────── */
function FixModal({ sheet, answerKeyMap, onSave, onClose }) {
  const itemCount = Number(sheet.max_score || 0) || sheet.raw_answers?.length || 30
  const [studentCode, setStudentCode] = useState(sheet.student_code ?? '')
  const [examCode, setExamCode] = useState(sheet.exam_code ?? '')
  const [answers, setAnswers] = useState(() => {
    const base = Array.from({ length: itemCount }, (_, i) => sheet.raw_answers?.[i] ?? '')
    return base
  })

  const keyArr = answerKeyMap[examCode] ?? []
  const scoringKey = keyArr.slice(0, itemCount)
  const score = answers.reduce((acc, ans, i) => {
    if (ans && scoringKey[i] && ans === scoringKey[i]) return acc + 1
    return acc
  }, 0)
  const maxScore = itemCount

  function handleSave() {
    onSave({
      ...sheet,
      student_code: studentCode.trim(),
      exam_code: examCode.trim(),
      raw_answers: answers,
      score,
      max_score: maxScore,
      status: 'ok',
      flag_reasons: [],
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="relative w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <p className="text-sm font-bold text-slate-800">Fix Sheet #{sheet.sheet_index}</p>
            {sheet.flag_reasons?.length > 0 && (
              <p className="mt-0.5 text-xs text-amber-700">{sheet.flag_reasons.join(' · ')}</p>
            )}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none">&times;</button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          {sheet.scan_image && (
            <div className="flex justify-center">
              <img
                src={`data:image/jpeg;base64,${sheet.scan_image}`}
                alt="Scanned sheet"
                className="max-h-36 rounded-lg border border-slate-200 object-contain"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="block text-[11px] font-bold uppercase tracking-widest text-slate-400">Student Code</label>
              <input
                value={studentCode}
                onChange={(e) => setStudentCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                maxLength={6}
                placeholder="000000"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-800 shadow-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-[11px] font-bold uppercase tracking-widest text-slate-400">Exam Code</label>
              <input
                value={examCode}
                onChange={(e) => setExamCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                maxLength={6}
                placeholder="000000"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-800 shadow-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
              />
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Answers</p>
              <p className="text-xs font-semibold text-slate-600">
                Score: <span className="text-emerald-700">{score}</span>/{maxScore}
              </p>
            </div>
            <div className="grid gap-1.5 overflow-x-auto pb-1" style={ANSWER_EDIT_GRID_STYLE}>
              {answers.map((ans, i) => (
                <div key={i} className="flex min-w-0 items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-1.5 py-1.5">
                  <span className="w-6 shrink-0 text-right font-mono text-[10px] font-semibold text-slate-400">{i + 1}.</span>
                  <select
                    value={ans}
                    onChange={(e) => setAnswers((prev) => {
                      const next = [...prev]
                      next[i] = e.target.value
                      return next
                    })}
                    className="w-full rounded-md border border-slate-200 bg-white py-0.5 text-center text-xs font-mono font-bold text-slate-700 outline-none focus:border-emerald-400"
                  >
                    <option value="">—</option>
                    {LETTERS.map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="border-t border-slate-100 px-5 py-3 flex items-center justify-between gap-3">
          <GhostBtn onClick={onClose}>Cancel</GhostBtn>
          <button
            onClick={handleSave}
            disabled={!studentCode || !examCode}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Mark as OK &amp; Save
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Main ScanReview component ──────────────────────────────────────────────── */
export default function ScanReview({
  sessionId,
  sheets = [],
  busy = false,
  onCommit,
  onDiscard,
  onUpdateSheet,
}) {
  const [viewSheet, setViewSheet] = useState(null)
  const [fixSheet, setFixSheet] = useState(null)
  const [commitSummary, setCommitSummary] = useState(null)

  // Build a lookup: exam_code → answer_key array (from raw_answers of ok sheets won't help;
  // the key is embedded in each sheet's `activity_title` context — we expose what we have)
  const answerKeyMap = {}  // populated if sheets include answer key data (future extension)

  const okSheets      = sheets.filter((s) => s.status === 'ok')
  const flaggedSheets = sheets.filter((s) => s.status === 'flagged')

  async function handleCommit() {
    const payload = sheets.map((s) => ({
      id:            s.id,
      student_code:  s.student_code,
      exam_code:     s.exam_code,
      final_answers: s.raw_answers ?? [],
      score:         s.score,
      include:       s.status === 'ok',
    }))
    const result = await onCommit(payload)
    if (result) {
      setCommitSummary(result)
    }
  }

  if (commitSummary) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-600">
          <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <p className="text-lg font-bold text-slate-800">Batch committed</p>
        <p className="mt-1 text-sm text-slate-500">
          {commitSummary.committed} submitted · {commitSummary.skipped} skipped
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 shadow-sm">
          Total: <strong>{sheets.length}</strong>
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> OK: {okSheets.length}
        </span>
        {flaggedSheets.length > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Flagged: {flaggedSheets.length}
          </span>
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-[11px] font-bold uppercase tracking-widest text-slate-400">
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">Student</th>
              <th className="px-4 py-3">Exam</th>
              <th className="px-4 py-3">Score</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sheets.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-xs text-slate-400">
                  No sheets scanned yet.
                </td>
              </tr>
            )}
            {sheets.map((sheet) => (
              <tr key={sheet.id} className={sheet.status === 'flagged' ? 'scan-review-row-flagged bg-amber-50/40' : ''}>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{sheet.sheet_index}</td>
                <td className="px-4 py-2.5">
                  {sheet.student_name ? (
                    <span className="scan-review-student-name font-semibold text-slate-800">{sheet.student_name}</span>
                  ) : sheet.student_code ? (
                    <span className="scan-review-student-code font-mono text-slate-600">{sheet.student_code}</span>
                  ) : (
                    <span className="text-slate-400 italic">Not found</span>
                  )}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-500">
                  {sheet.exam_code ?? '—'}
                </td>
                <td className="px-4 py-2.5 text-xs font-semibold text-slate-700">
                  {sheet.score != null ? `${sheet.score}/${sheet.max_score}` : '—'}
                </td>
                <td className="px-4 py-2.5">
                  {sheet.status === 'ok' ? (
                    <Badge className="bg-emerald-100 text-emerald-700">OK</Badge>
                  ) : (
                    <Badge className="bg-amber-100 text-amber-700">Flagged</Badge>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex justify-end gap-1.5">
                    <GhostBtn onClick={() => setViewSheet(sheet)}>View</GhostBtn>
                    {sheet.status === 'flagged' && (
                      <GhostBtn
                        onClick={() => setFixSheet(sheet)}
                        className="border-amber-200 text-amber-700 hover:bg-amber-50"
                      >
                        Fix
                      </GhostBtn>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <button
          type="button"
          onClick={onDiscard}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-xl border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-600 shadow-sm transition hover:bg-rose-50 disabled:opacity-40"
        >
          Discard Session
        </button>
        <button
          type="button"
          onClick={handleCommit}
          disabled={busy || okSheets.length === 0}
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Committing…' : `Commit All OK (${okSheets.length})`}
        </button>
      </div>

      {/* Modals */}
      {viewSheet && (
        <ViewModal sheet={viewSheet} onClose={() => setViewSheet(null)} />
      )}
      {fixSheet && (
        <FixModal
          sheet={fixSheet}
          answerKeyMap={answerKeyMap}
          onSave={(updated) => {
            onUpdateSheet(updated)
            setFixSheet(null)
          }}
          onClose={() => setFixSheet(null)}
        />
      )}
    </div>
  )
}
