import { type JSX, useEffect, useRef } from 'react'
import { toKnots } from '../sim-core/controls.ts'
import type { BoatFrame } from './useBoatSim.ts'

/**
 * Instrument panel, updated straight from the simulation ref.
 *
 * Deliberately writes into DOM nodes rather than going through React state: at
 * 120 Hz the reconciler would cost more than the physics does.
 */
export function Hud({ frame }: { frame: { current: BoatFrame | null } }): JSX.Element {
  const rows = useRef<Record<string, HTMLSpanElement | null>>({})

  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      const current = frame.current
      if (current !== null) {
        const { loads, controls } = current
        const set = (key: string, value: string): void => {
          const node = rows.current[key]
          if (node !== null && node !== undefined && node.textContent !== value) {
            node.textContent = value
          }
        }

        set('speed', `${toKnots(current.speed).toFixed(1)} kn`)
        set('heading', `${degrees(current.heading)}°`)
        set('heel', `${degrees(current.heel)}° ${side(current.heel)}`)
        set('awa', `${degrees(loads.sail.apparentAngle)}° ${side(loads.sail.apparentAngle)}`)
        set('aws', `${toKnots(loads.sail.apparentSpeed).toFixed(1)} kn`)
        set('boom', `${degrees(controls.boomAngle)}° ${side(controls.boomAngle)}`)
        set('rudder', `${degrees(controls.rudderAngle)}°`)
        set('camber', `${(loads.sail.camber * 100).toFixed(1)}%`)
        set(
          'sail',
          loads.sail.fill < 0.15 ? 'luffing' : loads.sail.stalled ? 'stalled' : 'drawing',
        )
        set('drive', `${loads.sail.drive.toFixed(0)} N`)
        set('side', `${loads.sail.sideForce.toFixed(0)} N`)
        set('leeway', `${degrees(leeway(current))}°`)
        set('sailed', `${Math.hypot(current.state.position[0], current.state.position[2]).toFixed(0)} m`)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [frame])

  const cell = (key: string) => (node: HTMLSpanElement | null) => {
    rows.current[key] = node
  }

  return (
    <div className="hud">
      <div className="hud-group">
        <strong>boat</strong>
        <Row label="speed" cell={cell('speed')} />
        <Row label="heading" cell={cell('heading')} />
        <Row label="heel" cell={cell('heel')} />
        <Row label="leeway" cell={cell('leeway')} />
        <Row label="from start" cell={cell('sailed')} />
      </div>

      <div className="hud-group">
        <strong>wind</strong>
        <Row label="apparent" cell={cell('awa')} />
        <Row label="speed" cell={cell('aws')} />
      </div>

      <div className="hud-group">
        <strong>rig</strong>
        <Row label="boom" cell={cell('boom')} />
        <Row label="rudder" cell={cell('rudder')} />
        <Row label="camber" cell={cell('camber')} />
        <Row label="sail" cell={cell('sail')} />
        <Row label="drive" cell={cell('drive')} />
        <Row label="side" cell={cell('side')} />
      </div>

      <div className="hud-group hud-keys">
        <strong>keys</strong>
        <span>&larr; &rarr; steer &nbsp; &uarr; sheet in &nbsp; &darr; sheet out</span>
        <span>the tiller is modelled properly; the keys are not reversed</span>
      </div>
    </div>
  )
}

function Row({
  label,
  cell,
}: {
  label: string
  cell: (node: HTMLSpanElement | null) => void
}): JSX.Element {
  return (
    <div className="hud-row">
      <span className="hud-label">{label}</span>
      <span className="hud-value" ref={cell}>
        &mdash;
      </span>
    </div>
  )
}

function degrees(radians: number): string {
  return ((radians * 180) / Math.PI).toFixed(0)
}

function side(value: number): string {
  if (Math.abs(value) < 0.02) return ''
  return value > 0 ? 'stbd' : 'port'
}

function leeway(frame: BoatFrame): number {
  const { state } = frame
  const q = state.orientation
  // Bow direction in world, inline to keep this file free of sim imports.
  const bx = 2 * (q[0] * q[2] + q[3] * q[1])
  const bz = 1 - 2 * (q[0] * q[0] + q[1] * q[1])
  const forward = -state.velocity[0] * bx - state.velocity[2] * bz
  const across = state.velocity[0] * bz - state.velocity[2] * bx
  if (Math.hypot(forward, across) < 1e-6) return 0
  return Math.atan2(across, forward)
}
