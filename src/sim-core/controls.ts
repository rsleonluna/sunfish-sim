/**
 * Helm and sheet.
 *
 * Pure TypeScript. Turns the two things a sailor actually holds — the mainsheet
 * and the tiller — into the boom and rudder angles the force models want.
 *
 * ## How the mainsheet works
 * The sheet does not set the boom angle. The wind does. A sheet is a piece of
 * rope: it can stop the boom going further out, and nothing else. So the boom
 * sits wherever the wind puts it, unless the sheet is stopping it, and the
 * whole model is one clamp:
 *
 *     boomAngle = clamp(freeBoomAngle, -limit, +limit)
 *
 * That single line gives the behaviour for free. Sheeted in tighter than the
 * apparent wind, the sail draws. Eased past it, the boom weathervanes, the
 * angle of attack falls to nothing and the sail luffs. Head to wind there is no
 * setting that draws. None of that is special-cased anywhere.
 *
 * ## Tiller sign, which is a trap
 * `tiller` is the tiller's own position: positive means pushed to starboard.
 * A tiller pushed to starboard puts the rudder blade to port and turns the boat
 * to port. That is genuinely backwards from the boat's response and it is how a
 * real tiller works, so it is modelled that way here and the keyboard mapping
 * in the web layer is what makes it feel right to a player.
 */

import type { Vec3 } from './vec.ts'

export interface ControlInput {
  /** Mainsheet, 0 hard in to 1 fully eased. */
  readonly mainsheet: number
  /** Tiller position, -1 hard to port to +1 hard to starboard. */
  readonly tiller: number
}

export interface ControlConfig {
  /** Boom angle the sheet allows when hard in, rad. */
  readonly minBoomAngle: number
  /** Boom angle the sheet allows when fully eased, rad. */
  readonly maxBoomAngle: number
  /** Fastest the boom can swing across, rad/s. */
  readonly boomRate: number
  /** Rudder angle at full tiller, rad. */
  readonly maxRudderAngle: number
  /** Fastest the blade can be moved, rad/s. */
  readonly rudderRate: number
}

export interface ControlState {
  /** Boom angle off the centreline, rad. Positive is to starboard. */
  readonly boomAngle: number
  /** Rudder deflection, rad. Positive turns the boat to starboard. */
  readonly rudderAngle: number
}

export const NEUTRAL_CONTROLS: ControlState = { boomAngle: 0, rudderAngle: 0 }

export const DEFAULT_CONTROL_CONFIG: ControlConfig = {
  // Hard in still leaves a few degrees: the boom never quite reaches the
  // centreline on a Sunfish.
  minBoomAngle: 0.05,
  maxBoomAngle: 1.48,
  // A boom crossing on a tack takes roughly half a second.
  boomRate: 7,
  maxRudderAngle: 0.6,
  rudderRate: 3,
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

/** Moves `from` toward `to`, never further than `maxDelta`. */
export function moveToward(from: number, to: number, maxDelta: number): number {
  const delta = to - from
  if (Math.abs(delta) <= maxDelta) return to
  return from + Math.sign(delta) * maxDelta
}

/**
 * Where a completely free boom would sit: aligned with the apparent wind.
 *
 * `apparentAngle` is the angle the wind comes from, off the bow, positive from
 * starboard. Wind from starboard puts the boom to port, so the two are simply
 * opposite.
 */
export function freeBoomAngle(apparentAngle: number): number {
  return -apparentAngle
}

/** How far out the sheet is letting the boom go, rad. */
export function sheetLimit(config: ControlConfig, mainsheet: number): number {
  const eased = clamp(mainsheet, 0, 1)
  return config.minBoomAngle + (config.maxBoomAngle - config.minBoomAngle) * eased
}

/** Boom angle the wind and the sheet between them are asking for. */
export function targetBoomAngle(
  config: ControlConfig,
  mainsheet: number,
  apparentAngle: number,
): number {
  const limit = sheetLimit(config, mainsheet)
  return clamp(freeBoomAngle(apparentAngle), -limit, limit)
}

/** Rudder angle the tiller is asking for. Opposite to the tiller's own position. */
export function targetRudderAngle(config: ControlConfig, tiller: number): number {
  return -config.maxRudderAngle * clamp(tiller, -1, 1)
}

/**
 * Advances the physical control surfaces one step toward what the sailor is
 * asking for.
 *
 * Rate limits are what make a tack read as a tack: the boom sweeps across
 * rather than teleporting, and the blade cannot be slammed instantly.
 */
export function stepControls(
  state: ControlState,
  config: ControlConfig,
  input: ControlInput,
  apparentAngle: number,
  dt: number,
): ControlState {
  return {
    boomAngle: moveToward(
      state.boomAngle,
      targetBoomAngle(config, input.mainsheet, apparentAngle),
      config.boomRate * dt,
    ),
    rudderAngle: moveToward(
      state.rudderAngle,
      targetRudderAngle(config, input.tiller),
      config.rudderRate * dt,
    ),
  }
}

/**
 * Which tack the boat is on, from the boom's side.
 *
 * Boom to starboard means the wind is on the port side, which is port tack.
 * Returns 0 when the boom is on the centreline and the boat is on neither.
 */
export function tackFromBoom(boomAngle: number, threshold: number = 0.06): -1 | 0 | 1 {
  if (boomAngle > threshold) return 1
  if (boomAngle < -threshold) return -1
  return 0
}

/**
 * Signed influence for the sail's camber morph target.
 *
 * The shape key runs -1 to 1, so the sign bags the cloth toward whichever side
 * the boom is set. Magnitude is the camber the aerodynamics used, as a fraction
 * of the fullest the sail gets, so the mesh and the forces cannot disagree.
 */
export function camberMorphInfluence(
  camber: number,
  fullCamber: number,
  boomAngle: number,
): number {
  const magnitude = clamp(camber / fullCamber, 0, 1)
  return boomAngle >= 0 ? magnitude : -magnitude
}

/** Convenience for the debug HUD: metres per second to knots. */
export function toKnots(metresPerSecond: number): number {
  return metresPerSecond * 1.943844
}

/** Horizontal speed of a body, m/s. */
export function horizontalSpeed(velocity: Vec3): number {
  return Math.hypot(velocity[0], velocity[2])
}
