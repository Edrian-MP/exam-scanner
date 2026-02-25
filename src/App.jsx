import { useEffect, useMemo, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { API_BASE, apiGet, apiPost } from './lib/api'
import LmsDashboard from './LmsDashboard'
import useAnswerGrid from './hooks/useAnswerGrid'

const defaultExam = {
  title: '',
  total_items: '',
  answer_key: '',
}

GlobalWorkerOptions.workerSrc = pdfWorkerSrc

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
    bootstrap()
  }, [])

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

  return (
    <LmsDashboard
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
        onCreateExam,
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
  )
}

export default App
