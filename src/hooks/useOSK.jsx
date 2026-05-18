import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

const OSKContext = createContext(null)

// Shared native input value setter — triggers React's onChange synthetic event
const nativeValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  'value',
).set

function applyValue(el, newValue) {
  nativeValueSetter.call(el, newValue)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

export function OSKProvider({ children }) {
  const [visible, setVisible] = useState(false)
  const [keyboardType, setKeyboardType] = useState('qwerty')
  const activeElRef          = useRef(null)
  const paddedNodeRef        = useRef(null)  // scroll container that was padded
  const paddedNodeRestoreRef = useRef('')    // its original paddingBottom (in ref, not on DOM node)
  const bodyPadRestoreRef    = useRef('')    // document.body's original paddingBottom
  const hideTimeoutRef       = useRef(null)  // pending hideOSK cleanup timer

  function findScrollParent(el) {
    let node = el.parentElement
    while (node && node !== document.body) {
      const oy = window.getComputedStyle(node).overflowY
      if (oy === 'auto' || oy === 'scroll') return node
      node = node.parentElement
    }
    return null
  }

  const showOSK = useCallback((el, type) => {
    // Cancel any pending hideOSK cleanup so the ref isn't nulled when a new
    // cell is tapped immediately after committing the previous one
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
      hideTimeoutRef.current = null
    }
    activeElRef.current = el
    setKeyboardType(type)
    setVisible(true)
    // After the 300ms slide-up transition, push content up so the active element
    // is visible above the keyboard — works on every page including Login
    setTimeout(() => {
      try {
        const KBD_HEIGHT = type === 'numeric' ? 258 : 232
        const CLEARANCE = 24

        const scrollParent = findScrollParent(el)

        // Always pad document.body — makes the page scrollable even when there
        // is no inner scroll container (e.g. Login, AccountSettings)
        bodyPadRestoreRef.current = document.body.style.paddingBottom
        document.body.style.paddingBottom = (KBD_HEIGHT + CLEARANCE) + 'px'

        // Also pad the nearest scroll container (e.g. gradebook table)
        // Store restore value in a ref, NOT on the DOM node, so it survives
        // React re-renders that replace the DOM element
        if (scrollParent) {
          paddedNodeRef.current = scrollParent
          paddedNodeRestoreRef.current = scrollParent.style.paddingBottom
          scrollParent.style.paddingBottom = (KBD_HEIGHT + CLEARANCE) + 'px'
        }

        // Scroll after layout recalculates with new padding
        requestAnimationFrame(() => {
          const elRect = el.getBoundingClientRect()
          const safeBottom = window.innerHeight - KBD_HEIGHT - CLEARANCE
          if (elRect.bottom > safeBottom) {
            const delta = elRect.bottom - safeBottom
            if (scrollParent) scrollParent.scrollBy({ top: delta, behavior: 'smooth' })
            window.scrollBy({ top: delta, behavior: 'smooth' })
          }
        })
      } catch (_) {}
    }, 320)
  }, [])

  const hideOSK = useCallback(() => {
    setVisible(false)
    // Restore all padding and clear refs after the slide-down animation
    hideTimeoutRef.current = setTimeout(() => {
      try {
        // Restore scroll container padding (value stored in ref, not on DOM node,
        // so this survives React re-renders that replace the DOM element)
        const node = paddedNodeRef.current
        if (node) {
          node.style.paddingBottom = paddedNodeRestoreRef.current
          requestAnimationFrame(() => {
            try {
              const max = Math.max(0, node.scrollHeight - node.clientHeight)
              if (node.scrollTop > max) node.scrollTop = max
            } catch (_) {}
          })
        }
        paddedNodeRef.current = null
        paddedNodeRestoreRef.current = ''

        // Restore document.body padding and clamp window scroll
        document.body.style.paddingBottom = bodyPadRestoreRef.current
        bodyPadRestoreRef.current = ''
        requestAnimationFrame(() => {
          try {
            const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
            if (window.scrollY > max) window.scrollTo({ top: max })
          } catch (_) {}
        })
      } catch (_) {}
      activeElRef.current = null
      hideTimeoutRef.current = null
    }, 350)
  }, [])

  // Global listener — triggers OSK for ANY input/textarea on ANY page,
  // so LoginPage, AccountSettingsPage, and raw <input> elements need no changes.
  const OSK_SKIP_TYPES = new Set([
    'file', 'datetime-local', 'checkbox', 'radio',
    'range', 'color', 'submit', 'reset', 'button', 'image', 'hidden',
  ])
  useEffect(() => {
    function handleGlobalFocus(e) {
      const el = e.target
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return
      if (el.readOnly || el.disabled) return
      if (OSK_SKIP_TYPES.has(el.type)) return
      const isNumeric =
        el.type === 'number' || el.inputMode === 'numeric' || el.inputMode === 'decimal'
      showOSK(el, isNumeric ? 'numeric' : 'qwerty')
    }
    document.addEventListener('focusin', handleGlobalFocus)
    return () => document.removeEventListener('focusin', handleGlobalFocus)
  }, [showOSK])

  const pressKey = useCallback((char) => {
    const el = activeElRef.current
    if (!el) return
    // Use selectionStart/End for text inputs; fall back to append for number inputs
    let s, e
    try {
      s = el.selectionStart ?? el.value.length
      e = el.selectionEnd ?? el.value.length
    } catch (_) {
      s = e = el.value.length
    }
    const next = el.value.slice(0, s) + char + el.value.slice(e)
    applyValue(el, next)
    requestAnimationFrame(() => {
      try { el.setSelectionRange(s + char.length, s + char.length) } catch (_) {}
    })
  }, [])

  const pressBackspace = useCallback(() => {
    const el = activeElRef.current
    if (!el) return
    let s, e
    try {
      s = el.selectionStart ?? el.value.length
      e = el.selectionEnd ?? el.value.length
    } catch (_) {
      s = e = el.value.length
    }
    const next =
      s === e
        ? el.value.slice(0, Math.max(0, s - 1)) + el.value.slice(s)
        : el.value.slice(0, s) + el.value.slice(e)
    applyValue(el, next)
    const newPos = s === e ? Math.max(0, s - 1) : s
    requestAnimationFrame(() => {
      try { el.setSelectionRange(newPos, newPos) } catch (_) {}
    })
  }, [])

  const pressClear = useCallback(() => {
    const el = activeElRef.current
    if (!el) return
    applyValue(el, '')
  }, [])

  const pressEnter = useCallback(() => {
    const el = activeElRef.current
    hideOSK()
    if (!el) return
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        bubbles: true,
        cancelable: true,
      }),
    )
    setTimeout(() => { try { el.blur() } catch (_) {} }, 50)
  }, [hideOSK])

  return (
    <OSKContext.Provider
      value={{
        visible,
        keyboardType,
        activeElRef,
        showOSK,
        hideOSK,
        pressKey,
        pressBackspace,
        pressClear,
        pressEnter,
      }}
    >
      {children}
    </OSKContext.Provider>
  )
}

export function useOSKContext() {
  return useContext(OSKContext)
}

// Used by input components — auto-detects keyboard type from element attributes at focus time
export function useOSK() {
  const ctx = useContext(OSKContext)
  if (!ctx) return {}

  return {
    onFocus(e) {
      const el = e.currentTarget
      if (el.readOnly || el.disabled) return
      if (el.type === 'datetime-local') return
      const isNumeric =
        el.type === 'number' ||
        el.inputMode === 'numeric' ||
        el.inputMode === 'decimal'
      ctx.showOSK(el, isNumeric ? 'numeric' : 'qwerty')
    },
  }
}
