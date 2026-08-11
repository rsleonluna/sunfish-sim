import { useEffect, useRef } from 'react'
import type { ControlInput } from '../sim-core/controls.ts'

/**
 * Keyboard helm and sheet.
 *
 * Returns a ref rather than state on purpose: the simulation reads it inside
 * the frame loop, and re-rendering React on every keystroke would be both
 * pointless and jittery.
 *
 * Steering is mapped so the arrow the player presses matches the way the boat
 * turns. That means the key handler flips the sign, because `tiller` in
 * sim-core is the tiller's own position and a real tiller is pushed the
 * opposite way to the turn.
 */
export interface InputRef {
  readonly current: ControlInput
}

const TILLER_RATE = 3
const TILLER_RETURN = 4
const SHEET_RATE = 0.6

export function useKeyboardControls(): InputRef {
  const input = useRef<ControlInput>({ mainsheet: 0.25, tiller: 0 })
  const held = useRef(new Set<string>())

  useEffect(() => {
    const keys = held.current

    const down = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase()
      if (RELEVANT.has(key)) {
        keys.add(key)
        // Stop the arrows scrolling the page out from under the canvas.
        event.preventDefault()
      }
    }
    const up = (event: KeyboardEvent): void => {
      keys.delete(event.key.toLowerCase())
    }
    const blur = (): void => keys.clear()

    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)

    let previous = performance.now()
    let frame = 0

    const tick = (now: number): void => {
      const dt = Math.min((now - previous) / 1000, 0.1)
      previous = now

      let tiller = input.current.tiller
      let mainsheet = input.current.mainsheet

      // Player presses "turn to port"; the tiller goes to starboard to do it.
      const toPort = keys.has('arrowleft') || keys.has('a')
      const toStarboard = keys.has('arrowright') || keys.has('d')

      if (toPort && !toStarboard) tiller += TILLER_RATE * dt
      else if (toStarboard && !toPort) tiller -= TILLER_RATE * dt
      else {
        // Let go and the tiller centres itself, as a loaded one does.
        const decay = TILLER_RETURN * dt
        tiller = Math.abs(tiller) <= decay ? 0 : tiller - Math.sign(tiller) * decay
      }

      if (keys.has('arrowdown') || keys.has('s')) mainsheet += SHEET_RATE * dt
      if (keys.has('arrowup') || keys.has('w')) mainsheet -= SHEET_RATE * dt

      input.current = {
        tiller: Math.max(-1, Math.min(1, tiller)),
        mainsheet: Math.max(0, Math.min(1, mainsheet)),
      }

      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      cancelAnimationFrame(frame)
      keys.clear()
    }
  }, [])

  return input
}

const RELEVANT = new Set([
  'arrowleft',
  'arrowright',
  'arrowup',
  'arrowdown',
  'a',
  'd',
  'w',
  's',
])
