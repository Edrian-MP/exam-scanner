import { useEffect, useMemo, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { API_BASE, apiGet, apiPost } from './lib/api'
import LmsDashboard from './LmsDashboard'
import LoginPage from './LoginPage'
import AccountSettingsPage from './AccountSettingsPage'
import useAnswerGrid from './hooks/useAnswerGrid'

const defaultExam = {
  title: '',
  total_items: '',
  answer_key: '',
}

GlobalWorkerOptions.workerSrc = pdfWorkerSrc
const EDUCATOR_STORAGE_KEY = 'exam_scanner.educator'

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
  const [educator, setEducator] = useState(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [showAccountSettings, setShowAccountSettings] = useState(false)
  const [accountBusy, setAccountBusy] = useState(false)
  const [accountError, setAccountError] = useState('')
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

  const answerKeyGrid = useAnswerGrid({
    items: answerKeyItems,
    setItems: setAnswerKeyItems,
    ref: answerKeyRef,
    normalizeItem,
  })
  const gradeAnswersGrid = useAnswerGrid({
    items: gradeAnswerItems,
    setItems: setGradeAnswerItems,
    ref: gradeAnswersRef,
    normalizeItem,
  })

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
    try {
      const raw = localStorage.getItem(EDUCATOR_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (parsed && parsed.id) {
        setEducator(parsed)
      }
    } catch {
      // Ignore malformed local storage data.
    }
  }, [])

  useEffect(() => {
    if (!educator) return
    bootstrap()
  }, [educator])

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

  function onClearExamDraft() {
    setExamForm(defaultExam)
    setAnswerKeyItems(createEmptyItems(defaultExam.total_items))
    setPdfImportStatus('')
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

  async function onLogin(credentials) {
    setAuthBusy(true)
    setAuthError('')
    try {
      const result = await apiPost('/auth/login', credentials)
      const nextEducator = result?.data?.educator || null
      if (!nextEducator?.id) {
        throw new Error('Invalid login response from server.')
      }
      localStorage.setItem(EDUCATOR_STORAGE_KEY, JSON.stringify(nextEducator))
      setEducator(nextEducator)
    } catch (err) {
      setAuthError(err.message)
    } finally {
      setAuthBusy(false)
    }
  }

  async function onSignUp(payload) {
    setAuthBusy(true)
    setAuthError('')
    try {
      const result = await apiPost('/auth/signup', payload)
      const nextEducator = result?.data?.educator || null
      if (!nextEducator?.id) {
        throw new Error('Invalid signup response from server.')
      }
      localStorage.setItem(EDUCATOR_STORAGE_KEY, JSON.stringify(nextEducator))
      setEducator(nextEducator)
    } catch (err) {
      setAuthError(err.message)
    } finally {
      setAuthBusy(false)
    }
  }

  function onLogout() {
    localStorage.removeItem(EDUCATOR_STORAGE_KEY)
    setEducator(null)
    setShowAccountSettings(false)
    setLastResult(null)
    setError('')
  }

  async function onSaveAccountSettings(payload) {
    if (!educator?.id) return
    setAccountBusy(true)
    setAccountError('')
    try {
      const result = await apiPost('/auth/account', {
        educator_id: educator.id,
        ...payload,
      })
      const nextEducator = result?.data?.educator || null
      if (!nextEducator?.id) {
        throw new Error('Invalid account update response.')
      }
      localStorage.setItem(EDUCATOR_STORAGE_KEY, JSON.stringify(nextEducator))
      setEducator(nextEducator)
      setShowAccountSettings(false)
    } catch (err) {
      setAccountError(err.message)
    } finally {
      setAccountBusy(false)
    }
  }

  if (!educator) {
    return (
      <LoginPage
        apiBase={API_BASE}
        onLogin={onLogin}
        onSignUp={onSignUp}
        busy={authBusy}
        error={authError}
      />
    )
  }

  if (showAccountSettings) {
    return (
      <AccountSettingsPage
        educator={educator}
        busy={accountBusy}
        error={accountError}
        onSave={onSaveAccountSettings}
        onCancel={() => {
          setAccountError('')
          setShowAccountSettings(false)
        }}
      />
    )
  }

  const educatorInitials = (educator.surname || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || '?'

  return (
    <>
      <div className="mx-auto max-w-7xl px-4 pb-0 pt-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 shadow-sm backdrop-blur">
          <div className="min-w-0 flex items-center gap-3">
            {educator.profile_photo_data ? (
              <img
                src={educator.profile_photo_data}
                alt="Educator avatar"
                className="h-10 w-10 rounded-xl border border-slate-200 object-cover"
              />
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-slate-100 text-xs font-bold text-slate-600">
                {educatorInitials}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Logged in educator</p>
              <p className="truncate text-sm font-semibold text-slate-800">{educator.surname} - {educator.email}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setAccountError('')
                setShowAccountSettings(true)
              }}
              className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50 hover:border-slate-300"
            >
              Account Settings
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50 hover:border-slate-300"
            >
              Logout
            </button>
          </div>
        </div>
      </div>
      <LmsDashboard
        educator={educator}
        scanCenter={{
          apiBase: API_BASE,
          health,
          scanner,
          exams,
          examForm,
          setExamForm,
          onTotalItemsChange,
          answerKeyRef,
          answerKeyDisplay: answerKeyGrid.display,
          onAnswerKeyKeyDown: answerKeyGrid.onKeyDown,
          onAnswerKeyPaste: answerKeyGrid.onPaste,
          pdfImportStatus,
          onExamPdfUpload,
          onClearExamDraft,
          onCreateExam,
          onRefreshExams: bootstrap,
          scanRequest,
          setScanRequest,
          onScan,
          gradeForm,
          setGradeForm,
          selectedGradeExam,
          gradeAnswersRef,
          gradeAnswersDisplay: gradeAnswersGrid.display,
          onGradeAnswersKeyDown: gradeAnswersGrid.onKeyDown,
          onGradeAnswersPaste: gradeAnswersGrid.onPaste,
          onGrade,
          latestExam,
          lastResult,
          busy,
          error,
        }}
      />
    </>
  )
}

export default App
