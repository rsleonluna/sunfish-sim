/**
 * Lift and drag coefficients for a thin lifting surface, valid all the way
 * round from 0 to 180 degrees.
 *
 * Shared by the sail and by the foils: a daggerboard is the same problem in a
 * denser fluid, and having one stall model rather than two keeps them from
 * drifting apart.
 *
 * ## Model
 * Below stall, thin-airfoil theory corrected for finite span:
 *
 *     Cl = a * alpha,   a = 2*pi / (1 + 2 / (e * AR))
 *
 * Past stall the flow separates and the surface behaves like a flat plate:
 *
 *     Cl = plateLift * sin(2 * alpha)
 *
 * The two are blended over a few degrees so nothing steps discontinuously —
 * important because a sail spends its whole life crossing that boundary, and a
 * jump in force would show up as a bang in the rigid body.
 *
 * Drag is profile plus separation plus induced:
 *
 *     Cd = baseDrag + formDrag * sin^2(alpha) + Cl^2 / (pi * e * AR)
 *
 * The flat-plate branch is what makes a sail on a run work at all: at 90
 * degrees it produces no lift and maximum drag, which is exactly right.
 */

const TWO_PI = Math.PI * 2

export interface SurfaceConfig {
  /** Aspect ratio, span^2 / area. */
  readonly aspectRatio: number
  /** Oswald span efficiency, 0 to 1. */
  readonly spanEfficiency: number
  /** Angle of attack at which flow starts to separate, rad. */
  readonly stallAngle: number
  /** Angular width of the blend from attached to separated flow, rad. */
  readonly stallWidth: number
  /** Peak lift coefficient of the fully separated flat plate. */
  readonly plateLift: number
  /** Profile drag at zero angle of attack. */
  readonly baseDrag: number
  /** Additional drag when broadside on. */
  readonly formDrag: number
}

export interface SurfaceCoefficients {
  readonly lift: number
  readonly drag: number
  /** Fraction of the way into separated flow, 0 attached to 1 fully stalled. */
  readonly separation: number
  readonly stalled: boolean
}

/**
 * Lift-curve slope per radian, corrected for finite span.
 *
 * Infinite span gives thin-airfoil theory's 2*pi. A Sunfish sail at aspect
 * ratio 2.2 gets barely half that, which is why a low rig needs so much more
 * angle to make the same drive.
 */
export function liftSlope(aspectRatio: number, spanEfficiency: number): number {
  if (!(aspectRatio > 0)) {
    throw new Error(`lifting-surface: aspectRatio must be positive, got ${aspectRatio}`)
  }
  if (!(spanEfficiency > 0) || spanEfficiency > 1) {
    throw new Error(`lifting-surface: spanEfficiency must be in (0, 1], got ${spanEfficiency}`)
  }
  return TWO_PI / (1 + 2 / (spanEfficiency * aspectRatio))
}

/** Smooth 0-to-1 ramp with zero slope at both ends. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

/**
 * Coefficients at a geometric angle of attack, in radians.
 *
 * `zeroLiftAngle` is where camber puts the no-lift point: a section cambered
 * toward starboard already makes lift at alpha = 0. Lift is measured from it,
 * but separation is NOT — the flow does not care where the zero-lift angle sits,
 * only how far round the geometric angle has gone. Folding the camber shift
 * into alpha before this call would stall a well-set sail far too early.
 */
export function surfaceCoefficients(
  alpha: number,
  config: SurfaceConfig,
  zeroLiftAngle: number = 0,
): SurfaceCoefficients {
  const slope = liftSlope(config.aspectRatio, config.spanEfficiency)
  const magnitude = Math.abs(alpha)

  const attachedLift = slope * (alpha - zeroLiftAngle)
  const separatedLift = config.plateLift * Math.sin(2 * alpha)
  const separation = smoothstep(config.stallAngle, config.stallAngle + config.stallWidth, magnitude)

  const lift = attachedLift * (1 - separation) + separatedLift * separation

  const sine = Math.sin(alpha)
  const induced = (lift * lift) / (Math.PI * config.spanEfficiency * config.aspectRatio)
  const drag = config.baseDrag + config.formDrag * sine * sine + induced

  return { lift, drag, separation, stalled: separation > 0.5 }
}

/** Dynamic pressure, Pa. */
export function dynamicPressure(density: number, speed: number): number {
  return 0.5 * density * speed * speed
}
