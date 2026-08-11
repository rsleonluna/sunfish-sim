/**
 * The whole boat: everything that pushes on the hull, summed into one wrench.
 *
 * Pure TypeScript. This is the module that turns the separate force models into
 * something `state.ts` can integrate, and it is where the centre of mass
 * bookkeeping is settled once so nothing downstream has to think about it.
 *
 * ## Centre of mass
 * `RigidBodyState.position` is the centre of mass. The rig manifest measures
 * everything from the design origin, which is a different point. `makeSunfish`
 * shifts every probe, pivot and centre of effort onto the centre of mass at
 * build time, so by the time any force model runs, the two frames already
 * agree. Getting this wrong levers every torque about the wrong point and the
 * symptom is a boat that will not sit still.
 */

import { sailLoad, type SailConfig, type SailLoad } from './aero.ts'
import { AIR_DENSITY, GRAVITY, WATER_DENSITY } from './constants.ts'
import type { ControlState } from './controls.ts'
import { foilLoad, type FoilConfig, type FoilLoad } from './foils.ts'
import {
  sampleHeight,
  sampleParameterAt,
  sampleVelocity,
  type WaveField,
} from './gerstner.ts'
import {
  centreOfBuoyancy,
  hydrostaticLoad,
  makeHullConfig,
  recentreProbes,
  uniformProbes,
  waterplaneAreaForDraft,
  type HullConfig,
  type HydrostaticLoad,
  type WaterSampler,
} from './hydrostatics.ts'
import { makeFoilConfig } from './foils.ts'
import { makeSailConfig } from './aero.ts'
import { quatRotate, quatRotateInverse } from './quat.ts'
import { requirePoint, type RigSpec } from './rig.ts'
import {
  addWrench,
  boxInertia,
  gravityWrench,
  makeBody,
  type RigidBody,
  type RigidBodyState,
  type Wrench,
} from './state.ts'
import type { Vec3 } from './vec.ts'

export interface BoatConfig {
  readonly body: RigidBody
  readonly hull: HullConfig
  readonly sail: SailConfig
  readonly daggerboard: FoilConfig
  readonly rudder: FoilConfig
  /** Centre of mass in design-origin coordinates, boat frame, m. */
  readonly centreOfMass: Vec3
  readonly gravity: number
  readonly airDensity: number
}

export interface Environment {
  /** True wind velocity in world frame, m/s. */
  readonly trueWind: Vec3
  /** Water surface and its orbital motion. */
  readonly water: WaterSampler
}

export interface BoatLoads {
  readonly wrench: Wrench
  readonly hydrostatics: HydrostaticLoad
  readonly sail: SailLoad
  readonly daggerboard: FoilLoad
  readonly rudder: FoilLoad
}

export interface SunfishOptions {
  /** All-up sailing displacement, kg. Hull plus crew. */
  readonly mass?: number
  /** Height of the centre of mass above the design waterline, m. */
  readonly centreOfMassHeight?: number
  /** Hull bottom to deck, m: how deep a station can go before it stops lifting. */
  readonly hullDepth?: number
  /** Mass carried up the rig, kg. Dominates roll inertia. */
  readonly rigMass?: number
  readonly gravity?: number
  readonly waterDensity?: number
  readonly airDensity?: number
}

/**
 * Builds a water sampler from a Gerstner field at an instant.
 *
 * Inverts the horizontal displacement once and reuses the result for both the
 * height and the orbital velocity, which halves the work compared with calling
 * the two `...At` helpers separately.
 */
export function gerstnerWater(field: WaveField, time: number): WaterSampler {
  return (worldX: number, worldZ: number) => {
    const [x, z] = sampleParameterAt(field, worldX, worldZ, time)
    return {
      height: sampleHeight(field, x, z, time),
      velocity: sampleVelocity(field, x, z, time),
    }
  }
}

/**
 * A Sunfish, assembled from the rig manifest.
 *
 * The centre of mass goes on the longitudinal centre of buoyancy, because
 * anywhere else leaves the hull with a standing trim moment it cannot balance.
 * The waterplane area is then solved so the boat floats at exactly the design
 * waterline at the given displacement, rather than being guessed at.
 */
export function makeSunfish(rig: RigSpec, options: SunfishOptions = {}): BoatConfig {
  const mass = options.mass ?? 130
  const hullDepth = options.hullDepth ?? 0.364
  const rigMass = options.rigMass ?? 15
  const gravity = options.gravity ?? GRAVITY
  const waterDensity = options.waterDensity ?? WATER_DENSITY
  const airDensity = options.airDensity ?? AIR_DENSITY

  const probePositions = rig.probes.map((probe) => probe.position)
  const waterplaneArea = waterplaneAreaForDraft(probePositions, mass, 0, hullDepth, waterDensity)
  const designProbes = uniformProbes(probePositions, waterplaneArea, hullDepth)

  const buoyancyCentre = centreOfBuoyancy(designProbes, 0)
  const centreOfMass: Vec3 = [0, options.centreOfMassHeight ?? 0, buoyancyCentre[2]]

  const shift = (point: Vec3): Vec3 => [
    point[0] - centreOfMass[0],
    point[1] - centreOfMass[1],
    point[2] - centreOfMass[2],
  ]

  const hull = makeHullConfig(recentreProbes(designProbes, centreOfMass), {
    waterDensity,
    gravity,
  })

  // Geometric centroid of the sail triangle, from the manifest's own corners.
  const centreOfEffort: Vec3 = [
    (rig.sail.head[0] + rig.sail.tack[0] + rig.sail.clew[0]) / 3,
    (rig.sail.head[1] + rig.sail.tack[1] + rig.sail.clew[1]) / 3,
    (rig.sail.head[2] + rig.sail.tack[2] + rig.sail.clew[2]) / 3,
  ]

  const sail = makeSailConfig(
    rig.sail.areaBuilt,
    shift(centreOfEffort),
    shift(requirePoint(rig, 'pivot_gooseneck')),
    rig.sail.luff,
  )

  const daggerboard = makeFoilConfig(
    shift(rig.foils.daggerboard.pivot),
    rig.foils.daggerboard.span,
    rig.foils.daggerboard.planformArea,
    rig.foils.daggerboard.aspectRatio,
  )
  const rudder = makeFoilConfig(
    shift(rig.foils.rudder.pivot),
    rig.foils.rudder.span,
    rig.foils.rudder.planformArea,
    rig.foils.rudder.aspectRatio,
  )

  // Hull as a box, plus the rig's mass swung about the centre of effort's
  // height. On a boat this light the mast dominates the roll moment.
  const hullInertia = boxInertia(mass, [rig.hull.beam, hullDepth, rig.hull.loa])
  const rigLever = centreOfEffort[1] - centreOfMass[1]
  const rigRoll = rigMass * rigLever * rigLever
  const body = makeBody(mass, [
    hullInertia[0] + rigRoll,
    hullInertia[1],
    hullInertia[2] + rigRoll,
  ])

  return { body, hull, sail, daggerboard, rudder, centreOfMass, gravity, airDensity }
}

/**
 * Every load acting on the boat, and their sum.
 *
 * Returns the parts as well as the total so the HUD and the debug overlay can
 * show where the numbers came from without recomputing anything.
 */
export function boatLoads(
  config: BoatConfig,
  state: RigidBodyState,
  controls: ControlState,
  environment: Environment,
): BoatLoads {
  const hydrostatics = hydrostaticLoad(config.hull, state, environment.water)

  const sail = sailLoad(config.sail, state, {
    trueWind: environment.trueWind,
    sheetAngle: controls.boomAngle,
    airDensity: config.airDensity,
  })

  // Foils feel the water where they actually are, orbital motion included.
  const boardWater = environment.water(
    config.daggerboard.centreOfPressure[0] + state.position[0],
    config.daggerboard.centreOfPressure[2] + state.position[2],
  )
  const rudderWater = environment.water(
    config.rudder.centreOfPressure[0] + state.position[0],
    config.rudder.centreOfPressure[2] + state.position[2],
  )

  const daggerboard = foilLoad(config.daggerboard, state, {
    waterVelocity: boardWater.velocity,
    waterDensity: config.hull.waterDensity,
  })
  const rudder = foilLoad(config.rudder, state, {
    deflection: controls.rudderAngle,
    waterVelocity: rudderWater.velocity,
    waterDensity: config.hull.waterDensity,
  })

  let wrench = gravityWrench(config.body, config.gravity)
  wrench = addWrench(wrench, { force: hydrostatics.force, torque: hydrostatics.torque })
  wrench = addWrench(wrench, { force: sail.force, torque: sail.torque })
  wrench = addWrench(wrench, { force: daggerboard.force, torque: daggerboard.torque })
  wrench = addWrench(wrench, { force: rudder.force, torque: rudder.torque })

  return { wrench, hydrostatics, sail, daggerboard, rudder }
}

/**
 * Heel angle, rad. Positive is heel to starboard.
 *
 * Read by projecting world up into the boat frame: upright leaves it on the
 * boat's own up axis, and heel tips it sideways by exactly the heel angle.
 */
export function heelAngle(state: RigidBodyState): number {
  const up = quatRotateInverse(state.orientation, WORLD_UP)
  return Math.atan2(-up[0], up[1])
}

/** Pitch angle, rad. Positive is bow up. */
export function pitchAngle(state: RigidBodyState): number {
  const up = quatRotateInverse(state.orientation, WORLD_UP)
  // Bow is -Z, so world up leaning toward -Z in the boat frame means bow up.
  return Math.atan2(-up[2], up[1])
}

/**
 * Heading, rad, measured the same way wave directions are: 0 points along +x,
 * increasing toward +z.
 */
export function headingAngle(state: RigidBodyState): number {
  const bow = quatRotate(state.orientation, BOW)
  return Math.atan2(bow[2], bow[0])
}

const WORLD_UP: Vec3 = [0, 1, 0]
const BOW: Vec3 = [0, 0, -1]
