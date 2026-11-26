import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import LmsDashboard from '../src/LmsDashboard.jsx'
import '../src/index.css'
import './preview.css'
import { demoExams, previewMessage } from './demo-api.js'

const liveUrl = 'https://exam-scanner.onrender.com/'
const educator = { id: 1 }

function drawSheet(answers, studentCode, examCode) {
  const canvas = document.createElement('canvas')
  canvas.width = 520
  canvas.height = 620
  const pen = canvas.getContext('2d')
  if (!pen) return null

  pen.fillStyle = '#fff'
  pen.fillRect(0, 0, canvas.width, canvas.height)
  pen.fillStyle = '#0f172a'
  pen.strokeStyle = '#0f172a'
  pen.lineWidth = 2
  pen.strokeRect(18, 18, 484, 584)
  pen.font = 'bold 23px sans-serif'
  pen.fillText('SAMPLE ANSWER SHEET', 42, 64)
  pen.font = '15px monospace'
  pen.fillText(`Student ${studentCode}     Exam ${examCode}`, 42, 98)
  pen.font = '16px monospace'
  for (const [index, answer] of answers.entries()) {
    const y = 144 + index * 44
    pen.fillText(String(index + 1).padStart(2, '0'), 50, y + 5)
    for (const [choiceIndex, choice] of [...'ABCD'].entries()) {
      const x = 137 + choiceIndex * 78
      pen.beginPath()
      pen.arc(x, y, 13, 0, 2 * Math.PI)
      pen.stroke()
      if (answer === choice) pen.fill()
      else pen.fillText(choice, x - 5, y + 5)
    }
  }
  return canvas.toDataURL('image/jpeg', 0.8).split(',')[1]
}

function Preview() {
  const [session, setSession] = useState(null)
  const [sheets, setSheets] = useState([])
  const [notice, setNotice] = useState('')

  function startScan(mode, template) {
    const exam = demoExams.find(({ id }) => id === (template?.id || session?.examId)) || demoExams[0]
    const count = mode === 'single' ? 1 : 2
    setNotice('')
    setSheets(exam.results.slice(0, count).map((student, index) => {
      const rawAnswers = student.answers.map((answer, i) => index === 1 && i === 0 ? '' : answer)
      return {
        id: student.student_id, sheet_index: index + 1, student_code: student.student_code,
        student_name: `${student.given_name} ${student.surname}`,
        exam_code: exam.exam_code, activity_title: exam.title,
        score: rawAnswers.filter((answer, i) => answer === exam.answer_key[i]).length,
        max_score: exam.total_items, raw_answers: rawAnswers,
        status: index === 1 ? 'flagged' : 'ok',
        flag_reasons: index === 1 ? ['Item 1 has no marked answer'] : [],
        scan_image: drawSheet(rawAnswers, student.student_code, exam.exam_code),
      }
    }))
    setSession({ session_id: 'sample-review', status: 'review', mode, examId: exam.id })
  }

  function finishDemo(message) {
    setSession(null)
    setSheets([])
    setNotice(message)
  }

  function previewOnly(event) {
    event?.preventDefault?.()
    setNotice(previewMessage)
  }

  return (
    <>
      <header className="preview-header">
        <div className="preview-header-inner">
          <div className="preview-brand">
            <span className="preview-symbol" aria-hidden="true">ES</span>
            <div>
              <p className="preview-name">Exam Scanner</p>
              <p className="preview-label">Interactive preview</p>
            </div>
          </div>
          <a className="preview-live" href={liveUrl} target="_blank" rel="noopener noreferrer">Open live app</a>
        </div>
      </header>
      <div className="preview-intro">
        <h1>Educator dashboard</h1>
        <p>Explore sample classes, exam results, and simulated answer-sheet scans.</p>
        {notice && <p className="preview-notice" role="status">{notice}</p>}
      </div>
      <LmsDashboard educator={educator} scanCenter={{
        preview: true,
        scanner: { scanner: { connected: true } },
        exams: demoExams,
        scanSession: session,
        stagedSheets: sheets,
        onCreateExam: previewOnly,
        onScan: previewOnly,
        onGrade: previewOnly,
        onStartBatchScan: (template) => startScan('batch', template),
        onStartSingleScan: (template) => startScan('single', template),
        onDiscardSession: () => finishDemo('Sample scan cleared.'),
        onCommitSession: () => finishDemo('Sample scan review complete.'),
        onUpdateStagedSheet: (updated) => setSheets((current) => current.map((sheet) => (
          sheet.id === updated.id ? updated : sheet
        ))),
      }} />
    </>
  )
}

createRoot(document.getElementById('root')).render(<Preview />)
