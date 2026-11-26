const answerKey = ['A', 'C', 'B', 'D', 'A', 'B', 'C', 'D', 'B', 'A']
const studentNames = [
  ['Alex', 'Sample'], ['Casey', 'Sample'], ['Morgan', 'Sample'],
  ['Riley', 'Sample'], ['Taylor', 'Sample'],
]

const classes = [
  { id: 1, subject_code: 'MATH 101', title: 'General Mathematics', term_label: 'Section A', exam: 'Quarterly Exam', students: 5 },
  { id: 2, subject_code: 'SCI 102', title: 'Earth and Life Science', term_label: 'Section B', exam: 'Earth Science Quiz', students: 4 },
  { id: 3, subject_code: 'ICT 103', title: 'Introduction to Computing', term_label: 'Section C', exam: 'Computing Fundamentals', students: 3 },
].map(({ exam, students, ...subject }) => {
  const activity = {
    id: subject.id * 10, exam_id: subject.id * 100, exam_code: `90010${subject.id}`,
    title: exam, activity_type: 'exam', max_score: answerKey.length,
    grading_period: 'Q1', publish_status: 'published', submission_count: students - 1,
  }
  const roster = studentNames.slice(0, students).map(([given_name, surname], index) => ({
    id: subject.id * 1000 + index, student_code: `90${subject.id}00${index + 1}`, given_name, surname,
  }))
  const results = roster.map(({ id, ...student }, index) => {
    const submitted = index < students - 1
    const answers = submitted ? answerKey.map((answer, item) => (
      item >= answerKey.length - index * 2 ? (answer === 'A' ? 'B' : 'A') : answer
    )) : null
    return {
      ...student, student_id: id, answers,
      score: submitted ? answers.filter((answer, item) => answer === answerKey[item]).length : null,
      submitted_at: submitted ? '2026-11-20T02:00:00Z' : null,
    }
  })
  return {
    subject: { ...subject, student_count: students, activity_count: 1, published_activity_count: 1 },
    roster,
    activity,
    exam: {
      id: activity.exam_id, exam_id: activity.exam_id, title: exam,
      activity_id: activity.id, exam_code: activity.exam_code, publish_status: 'published',
      total_items: answerKey.length, answer_key: answerKey, results,
    },
  }
})

export const demoExams = classes.map(({ exam }) => exam)
export const previewMessage = 'Sample preview. Open the live app to change records.'

export async function apiGet(path) {
  const route = path.split('?')[0]
  if (route === '/lms/subjects') return { data: classes.map(({ subject }) => subject) }

  const [, id, resource] = route.match(/^\/lms\/subjects\/(\d+)\/(students|activities|exam-results)$/) || []
  const sample = classes.find(({ subject }) => String(subject.id) === id)
  if (!sample) throw new Error('This sample view is unavailable.')
  if (resource === 'students') return { data: sample.roster }
  if (resource === 'activities') return { data: [sample.activity] }
  return { data: { exams: [sample.exam] } }
}

async function rejectWrite() {
  throw new Error(previewMessage)
}

export { rejectWrite as apiDelete, rejectWrite as apiPost, rejectWrite as apiPut }
