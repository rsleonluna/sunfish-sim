/**
 * Buoyancy and hydrodynamic drag from a set of hull probes.
 *
 * Pure TypeScript. Deliberately knows nothing about the Gerstner field: the
 * water arrives through a `WaterSampler` callback, so this module can be tested
 * against dead flat water and driven by anything later.
 *
 * ## Model
 * Each probe samples the pressure on the hull bottom and owns a share of the
 * waterplane area. The upward force on a probe submerged by depth d is
 *
 *     F = rho * g * A * d
 *
 * which is hydrostatic pressure times area. Summed over the hull that is a
 * Riemann sum of `rho * g * V_submerged`, so it converges on Archimedes for a
 * wall-sided hull rather than approximating it with a spring. `A * d` is
 * literally the displaced volume that probe accounts for.
 *
 * Depth is clamped at each probe's `maxDepth`, the point where that station is
 * fully under and cannot displace any more.
 *
 * Buoyancy is applied straight up, not along the wave normal. Net buoyancy is
 * vertical by definition; the down-slope push a surfing hull feels comes from
 * the pressure gradient and from drag against orbital velocity, which the drag
 * term below already carries.
 *
 * ## What this module does not do
 * Torque comes out about `body.position`, so that point must be the centre of
 * mass for the result to be usable directly. Stage 5 owns that.
 */

import { GRAVITY, WATER_DENSITY } from './constants.ts'
import { quatRotate, quatRotateInverse, type Quat } from './quat.ts'
import type { Vec3 } from './vec.ts'

const ZERO: Vec3 = [0, 0, 0]

export interface HullProbe {
  /** Position in boat frame, m. */
  readonly position: Vec3
  /** Share of the waterplane this probe stands for, m^2. */
  readonly area: number
  /** Depth at which this station is fully submerged and stops gaining lift, m. */
  readonly maxDepth: number
}

export interface HullConfig {
  readonly probes: readonly HullProbe[]
  /** kg/m^3. Freshwater for Lake Huron. */
  readonly waterDensity: number
  readonly gravity: number
  /** Linear drag, N per (m/s) per m^2 of probe area. */
  readonly linearDrag: number
  /** Quadratic drag, N per (m/s)^2 per m^2 of probe area. */
  readonly quadraticDrag: number
  /**
   * Depth over which a probe ramps up to its full drag, m.
   *
   * Purely a continuity device, so a probe crossing the surface does not switch
   * its drag on in one step. It must stay small: scaling drag by submersion all
   * the way down to `maxDepth` would leave the hull almost undamped in heave,
   * which is exactly the regime that matters when it is floating at rest.
   */
  readonly dragRampDepth: number
  /**
   * Per-axis drag scaling in boat frame: (sway, heave, surge).
   *
   * A hull is extremely anisotropic. It resists sideways and vertical motion
   * hard — that is what the beam and the flat bottom are for — and slips
   * fore-and-aft with barely any resistance at all, which is the entire point
   * of the shape. Scaling all three the same is off by two orders of magnitude
   * in surge: with the heave damping this model needs, an unscaled hull sees
   * 3000 N at 1 m/s against a sail pushing 150 N, and the boat cannot move.
   */
  readonly dragAnisotropy: Vec3
}

export interface BodyState {
  /** Centre of mass in world space, m. */
  readonly position: Vec3
  /** Boat-to-world rotation. */
  readonly orientation: Quat
  /** Linear velocity of the centre of mass, m/s. */
  readonly velocity: Vec3
  /** Angular velocity in world space, rad/s. */
  readonly angularVelocity: Vec3
}

export interface WaterSample {
  /** Water surface height at the sampled column, m. */
  readonly height: number
  /** Orbital velocity of the water there, m/s. Treated as still if absent. */
  readonly velocity?: Vec3
}

/** Samples the water above a world column. */
export type WaterSampler = (worldX: number, worldZ: number) => WaterSample

export interface ProbeLoad {
  readonly index: number
  /** Probe position in world space, m. */
  readonly world: Vec3
  /** Submersion below the surface, m. Negative when the probe is in air. */
  readonly depth: number
  /** Volume this probe accounts for, m^3. */
  readonly displacedVolume: number
  /** Upward buoyant force, N. */
  readonly buoyancy: number
  /** Drag force in world space, N. */
  readonly drag: Vec3
}

export interface HydrostaticLoad {
  /** Total force in world space, N. Excludes gravity. */
  readonly force: Vec3
  /** Total torque about `body.position` in world space, N m. */
  readonly torque: Vec3
  /** Total displaced volume, m^3. */
  readonly displacedVolume: number
  readonly wettedProbes: number
  readonly probes: readonly ProbeLoad[]
}

/**
 * Sensible starting values. Drag coefficients are tuning knobs, not physics.
 *
 * The linear term is set so a Sunfish at sailing displacement lands near a 0.3
 * heave damping ratio, which is a couple of visible bobs rather than the thirty
 * seconds of ringing a lighter value gives. See the module tests.
 */
export const DEFAULT_LINEAR_DRAG = 400
export const DEFAULT_QUADRATIC_DRAG = 600
export const DEFAULT_DRAG_RAMP_DEPTH = 0.03
/**
 * Heave at full strength, sway well below it, surge lower again.
 *
 * Heave is set by the damping the hull needs to stop bobbing (see the drag
 * coefficients above). Sway must not simply inherit that number: a hull moving
 * sideways presents about 0.46 m^2 of wetted section against 3 m^2 of
 * waterplane, so on area alone it is worth around 0.15 — and the quadratic term
 * is driven by total relative speed rather than the cross-flow component, which
 * roughly doubles it again. 0.08 is the value that lands, and it was chosen by
 * sweeping it against two things the boat has to be able to do.
 *
 * Both matter. Leave sway at full strength and yaw is damped so hard the rudder
 * cannot turn the boat: it luffs up, runs out of speed and sits in irons,
 * unable to complete a tack at any helm duration. Raise it much above 0.1 and
 * the same thing happens more slowly. Lower it and the boat carries a little
 * more lee helm, which is a fair trade for a boat that tacks.
 */
export const DEFAULT_DRAG_ANISOTROPY: Vec3 = [0.08, 1, 0.012]

/**
 * Spreads a waterplane area evenly across probes.
 *
 * The rig manifest carries no per-probe area, so the split is a modelling
 * choice. What actually sets the draft is the total, which is why
 * `waterplaneAreaForDraft` exists to solve for it.
 */
export function uniformProbes(
  positions: readonly Vec3[],
  waterplaneArea: number,
  maxDepth: number,
): HullProbe[] {
  if (positions.length === 0) {
    throw new Error('hydrostatics: need at least one probe')
  }
  if (!(waterplaneArea > 0) || !Number.isFinite(waterplaneArea)) {
    throw new Error(`hydrostatics: waterplaneArea must be finite and positive, got ${waterplaneArea}`)
  }
  if (!(maxDepth > 0) || !Number.isFinite(maxDepth)) {
    throw new Error(`hydrostatics: maxDepth must be finite and positive, got ${maxDepth}`)
  }

  const area = waterplaneArea / positions.length
  return positions.map((position) => ({ position, area, maxDepth }))
}

export function makeHullConfig(
  probes: readonly HullProbe[],
  overrides: Partial<Omit<HullConfig, 'probes'>> = {},
): HullConfig {
  return {
    probes,
    waterDensity: overrides.waterDensity ?? WATER_DENSITY,
    gravity: overrides.gravity ?? GRAVITY,
    linearDrag: overrides.linearDrag ?? DEFAULT_LINEAR_DRAG,
    quadraticDrag: overrides.quadraticDrag ?? DEFAULT_QUADRATIC_DRAG,
    dragRampDepth: overrides.dragRampDepth ?? DEFAULT_DRAG_RAMP_DEPTH,
    dragAnisotropy: overrides.dragAnisotropy ?? DEFAULT_DRAG_ANISOTROPY,
  }
}

/**
 * Displaced volume for an upright hull sitting in flat water, where `draft` is
 * how far the boat frame's origin has sunk below the surface.
 *
 * Monotonically increasing in draft, which is what makes the equilibrium solve
 * below well posed.
 */
export function displacedVolumeAtDraft(probes: readonly HullProbe[], draft: number): number {
  let volume = 0
  for (const probe of probes) {
    const depth = draft - probe.position[1]
    if (depth <= 0) continue
    volume += probe.area * Math.min(depth, probe.maxDepth)
  }
  return volume
}

/**
 * Draft at which buoyancy balances weight, in flat water and upright.
 *
 * Bisection with a fixed iteration count, so it is deterministic and has no
 * convergence-dependent branch. Returns Infinity if the hull cannot displace
 * enough to carry the mass — that is, if it swamps.
 */
export function solveEquilibriumDraft(
  hull: HullConfig,
  mass: number,
  iterations: number = 80,
): number {
  if (!(mass > 0) || !Number.isFinite(mass)) {
    throw new Error(`hydrostatics: mass must be finite and positive, got ${mass}`)
  }

  const required = mass / hull.waterDensity

  // Below the shallowest probe nothing is wet; above the deepest probe's
  // maxDepth everything is buried. The answer is somewhere between.
  let lower = Infinity
  let upper = -Infinity
  for (const probe of hull.probes) {
    lower = Math.min(lower, probe.position[1])
    upper = Math.max(upper, probe.position[1] + probe.maxDepth)
  }

  if (displacedVolumeAtDraft(hull.probes, upper) < required) return Infinity
  for (let i = 0; i < iterations; i++) {
    const middle = (lower + upper) / 2
    if (displacedVolumeAtDraft(hull.probes, middle) < required) lower = middle
    else upper = middle
  }
  return (lower + upper) / 2
}

/**
 * Total waterplane area that floats `mass` at exactly `draft`.
 *
 * Used to calibrate a probe set against a known displacement instead of
 * guessing an area and seeing what draft falls out. Throws if no probe is wet
 * at that draft, since then no area can carry the load.
 */
export function waterplaneAreaForDraft(
  positions: readonly Vec3[],
  mass: number,
  draft: number,
  maxDepth: number,
  waterDensity: number = WATER_DENSITY,
): number {
  let depthSum = 0
  for (const position of positions) {
    const depth = draft - position[1]
    if (depth <= 0) continue
    depthSum += Math.min(depth, maxDepth)
  }
  if (depthSum <= 0) {
    throw new Error(`hydrostatics: no probe is submerged at draft ${draft}, cannot solve for area`)
  }
  // volume = (area / n) * depthSum, so area = n * volume / depthSum.
  return (positions.length * (mass / waterDensity)) / depthSum
}

/**
 * Volume centroid of the displacement at a given draft, in boat frame.
 *
 * The longitudinal value is the point the buoyancy actually acts through. Put
 * the centre of mass anywhere else and the hull carries a standing trim moment,
 * so Stage 5 wants this when it decides where the mass sits. Returns the origin
 * for a hull that is completely out of the water.
 */
export function centreOfBuoyancy(probes: readonly HullProbe[], draft: number): Vec3 {
  let volume = 0
  let x = 0
  let y = 0
  let z = 0

  for (const probe of probes) {
    const depth = draft - probe.position[1]
    if (depth <= 0) continue
    const contribution = probe.area * Math.min(depth, probe.maxDepth)
    volume += contribution
    x += contribution * probe.position[0]
    y += contribution * probe.position[1]
    z += contribution * probe.position[2]
  }

  if (volume === 0) return ZERO
  return [x / volume, y / volume, z / volume]
}

/**
 * Shifts probe positions so they are measured from `centre` instead of the boat
 * frame origin.
 *
 * `hydrostaticLoad` treats probe positions as offsets from the centre of mass,
 * because that is the point it takes torque about. The rig manifest measures
 * them from the design origin, which is not the same place. Anything driving a
 * rigid body has to come through here first, or every torque is levered about
 * the wrong point.
 */
export function recentreProbes(probes: readonly HullProbe[], centre: Vec3): HullProbe[] {
  return probes.map((probe) => ({
    ...probe,
    position: [
      probe.position[0] - centre[0],
      probe.position[1] - centre[1],
      probe.position[2] - centre[2],
    ] as Vec3,
  }))
}

/**
 * Buoyancy and drag for the whole probe set at a given pose.
 *
 * Gravity is NOT included; the caller adds weight once at the centre of mass.
 */
export function hydrostaticLoad(
  hull: HullConfig,
  body: BodyState,
  water: WaterSampler,
): HydrostaticLoad {
  let forceX = 0
  let forceY = 0
  let forceZ = 0
  let torqueX = 0
  let torqueY = 0
  let torqueZ = 0
  let displacedVolume = 0
  let wettedProbes = 0

  const probes: ProbeLoad[] = []

  for (let index = 0; index < hull.probes.length; index++) {
    const probe = hull.probes[index]

    // Boat frame to world.
    const offset = quatRotate(body.orientation, probe.position)
    const world: Vec3 = [
      body.position[0] + offset[0],
      body.position[1] + offset[1],
      body.position[2] + offset[2],
    ]

    const sample = water(world[0], world[2])
    const depth = sample.height - world[1]

    if (depth <= 0) {
      probes.push({
        index,
        world,
        depth,
        displacedVolume: 0,
        buoyancy: 0,
        drag: [0, 0, 0],
      })
      continue
    }

    wettedProbes++

    const effectiveDepth = Math.min(depth, probe.maxDepth)
    const volume = probe.area * effectiveDepth
    const buoyancy = hull.waterDensity * hull.gravity * volume

    displacedVolume += volume

    // Probe velocity is the body's, plus the rotational contribution.
    const [wx, wy, wz] = body.angularVelocity
    const probeVelocityX = body.velocity[0] + (wy * offset[2] - wz * offset[1])
    const probeVelocityY = body.velocity[1] + (wz * offset[0] - wx * offset[2])
    const probeVelocityZ = body.velocity[2] + (wx * offset[1] - wy * offset[0])

    const waterVelocity = sample.velocity ?? ZERO
    const relX = probeVelocityX - waterVelocity[0]
    const relY = probeVelocityY - waterVelocity[1]
    const relZ = probeVelocityZ - waterVelocity[2]
    const speed = Math.hypot(relX, relY, relZ)

    // Full drag as soon as the probe is properly under; the ramp only smooths
    // the moment of crossing the surface.
    const wetness = Math.min(depth / hull.dragRampDepth, 1)
    const scale = -probe.area * wetness * (hull.linearDrag + hull.quadraticDrag * speed)

    // Scale in boat frame, where the hull's axes actually mean something, then
    // bring the force back out to the world.
    const relBody = quatRotateInverse(body.orientation, [relX, relY, relZ])
    const dragBody: Vec3 = [
      scale * relBody[0] * hull.dragAnisotropy[0],
      scale * relBody[1] * hull.dragAnisotropy[1],
      scale * relBody[2] * hull.dragAnisotropy[2],
    ]
    const [dragX, dragY, dragZ] = quatRotate(body.orientation, dragBody)

    const totalX = dragX
    const totalY = buoyancy + dragY
    const totalZ = dragZ

    forceX += totalX
    forceY += totalY
    forceZ += totalZ

    torqueX += offset[1] * totalZ - offset[2] * totalY
    torqueY += offset[2] * totalX - offset[0] * totalZ
    torqueZ += offset[0] * totalY - offset[1] * totalX

    probes.push({
      index,
      world,
      depth,
      displacedVolume: volume,
      buoyancy,
      drag: [dragX, dragY, dragZ],
    })
  }

  return {
    force: [forceX, forceY, forceZ],
    torque: [torqueX, torqueY, torqueZ],
    displacedVolume,
    wettedProbes,
    probes,
  }
}

/** Flat water at a fixed height, with no orbital motion. */
export function stillWater(height: number = 0): WaterSampler {
  const sample: WaterSample = { height }
  return () => sample
}
