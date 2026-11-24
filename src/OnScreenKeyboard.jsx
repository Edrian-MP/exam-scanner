import { useEffect, useRef, useState } from 'react'
import { useOSKContext } from './hooks/useOSK'

/* ── Key layout constants ──────────────────────────────────────── */
const QWERTY_NUM_ROW = ['1','2','3','4','5','6','7','8','9','0']
const QWERTY_ROW0 = ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P']
const QWERTY_ROW1 = ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L']
const QWERTY_ROW2 = ['Z', 'X', 'C', 'V', 'B', 'N', 'M']

const NUM_ROWS = [
  ['7', '8', '9'],
  ['4', '5', '6'],
  ['1', '2', '3'],
  ['.', '0', '⌫'],
]

/* ── Shared key base styles ────────────────────────────────────── */
const BASE =
  'flex items-center justify-center rounded-lg font-semibold select-none touch-manipulation transition-[background-color,transform] duration-75 active:scale-95 cursor-pointer'

const LETTER_KEY = `${BASE} bg-slate-600 hover:bg-slate-500 active:bg-slate-400 text-white h-11 flex-1 text-sm`
const MOD_KEY    = `${BASE} bg-slate-700 hover:bg-slate-600 active:bg-slate-500 text-slate-200 h-11 text-sm`
const DONE_KEY   = `${BASE} bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-400 text-white h-11 px-5 text-sm font-bold flex-none`
const SHIFT_ON   = `${BASE} bg-brand-600 hover:bg-brand-500 active:bg-brand-400 text-white h-11 w-16 text-base flex-none`
const SHIFT_OFF  = `${MOD_KEY} w-16 text-base flex-none`

const NUM_KEY    = `${BASE} bg-slate-600 hover:bg-slate-500 active:bg-slate-400 text-white h-full w-full text-xl font-bold`
const NUM_MOD    = `${BASE} bg-slate-700 hover:bg-slate-600 active:bg-slate-500 text-slate-200 h-full w-full text-xl font-bold`

/* ── QWERTY Keyboard ───────────────────────────────────────────── */
function QwertyKeyboard({ onKey, onBackspace, onEnter, onDone }) {
  const [shifted, setShifted] = useState(false)

  function handleLetter(k) {
    onKey(shifted ? k.toUpperCase() : k.toLowerCase())
    if (shifted) setShifted(false)
  }

  // Long-press backspace clears all
  const backspacePressRef = useRef(null)
  function startBackspace() {
    onBackspace()
    backspacePressRef.current = setTimeout(() => {
      backspacePressRef.current = setInterval(onBackspace, 60)
    }, 500)
  }
  function stopBackspace() {
    clearTimeout(backspacePressRef.current)
    clearInterval(backspacePressRef.current)
  }

  return (
    <div className="flex flex-col gap-1.5 w-full max-w-4xl mx-auto">
      {/* Number row: 1–0 (not affected by Shift) */}
      <div className="flex gap-1">
        {QWERTY_NUM_ROW.map((k) => (
          <button key={k} type="button" className={LETTER_KEY}
            onPointerDown={(e) => { e.preventDefault(); onKey(k) }}>
            {k}
          </button>
        ))}
      </div>
      {/* Row 0: Q–P + backspace */}
      <div className="flex gap-1">
        {QWERTY_ROW0.map((k) => (
          <button key={k} type="button" className={LETTER_KEY}
            onPointerDown={(e) => { e.preventDefault(); handleLetter(k) }}>
            {shifted ? k : k.toLowerCase()}
          </button>
        ))}
        <button
          type="button"
          className={`${MOD_KEY} w-14 flex-none`}
          onPointerDown={(e) => { e.preventDefault(); startBackspace() }}
          onPointerUp={stopBackspace}
          onPointerLeave={stopBackspace}
        >
          ⌫
        </button>
      </div>

      {/* Row 1: A–L + enter — slightly indented */}
      <div className="flex gap-1 px-[3%]">
        {QWERTY_ROW1.map((k) => (
          <button key={k} type="button" className={LETTER_KEY}
            onPointerDown={(e) => { e.preventDefault(); handleLetter(k) }}>
            {shifted ? k : k.toLowerCase()}
          </button>
        ))}
        <button type="button" className={`${MOD_KEY} w-14 flex-none text-base`}
          onPointerDown={(e) => { e.preventDefault(); onEnter() }}>
          ↵
        </button>
      </div>

      {/* Row 2: Shift + Z–M + Shift */}
      <div className="flex gap-1">
        <button type="button" className={shifted ? SHIFT_ON : SHIFT_OFF}
          onPointerDown={(e) => { e.preventDefault(); setShifted((v) => !v) }}>
          ⇧
        </button>
        {QWERTY_ROW2.map((k) => (
          <button key={k} type="button" className={LETTER_KEY}
            onPointerDown={(e) => { e.preventDefault(); handleLetter(k) }}>
            {shifted ? k : k.toLowerCase()}
          </button>
        ))}
        <button type="button" className={shifted ? SHIFT_ON : SHIFT_OFF}
          onPointerDown={(e) => { e.preventDefault(); setShifted((v) => !v) }}>
          ⇧
        </button>
      </div>

      {/* Row 3: @ · space · Done */}
      <div className="flex gap-1">
        <button type="button" className={`${MOD_KEY} w-12 flex-none`}
          onPointerDown={(e) => { e.preventDefault(); onKey('@') }}>
          @
        </button>
        <button type="button" className={`${MOD_KEY} w-12 flex-none`}
          onPointerDown={(e) => { e.preventDefault(); onKey('.') }}>
          .
        </button>
        <button type="button" className={`${LETTER_KEY} flex-[5] text-xs tracking-widest`}
          onPointerDown={(e) => { e.preventDefault(); onKey(' ') }}>
          SPACE
        </button>
        <button type="button" className={DONE_KEY}
          onPointerDown={(e) => { e.preventDefault(); onDone() }}>
          Done
        </button>
      </div>
    </div>
  )
}

/* ── Numeric Pad ───────────────────────────────────────────────── */
function NumericPad({ onKey, onBackspace, onDone }) {
  const backspacePressRef = useRef(null)
  function startBackspace() {
    onBackspace()
    backspacePressRef.current = setTimeout(() => {
      backspacePressRef.current = setInterval(onBackspace, 80)
    }, 500)
  }
  function stopBackspace() {
    clearTimeout(backspacePressRef.current)
    clearInterval(backspacePressRef.current)
  }

  // Flat key list for the 3-col section: 7-9, 4-6, 1-3, . 0 ⌫
  const KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '⌫']

  return (
    <div
      className="mx-auto grid max-w-[340px] gap-1.5"
      style={{ gridTemplateColumns: '1fr 1fr 1fr 3.5rem', gridTemplateRows: 'repeat(4, 3.25rem)' }}
    >
      {/* First 3 keys (row 1, cols 1-3) */}
      {KEYS.slice(0, 3).map((k) => (
        <button key={k} type="button" className={NUM_KEY}
          onPointerDown={(e) => { e.preventDefault(); onKey(k) }}>
          {k}
        </button>
      ))}

      {/* Done — tall button spanning all 4 rows in the rightmost column */}
      <button
        type="button"
        className={`${BASE} row-span-4 col-start-4 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-400 text-white text-sm font-bold tracking-widest`}
        // style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
        onPointerDown={(e) => { e.preventDefault(); onDone() }}
      >
        Done
      </button>

      {/* Remaining 9 keys (rows 2-4, cols 1-3) */}
      {KEYS.slice(3).map((k) =>
        k === '⌫' ? (
          <button
            key={k} type="button" className={NUM_MOD}
            onPointerDown={(e) => { e.preventDefault(); startBackspace() }}
            onPointerUp={stopBackspace}
            onPointerLeave={stopBackspace}
          >
            {k}
          </button>
        ) : (
          <button key={k} type="button" className={NUM_KEY}
            onPointerDown={(e) => { e.preventDefault(); onKey(k) }}>
            {k}
          </button>
        )
      )}
    </div>
  )
}

/* ── Root keyboard component ───────────────────────────────────── */
export default function OnScreenKeyboard() {
  const ctx = useOSKContext()
  const containerRef = useRef(null)
  const { enabled, visible, keyboardType, toggleOSK, hideOSK, pressKey, pressBackspace, pressEnter, activeElRef, keyboardRef } = ctx

  // Dismiss when tapping outside the keyboard (but not on another input)
  useEffect(() => {
    if (!visible) return
    function onPointerDown(e) {
      if (!containerRef.current) return
      if (containerRef.current.contains(e.target)) return
      const tag = e.target.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      hideOSK()
    }
    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => document.removeEventListener('pointerdown', onPointerDown, { capture: true })
  }, [visible, hideOSK])

  function handleDone() {
    const el = activeElRef.current
    hideOSK()
    el?.blur()
  }

  return (
    <div
      ref={containerRef}
      className={`fixed bottom-0 left-0 right-0 z-[200] transition-transform duration-300 ease-out ${
        visible ? 'translate-y-0' : 'translate-y-full'
      }`}
    >
      <button
        type="button"
        aria-label="On-screen keyboard"
        aria-pressed={enabled}
        aria-controls="exam-screen-keyboard"
        onPointerDown={(event) => event.preventDefault()}
        onClick={toggleOSK}
        className={`absolute bottom-full left-3 mb-3 flex min-h-11 items-center gap-2 rounded-xl border px-3 text-sm font-semibold shadow-sm focus-visible:ring-2 focus-visible:ring-sky-500 ${
          enabled ? 'border-sky-500 bg-sky-700 text-white' : 'border-slate-200 bg-white text-slate-700'
        }`}
      >
        <span aria-hidden="true" className="text-lg leading-none">⌨</span>
        {enabled ? 'Keyboard on' : 'Keyboard'}
      </button>
      <div
        id="exam-screen-keyboard"
        ref={keyboardRef}
        inert={!visible}
        aria-hidden={!visible}
        className="border-t border-slate-700 bg-slate-800 px-3 pt-3 pb-5 shadow-[0_-4px_24px_rgba(0,0,0,0.35)]"
        onPointerDown={(event) => event.preventDefault()}
      >
        {keyboardType === 'numeric' ? (
          <NumericPad
            onKey={pressKey}
            onBackspace={pressBackspace}
            onDone={handleDone}
          />
        ) : (
          <QwertyKeyboard
            onKey={pressKey}
            onBackspace={pressBackspace}
            onEnter={pressEnter}
            onDone={handleDone}
          />
        )}
      </div>
    </div>
  )
}
