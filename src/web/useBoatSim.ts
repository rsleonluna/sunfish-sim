import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { apparentWindAngle } from '../sim-core/aero.ts'
import {
  boatLoads,
  gerstnerWater,
  headingAngle,
  heelAngle,
  makeSunfish,
  pitchAngle,
  type BoatConfig,
  type BoatLoads,
  type Environment,
} from '../sim-core/boat.ts'
import {
  DEFAULT_CONTROL_CONFIG,
  NEUTRAL_CONTROLS,
  camberMorphInfluence,
  horizontalSpeed,
  stepControls,
  type ControlState,
} from '../sim-core/controls.ts'
import { directionFromHeading, type WaveField } from '../sim-core/gerstner.ts'
import { solveEquilibriumDraft } from '../sim-core/hydrostatics.ts'
import { quatFromAxisAngle } from '../sim-core/quat.ts'
import type { RigSpec } from '../sim-core/rig.ts'
import {
  FIXED_DT,
  INITIAL_CLOCK,
  interpolate,
  restingState,
  step,
  type RigidBodyState,
  type SimClock,
} from '../sim-core/state.ts'
import type { Vec3 } from '../sim-core/vec.ts'
import type { InputRef } from './input.ts'

export interface SimSettings {
  readonly field: WaveField
  readonly windSpeed: number
  readonly windHeading: number
  readonly startHeading: number
  readonly paused: boolean
}

/** Everything the renderer and the HUD need for one frame. */
export interface BoatFrame {
  /** Interpolated between the last two fixed steps: for drawing only. */
  render: RigidBodyState
  /** The true simulation state at the last fixed step. */
  state: RigidBodyState
  controls: ControlState
  loads: BoatLoads
  /** Signed morph weight for the sail's Camber shape key. */
  camberInfluence: number
  speed: number
  heel: number
  pitch: number
  heading: number
  time: number
  steps: number
}

/**
 * Runs the boat on a fixed 1/120 s step inside the render loop.
 *
 * The whole frame's worth of state lives in refs. Nothing here calls
 * `setState`: React re-rendering at 120 Hz would cost more than the simulation
 * does, and the scene reads the ref directly in its own `useFrame`.
 */
export function useBoatSim(rig: RigSpec, input: InputRef, settings: SimSettings) {
  const config: BoatConfig = useMemo(() => makeSunfish(rig), [rig])

  const frame = useRef<BoatFrame | null>(null)
  const state = useRef<RigidBodyState>(initialState(config, settings.startHeading))
  const previous = useRef<RigidBodyState>(state.current)
  const controls = useRef<ControlState>(NEUTRAL_CONTROLS)
  const clock = useRef<SimClock>(INITIAL_CLOCK)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // Reset when the starting heading changes, so the panel can put the boat back.
  const startedAt = useRef(settings.startHeading)
  if (startedAt.current !== settings.startHeading) {
    startedAt.current = settings.startHeading
    state.current = initialState(config, settings.startHeading)
    previous.current = state.current
    controls.current = NEUTRAL_CONTROLS
    clock.current = INITIAL_CLOCK
  }

  useFrame((_, delta) => {
    const now = settingsRef.current
    if (now.paused) return

    const wind = directionFromHeading(now.windHeading)
    const trueWind: Vec3 = [wind[0] * now.windSpeed, 0, wind[1] * now.windSpeed]

    let pending = clock.current.remainder + Math.min(delta, 0.25)
    let time = clock.current.time
    let steps = 0
    let current = state.current
    let last = state.current

    // The accumulator, inlined rather than using `advance`, because the control
    // surfaces have to step alongside the body at the same fixed rate.
    while (pending >= FIXED_DT && steps < 8) {
      last = current
      const environment: Environment = {
        trueWind,
        water: gerstnerWater(now.field, time),
      }
      const apparent = apparentWindAngle(current, trueWind)
      controls.current = stepControls(
        controls.current,
        DEFAULT_CONTROL_CONFIG,
        input.current,
        apparent,
        FIXED_DT,
      )
      const loads = boatLoads(config, current, controls.current, environment)
      current = step(current, config.body, loads.wrench, FIXED_DT)

      time += FIXED_DT
      pending -= FIXED_DT
      steps++
    }

    if (pending >= FIXED_DT) pending %= FIXED_DT

    state.current = current
    previous.current = last
    clock.current = { time, remainder: pending }

    const render = steps === 0 ? current : interpolate(last, current, pending / FIXED_DT)
    const environment: Environment = { trueWind, water: gerstnerWater(now.field, time) }
    const loads = boatLoads(config, current, controls.current, environment)

    frame.current = {
      render,
      state: current,
      controls: controls.current,
      loads,
      camberInfluence: camberMorphInfluence(
        loads.sail.camber,
        config.sail.fullCamber,
        controls.current.boomAngle,
      ),
      speed: horizontalSpeed(current.velocity),
      heel: heelAngle(current),
      pitch: pitchAngle(current),
      heading: headingAngle(current),
      time,
      steps,
    }
  })

  return { config, frame }
}

function initialState(config: BoatConfig, headingDegrees: number): RigidBodyState {
  const draft = solveEquilibriumDraft(config.hull, config.body.mass)
  return restingState(
    [0, -draft, 0],
    quatFromAxisAngle([0, 1, 0], (headingDegrees * Math.PI) / 180),
  )
}
