import { useMemo } from 'react'

function getLineIndexFromCursor(ref, display, itemCount) {
  if (itemCount <= 0) return 0
  const el = ref.current
  if (!el) return 0
  const before = display.slice(0, el.selectionStart)
  return Math.min(itemCount - 1, before.split('\n').length - 1)
}

function setCursorToLine(ref, lineIndex, items) {
  const el = ref.current
  if (!el) return
  if (!items.length) return

  const safeLine = Math.max(0, Math.min(lineIndex, items.length - 1))
  let pos = 0
  for (let i = 0; i < safeLine; i += 1) {
    const prefix = `${i + 1}. `
    pos += prefix.length + `${items[i]}`.length + 1
  }

  const targetPrefix = `${safeLine + 1}. `
  pos += targetPrefix.length

  requestAnimationFrame(() => {
    el.setSelectionRange(pos, pos)

    const computedStyle = window.getComputedStyle(el)
    const lineHeight = Number.parseInt(computedStyle.lineHeight, 10) || 20
    const paddingTop = Number.parseInt(computedStyle.paddingTop, 10) || 8

    const lineTop = safeLine * lineHeight + paddingTop
    const lineBottom = lineTop + lineHeight

    const visibleTop = el.scrollTop
    const visibleBottom = el.scrollTop + el.clientHeight

    if (lineBottom > visibleBottom) {
      el.scrollTop = lineBottom - el.clientHeight + lineHeight
    } else if (lineTop < visibleTop) {
      el.scrollTop = lineTop - lineHeight
    }
  })
}

export default function useAnswerGrid({ items, setItems, ref, normalizeItem }) {
  const display = useMemo(() => items.map((val, i) => `${i + 1}. ${val}`).join('\n'), [items])

  function onKeyDown(e) {
    if (!items.length) return
    const { key } = e
    const line = getLineIndexFromCursor(ref, display, items.length)
    const current = items[line] || ''

    if (key === 'ArrowUp') {
      e.preventDefault()
      setCursorToLine(ref, line - 1, items)
      return
    }
    if (key === 'ArrowDown' || key === 'Enter') {
      e.preventDefault()
      setCursorToLine(ref, line + 1, items)
      return
    }
    if (key === 'Backspace' || key === 'Delete') {
      e.preventDefault()
      setItems((prev) => {
        const next = [...prev]
        next[line] = ''
        return next
      })
      setCursorToLine(ref, line, items)
      return
    }
    if (key === '/') {
      e.preventDefault()
      if (/^[A-Z]$/.test(current)) {
        setItems((prev) => {
          const next = [...prev]
          next[line] = `${current}/`
          return next
        })
        setCursorToLine(ref, line, items)
        return
      }
      if (current === '' && line > 0 && /^[A-Z]$/.test(items[line - 1] || '')) {
        setItems((prev) => {
          const next = [...prev]
          next[line - 1] = `${next[line - 1]}/`
          return next
        })
        setCursorToLine(ref, line - 1, items)
        return
      }
      return
    }
    if (/^[a-zA-Z]$/.test(key)) {
      e.preventDefault()
      const upper = key.toUpperCase()
      setItems((prev) => {
        const next = [...prev]
        const lineValue = next[line] || ''
        if (lineValue.endsWith('/')) {
          next[line] = `${lineValue}${upper}`
        } else {
          next[line] = upper
        }
        return next
      })
      setCursorToLine(ref, line + 1, items)
      return
    }
    if (key.length === 1) {
      e.preventDefault()
    }
  }

  function onPaste(e) {
    if (!items.length) return
    e.preventDefault()
    const raw = e.clipboardData.getData('text') || ''
    if (!raw.trim()) return

    const tokens = raw
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\d+\s*[.)-]?\s*/, '').trim())
      .map((line) => normalizeItem(line))
      .filter(Boolean)

    if (!tokens.length) return

    const startLine = getLineIndexFromCursor(ref, display, items.length)
    setItems((prev) => {
      const next = [...prev]
      for (let i = 0; i < tokens.length; i += 1) {
        const idx = startLine + i
        if (idx >= next.length) break
        next[idx] = tokens[i]
      }
      return next
    })
    setCursorToLine(ref, Math.min(startLine + tokens.length, items.length - 1), items)
  }

  return {
    display,
    onKeyDown,
    onPaste,
  }
}
