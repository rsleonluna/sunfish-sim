/**
 * Apparent wind and sail forces.
 *
 * Pure TypeScript. Works in the boat frame throughout and converts to world at
 * the very end, because every angle that matters here — sheet angle, angle of
 * attack, which side the wind is on — is a boat-frame question.
 *
 * ## Simplifications, stated plainly
 * The sail is treated as a single lifting surface in the horizontal plane, with
 * its force applied at the centre of effort. That gives drive, side force and
 * the heeling moment, which is what the boat needs. It does not model twist
 * along the luff, the vertical component a heeled rig produces, or the wind
 * gradient between deck and masthead. The lateen yard is folded into the sail's
 * area and centre of effort rather than modelled as its own surface.
 */

import { AIR_DENSITY } from './constants.ts'
import {
  dynamicPressure,
  smoothstep,
  surfaceCoefficients,
  type SurfaceConfig,
  type SurfaceCoefficients,
} from './lifting-surface.ts'
import { quatRotate, quatRotateInverse, type Quat } from './quat.ts'
import type { Vec3 } from './vec.ts'

/** Enough of a rigid body for the sail to work out what the wind is doing. */
export interface SailBodyState {
  readonly position: Vec3
  readonly orientation: Quat
  readonly velocity: Vec3
  readonly angularVelocity: Vec3
}

export interface SailConfig {
  /** Sail area, m^2. */
  readonly area: number
  /** Centre of effort with the sail on the centreline, boat frame, m. */
  readonly centreOfEffort: Vec3
  /** Point the rig swings about, boat frame. Only its x and z are used. */
  readonly pivot: Vec3
  /** Surface model, including the sail's aspect ratio. */
  readonly surface: SurfaceConfig
  /**
   * Zero-lift angle per unit camber, rad.
   *
   * Thin-airfoil theory puts a circular-arc section's zero-lift angle at about
   * -2 times its camber ratio. A fully powered Sunfish sail runs near 12%
   * camber, so this defaults to that.
   */
  readonly camberLiftShift: number
  /** Fraction the peak lift grows by at full camber. */
  readonly camberLiftGain: number
  /** Camber with the sheet hard in, chord fraction. */
  readonly flatCamber: number
  /** Camber with the sheet fully eased. */
  readonly fullCamber: number
  /** Sheet angle at which camber reaches `fullCamber`, rad. */
  readonly camberEaseAngle: number
  /**
   * Angle of attack over which a backwinded sail refills, rad.
   *
   * A soft sail only holds its shape when the wind is on the side the boom is
   * set to. Pointed the other way it luffs: it flogs and drags but makes no
   * lift. This is the width of that transition, and it is what makes head to
   * wind produce nothing rather than a spurious side force.
   */
  readonly luffAngle: number
}

export interface SailInput {
  /** True wind velocity in world frame, m/s. Where the air is going. */
  readonly trueWind: Vec3
  /** Boom angle off the centreline, rad. Positive swings the boom to starboard. */
  readonly sheetAngle: number
  readonly airDensity?: number
  /** Overrides the camber the sheet angle would imply. */
  readonly camber?: number
}

export interface SailLoad {
  /** Force in world frame, N. */
  readonly force: Vec3
  /** Torque about the body's centre of mass, world frame, N m. */
  readonly torque: Vec3
  /** Apparent wind at the centre of effort, boat frame, m/s. */
  readonly apparentWind: Vec3
  readonly apparentSpeed: number
  /** Apparent wind angle off the bow, rad. Positive means wind from starboard. */
  readonly apparentAngle: number
  /** Angle of attack on the sail, rad, camber shift included. */
  readonly angleOfAttack: number
  /** Geometric angle between chord and flow, rad, before the camber shift. */
  readonly geometricAngleOfAttack: number
  /** How well the sail is filled, 0 luffing to 1 drawing. */
  readonly fill: number
  /** Camber actually used, chord fraction. Stage 7 drives the morph with this. */
  readonly camber: number
  readonly coefficients: SurfaceCoefficients
  readonly lift: number
  readonly drag: number
  /** Centre of effort in world space, m. */
  readonly centreOfEffort: Vec3
  /** Force along the bow direction, N. Positive drives the boat forward. */
  readonly drive: number
  /** Force to starboard, N. */
  readonly sideForce: number
  readonly stalled: boolean
}

/** A Sunfish sail, built from the rig manifest's own numbers. */
export function makeSailConfig(
  area: number,
  centreOfEffort: Vec3,
  pivot: Vec3,
  luff: number,
  overrides: Partial<Omit<SailConfig, 'area' | 'centreOfEffort' | 'pivot'>> = {},
): SailConfig {
  return {
    area,
    centreOfEffort,
    pivot,
    surface: overrides.surface ?? {
      // A triangular sail's effective aspect ratio is roughly luff^2 / area.
      aspectRatio: (luff * luff) / area,
      spanEfficiency: 0.8,
      // Soft cambered sails hold attached flow to around twenty degrees.
      stallAngle: 0.35,
      stallWidth: 0.25,
      plateLift: 1.1,
      baseDrag: 0.05,
      formDrag: 1.2,
    },
    camberLiftShift: overrides.camberLiftShift ?? 2,
    camberLiftGain: overrides.camberLiftGain ?? 1.5,
    flatCamber: overrides.flatCamber ?? 0.06,
    fullCamber: overrides.fullCamber ?? 0.16,
    camberEaseAngle: overrides.camberEaseAngle ?? Math.PI / 2,
    luffAngle: overrides.luffAngle ?? 0.12,
  }
}

/**
 * Apparent wind: what the air is doing relative to a point on the boat.
 *
 * True wind minus the point's velocity. Feed it the centre of effort's
 * velocity, not the hull's, so a rolling rig feels its own motion.
 */
export function apparentWind(trueWind: Vec3, pointVelocity: Vec3): Vec3 {
  return [
    trueWind[0] - pointVelocity[0],
    trueWind[1] - pointVelocity[1],
    trueWind[2] - pointVelocity[2],
  ]
}

/**
 * Angle the apparent wind arrives from, off the bow, at a boat-frame point.
 *
 * Positive means the wind is on the starboard side. Separate from `sailLoad`
 * because the boom angle is decided from this, and asking `sailLoad` for it
 * first would need a boom angle to already exist.
 */
export function apparentWindAngle(
  body: SailBodyState,
  trueWind: Vec3,
  at: Vec3 = [0, 0, 0],
): number {
  const lever = quatRotate(body.orientation, at)
  const [wx, wy, wz] = body.angularVelocity
  const pointVelocity: Vec3 = [
    body.velocity[0] + (wy * lever[2] - wz * lever[1]),
    body.velocity[1] + (wz * lever[0] - wx * lever[2]),
    body.velocity[2] + (wx * lever[1] - wy * lever[0]),
  ]
  const apparent = quatRotateInverse(body.orientation, apparentWind(trueWind, pointVelocity))
  return Math.atan2(-apparent[0], apparent[2])
}

/**
 * Camber the sheet setting implies.
 *
 * Sheeted hard the sail pulls flat; eased, it bags out. This is the single
 * value both the aerodynamics and the mesh morph must agree on.
 */
export function sailCamber(config: SailConfig, sheetAngle: number): number {
  const eased = Math.min(Math.abs(sheetAngle) / config.camberEaseAngle, 1)
  return config.flatCamber + (config.fullCamber - config.flatCamber) * eased
}

/**
 * Rotates a boat-frame point about the rig's vertical pivot axis.
 *
 * Positive `sheetAngle` swings the boom to starboard. The clew is aft of the
 * mast at +Z, and rotating +Z toward +X is a positive turn about +Y — the same
 * sense the chord below is built with. Getting these two out of step leaves the
 * heel moment right and the yaw moment backwards, which is hard to spot.
 */
export function swingAboutPivot(point: Vec3, pivot: Vec3, sheetAngle: number): Vec3 {
  const cos = Math.cos(sheetAngle)
  const sin = Math.sin(sheetAngle)
  const x = point[0] - pivot[0]
  const z = point[2] - pivot[2]
  return [pivot[0] + x * cos + z * sin, point[1], pivot[2] - x * sin + z * cos]
}

/**
 * Forces and moments from the sail.
 *
 * Gravity and the rig's own weight are not included; this is aerodynamics only.
 */
export function sailLoad(
  config: SailConfig,
  body: SailBodyState,
  input: SailInput,
): SailLoad {
  const airDensity = input.airDensity ?? AIR_DENSITY
  const camber = input.camber ?? sailCamber(config, input.sheetAngle)

  // Centre of effort swings with the boom, then out into the world.
  const coeBody = swingAboutPivot(config.centreOfEffort, config.pivot, input.sheetAngle)
  const lever = quatRotate(body.orientation, coeBody)
  const centreOfEffort: Vec3 = [
    body.position[0] + lever[0],
    body.position[1] + lever[1],
    body.position[2] + lever[2],
  ]

  // Velocity of that point, including the boat's rotation.
  const [wx, wy, wz] = body.angularVelocity
  const pointVelocity: Vec3 = [
    body.velocity[0] + (wy * lever[2] - wz * lever[1]),
    body.velocity[1] + (wz * lever[0] - wx * lever[2]),
    body.velocity[2] + (wx * lever[1] - wy * lever[0]),
  ]

  const worldApparent = apparentWind(input.trueWind, pointVelocity)
  const apparent = quatRotateInverse(body.orientation, worldApparent)

  // Everything below is horizontal: the sail is modelled in plan view.
  const flowX = apparent[0]
  const flowZ = apparent[2]
  const apparentSpeed = Math.hypot(flowX, flowZ)

  // Bow is -Z. The angle the wind is coming FROM, measured off the bow, with
  // positive meaning the starboard side.
  const apparentAngle = Math.atan2(-flowX, flowZ)

  if (apparentSpeed < 1e-9) {
    return {
      force: [0, 0, 0],
      torque: [0, 0, 0],
      apparentWind: apparent,
      apparentSpeed,
      apparentAngle,
      angleOfAttack: 0,
      geometricAngleOfAttack: 0,
      fill: 0,
      camber,
      coefficients: { lift: 0, drag: 0, separation: 0, stalled: false },
      lift: 0,
      drag: 0,
      centreOfEffort,
      drive: 0,
      sideForce: 0,
      stalled: false,
    }
  }

  // Chord runs from the tack aft to the clew, swung by the sheet. Same sense as
  // swingAboutPivot: at zero sheet it points dead aft.
  const chordX = Math.sin(input.sheetAngle)
  const chordZ = Math.cos(input.sheetAngle)

  // Angle from the chord to the relative wind. The relative wind runs leading
  // edge to trailing edge, the same sense as the chord, so it is NOT negated.
  const alongChord = flowX * chordX + flowZ * chordZ
  const acrossChord = flowX * chordZ - flowZ * chordX
  const geometricAlpha = Math.atan2(acrossChord, alongChord)

  // The sail is cambered toward the side the boom is set to, which is where its
  // zero-lift angle points. On the centreline it sets to whichever side the
  // wind is already on.
  const camberSign =
    input.sheetAngle > 0 ? 1 : input.sheetAngle < 0 ? -1 : geometricAlpha >= 0 ? 1 : -1

  // Backwinded from the other side, the sail collapses instead of driving.
  const fill = smoothstep(0, config.luffAngle, camberSign * geometricAlpha)

  // Camber moves the zero-lift angle toward the side the sail is set to.
  const zeroLiftAngle = -camberSign * config.camberLiftShift * camber
  const surface: SurfaceConfig = {
    ...config.surface,
    plateLift: config.surface.plateLift * (1 + config.camberLiftGain * camber),
  }
  const coefficients = surfaceCoefficients(geometricAlpha, surface, zeroLiftAngle)

  const pressure = dynamicPressure(airDensity, apparentSpeed)
  // A luffing sail makes no lift, but it still flogs and drags.
  const lift = pressure * config.area * coefficients.lift * fill
  const drag = pressure * config.area * coefficients.drag

  // Drag runs downwind. Lift is perpendicular to it, ninety degrees the way a
  // positive angle of attack deflects the flow.
  const dragX = flowX / apparentSpeed
  const dragZ = flowZ / apparentSpeed
  const liftX = dragZ
  const liftZ = -dragX

  const forceX = lift * liftX + drag * dragX
  const forceZ = lift * liftZ + drag * dragZ

  const bodyForce: Vec3 = [forceX, 0, forceZ]
  const force = quatRotate(body.orientation, bodyForce)

  const torque: Vec3 = [
    lever[1] * force[2] - lever[2] * force[1],
    lever[2] * force[0] - lever[0] * force[2],
    lever[0] * force[1] - lever[1] * force[0],
  ]

  return {
    force,
    torque,
    apparentWind: apparent,
    apparentSpeed,
    apparentAngle,
    angleOfAttack: geometricAlpha - zeroLiftAngle,
    geometricAngleOfAttack: geometricAlpha,
    fill,
    camber,
    coefficients,
    lift,
    drag,
    centreOfEffort,
    // Bow is -Z, so drive is the negative of the boat-frame z component.
    drive: -forceZ,
    sideForce: forceX,
    stalled: coefficients.stalled,
  }
}
