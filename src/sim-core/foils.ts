/**
 * Daggerboard and rudder.
 *
 * Pure TypeScript. Same lifting-surface model as the sail, in water: the
 * daggerboard converts the boat's leeway into side force, which is what stops
 * a sailboat sliding sideways and lets the sail's side force become drive. The
 * rudder is the same surface with a steering angle added to its chord.
 *
 * ## Simplifications, stated plainly
 * Each foil is a single surface acting at one centre of pressure, in the
 * horizontal plane. The blade is assumed fully immersed — no ventilation, no
 * loss of area as the boat heels, and no stall from the tip breaking the
 * surface. Free-surface effects and the hull's own lateral resistance are not
 * modelled.
 */

import { WATER_DENSITY } from './constants.ts'
import {
  dynamicPressure,
  surfaceCoefficients,
  type SurfaceConfig,
  type SurfaceCoefficients,
} from './lifting-surface.ts'
import { quatRotate, quatRotateInverse, type Quat } from './quat.ts'
import type { Vec3 } from './vec.ts'

export interface FoilBodyState {
  readonly position: Vec3
  readonly orientation: Quat
  readonly velocity: Vec3
  readonly angularVelocity: Vec3
}

export interface FoilConfig {
  /** Centre of pressure in boat frame, m. Below the hull, so heel moments work. */
  readonly centreOfPressure: Vec3
  /** Planform area, m^2. */
  readonly area: number
  /** Vertical axis the blade steers about, boat frame. Only x and z are used. */
  readonly pivot: Vec3
  readonly surface: SurfaceConfig
}

export interface FoilInput {
  /** Steering angle, rad. Positive turns the trailing edge to starboard. */
  readonly deflection?: number
  /** Water velocity in world frame at the blade, m/s. */
  readonly waterVelocity?: Vec3
  readonly waterDensity?: number
}

export interface FoilLoad {
  readonly force: Vec3
  readonly torque: Vec3
  /** Flow over the blade in boat frame, m/s. */
  readonly flow: Vec3
  readonly flowSpeed: number
  /** Angle between the blade's chord and the flow, rad. */
  readonly angleOfAttack: number
  readonly coefficients: SurfaceCoefficients
  readonly lift: number
  readonly drag: number
  readonly centreOfPressure: Vec3
  /** Force along the bow direction, N. Negative for a foil, which only drags. */
  readonly drive: number
  /** Force to starboard, N. */
  readonly sideForce: number
  readonly stalled: boolean
}

const ZERO: Vec3 = [0, 0, 0]

/**
 * Builds a foil from the rig manifest's numbers.
 *
 * The centre of pressure goes at `spanFraction` of the blade's span below the
 * pivot. That assumes the whole blade is in the water; a partly raised board
 * wants a smaller fraction and a smaller area.
 */
export function makeFoilConfig(
  pivot: Vec3,
  span: number,
  area: number,
  aspectRatio: number,
  overrides: Partial<Omit<FoilConfig, 'pivot'>> & { spanFraction?: number } = {},
): FoilConfig {
  const spanFraction = overrides.spanFraction ?? 0.45
  return {
    pivot,
    area: overrides.area ?? area,
    centreOfPressure:
      overrides.centreOfPressure ?? [pivot[0], pivot[1] - span * spanFraction, pivot[2]],
    surface: overrides.surface ?? {
      aspectRatio,
      spanEfficiency: 0.9,
      // A rigid section holds attached flow further round than a soft sail.
      stallAngle: 0.22,
      stallWidth: 0.12,
      plateLift: 1.1,
      baseDrag: 0.012,
      formDrag: 1.4,
    },
  }
}

/**
 * Leeway: the angle between where the boat points and where it is actually
 * going through the water, in the horizontal plane.
 *
 * Positive means the boat is sliding to starboard of its heading. Returns 0
 * when the boat is not moving relative to the water, since the angle is
 * undefined there.
 */
export function leewayAngle(
  body: FoilBodyState,
  waterVelocity: Vec3 = ZERO,
): number {
  const through = quatRotateInverse(body.orientation, [
    body.velocity[0] - waterVelocity[0],
    body.velocity[1] - waterVelocity[1],
    body.velocity[2] - waterVelocity[2],
  ])
  if (Math.hypot(through[0], through[2]) < 1e-9) return 0
  // Bow is -Z, so a boat going straight ahead has through = (0, *, -speed).
  return Math.atan2(through[0], -through[2])
}

/** Forces and moments from one blade. */
export function foilLoad(config: FoilConfig, body: FoilBodyState, input: FoilInput = {}): FoilLoad {
  const deflection = input.deflection ?? 0
  const waterVelocity = input.waterVelocity ?? ZERO
  const waterDensity = input.waterDensity ?? WATER_DENSITY

  const lever = quatRotate(body.orientation, config.centreOfPressure)
  const centreOfPressure: Vec3 = [
    body.position[0] + lever[0],
    body.position[1] + lever[1],
    body.position[2] + lever[2],
  ]

  const [wx, wy, wz] = body.angularVelocity
  const pointVelocity: Vec3 = [
    body.velocity[0] + (wy * lever[2] - wz * lever[1]),
    body.velocity[1] + (wz * lever[0] - wx * lever[2]),
    body.velocity[2] + (wx * lever[1] - wy * lever[0]),
  ]

  // Flow the blade sees: the water's motion relative to the blade.
  const worldFlow: Vec3 = [
    waterVelocity[0] - pointVelocity[0],
    waterVelocity[1] - pointVelocity[1],
    waterVelocity[2] - pointVelocity[2],
  ]
  const flow = quatRotateInverse(body.orientation, worldFlow)

  const flowX = flow[0]
  const flowZ = flow[2]
  const flowSpeed = Math.hypot(flowX, flowZ)

  if (flowSpeed < 1e-9) {
    return {
      force: [0, 0, 0],
      torque: [0, 0, 0],
      flow,
      flowSpeed,
      angleOfAttack: 0,
      coefficients: { lift: 0, drag: 0, separation: 0, stalled: false },
      lift: 0,
      drag: 0,
      centreOfPressure,
      drive: 0,
      sideForce: 0,
      stalled: false,
    }
  }

  // Chord points aft along +Z, swung by the steering angle. Positive deflection
  // takes the trailing edge to starboard, the same sign convention as the sail.
  const chordX = Math.sin(deflection)
  const chordZ = Math.cos(deflection)

  // Relative flow runs leading edge to trailing edge, the same sense as the
  // chord, so it is not negated here.
  const alongChord = flowX * chordX + flowZ * chordZ
  const acrossChord = flowX * chordZ - flowZ * chordX
  const angleOfAttack = Math.atan2(acrossChord, alongChord)

  const coefficients = surfaceCoefficients(angleOfAttack, config.surface)

  const pressure = dynamicPressure(waterDensity, flowSpeed)
  const lift = pressure * config.area * coefficients.lift
  const drag = pressure * config.area * coefficients.drag

  const dragX = flowX / flowSpeed
  const dragZ = flowZ / flowSpeed
  const liftX = dragZ
  const liftZ = -dragX

  const forceX = lift * liftX + drag * dragX
  const forceZ = lift * liftZ + drag * dragZ

  const force = quatRotate(body.orientation, [forceX, 0, forceZ])
  const torque: Vec3 = [
    lever[1] * force[2] - lever[2] * force[1],
    lever[2] * force[0] - lever[0] * force[2],
    lever[0] * force[1] - lever[1] * force[0],
  ]

  return {
    force,
    torque,
    flow,
    flowSpeed,
    angleOfAttack,
    coefficients,
    lift,
    drag,
    centreOfPressure,
    drive: -forceZ,
    sideForce: forceX,
    stalled: coefficients.stalled,
  }
}
