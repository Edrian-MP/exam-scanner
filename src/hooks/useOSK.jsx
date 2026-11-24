import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

const OSKContext = createContext(null)
const textInputTypes = new Set(['text', 'search', 'tel', 'url', 'email', 'password', 'number'])

// Use the native setter so React observes the input event on controlled fields.
function applyValue(el, newValue) {
  const prototype = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, newValue)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function isEditableField(el) {
  const canType = el instanceof HTMLTextAreaElement
    || (el instanceof HTMLInputElement && textInputTypes.has(el.type))
  return canType && !el.readOnly && !el.matches(':disabled') && el.isConnected
}

function findScrollParent(el) {
  let node = el.parentElement
  while (node && node !== document.body) {
    const overflowY = window.getComputedStyle(node).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return node
    node = node.parentElement
  }
  return null
}

export function OSKProvider({ children }) {
  const [enabled, setEnabled] = useState(false)
  const [visible, setVisible] = useState(false)
  const [keyboardType, setKeyboardType] = useState('qwerty')
  const activeElRef = useRef(null)
  const inputModeRef = useRef(null)
  const keyboardRef = useRef(null)
  const paddedNodeRef = useRef(null)
  const layoutTimerRef = useRef(null)

  const restorePadding = useCallback(() => {
    const padded = paddedNodeRef.current
    if (!padded) return
    padded.node.style.paddingBottom = padded.paddingBottom
    paddedNodeRef.current = null
  }, [])

  const releaseField = useCallback(() => {
    const el = activeElRef.current
    if (el) {
      if (inputModeRef.current === null) el.removeAttribute('inputmode')
      else el.setAttribute('inputmode', inputModeRef.current)
    }
    activeElRef.current = null
    inputModeRef.current = null
  }, [])

  const hideOSK = useCallback(() => {
    clearTimeout(layoutTimerRef.current)
    restorePadding()
    releaseField()
    setVisible(false)
  }, [releaseField, restorePadding])

  const showOSK = useCallback((el) => {
    if (!isEditableField(el)) return

    if (activeElRef.current !== el) {
      releaseField()
      activeElRef.current = el
      inputModeRef.current = el.getAttribute('inputmode')
      el.setAttribute('inputmode', 'none')
    }
    const mode = inputModeRef.current
    setKeyboardType(el.type === 'number' || mode === 'numeric' || mode === 'decimal' ? 'numeric' : 'qwerty')
    setVisible(true)

    clearTimeout(layoutTimerRef.current)
    // Let the keyboard finish sliding before measuring the visible space.
    layoutTimerRef.current = setTimeout(() => {
      const keyboard = keyboardRef.current
      if (!keyboard || !el.isConnected || activeElRef.current !== el) return
      const scrollParent = findScrollParent(el)
      const node = scrollParent ?? document.body
      if (paddedNodeRef.current?.node !== node) {
        restorePadding()
        paddedNodeRef.current = { node, paddingBottom: node.style.paddingBottom }
      }

      const keyboardTop = keyboard.getBoundingClientRect().top
      const fieldBottom = el.getBoundingClientRect().bottom
      node.style.paddingBottom = `${Math.max(0, window.innerHeight - keyboardTop) + 200}px`
      if (fieldBottom > keyboardTop) {
        const delta = fieldBottom - keyboardTop * 0.6
        if (scrollParent) scrollParent.scrollBy({ top: delta, behavior: 'smooth' })
        window.scrollBy({ top: delta, behavior: 'smooth' })
      }
    }, 320)
  }, [releaseField, restorePadding])

  function toggleOSK() {
    setEnabled(!enabled)
    if (enabled) hideOSK()
    else showOSK(document.activeElement)
  }

  useEffect(() => {
    if (!enabled) return

    function handleFocus(event) {
      if (isEditableField(event.target)) showOSK(event.target)
      else if (!keyboardRef.current?.parentElement?.contains(event.target)) hideOSK()
    }

    function handlePointer(event) {
      // A field can still have focus after the panel is dismissed.
      if (event.target === document.activeElement && activeElRef.current !== event.target) {
        showOSK(event.target)
      }
    }

    document.addEventListener('focusin', handleFocus)
    document.addEventListener('pointerdown', handlePointer)
    return () => {
      document.removeEventListener('focusin', handleFocus)
      document.removeEventListener('pointerdown', handlePointer)
      clearTimeout(layoutTimerRef.current)
      restorePadding()
      releaseField()
    }
  }, [enabled, hideOSK, releaseField, restorePadding, showOSK])

  const pressKey = useCallback((char) => {
    const el = activeElRef.current
    if (!isEditableField(el)) return
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    applyValue(el, el.value.slice(0, start) + char + el.value.slice(end))
    if (el.selectionStart !== null) {
      requestAnimationFrame(() => el.setSelectionRange(start + char.length, start + char.length))
    }
  }, [])

  const pressBackspace = useCallback(() => {
    const el = activeElRef.current
    if (!isEditableField(el)) return
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    const newPosition = start === end ? Math.max(0, start - 1) : start
    applyValue(el, el.value.slice(0, newPosition) + el.value.slice(end))
    if (el.selectionStart !== null) {
      requestAnimationFrame(() => el.setSelectionRange(newPosition, newPosition))
    }
  }, [])

  const pressEnter = useCallback(() => {
    const el = activeElRef.current
    hideOSK()
    if (!isEditableField(el)) return
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    }))
    el.blur()
  }, [hideOSK])

  return (
    <OSKContext.Provider value={{
      enabled,
      visible,
      keyboardType,
      activeElRef,
      keyboardRef,
      toggleOSK,
      hideOSK,
      pressKey,
      pressBackspace,
      pressEnter,
    }}>
      {children}
    </OSKContext.Provider>
  )
}

export function useOSKContext() {
  return useContext(OSKContext)
}
