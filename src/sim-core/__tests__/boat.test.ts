import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { apparentWindAngle } from '../aero.ts'
import {
  boatLoads,
  gerstnerWater,
  headingAngle,
  heelAngle,
  makeSunfish,
  pitchAngle,
  type BoatConfig,
  type Environment,
} from '../boat.ts'
import {
  DEFAULT_CONTROL_CONFIG,
  NEUTRAL_CONTROLS,
  horizontalSpeed,
  stepControls,
  tackFromBoom,
  type ControlInput,
  type ControlState,
} from '../controls.ts'
import { compileWaveField, tawasPreset } from '../gerstner.ts'
import { solveEquilibriumDraft, stillWater } from '../hydrostatics.ts'
import { quatFromAxisAngle, quatRotate } from '../quat.ts'
import { parseRig } from '../rig.ts'
import { FIXED_DT, restingState, step, type RigidBodyState } from '../state.ts'
import type { Vec3 } from '../vec.ts'

const MANIFEST = new URL('../../../public/models/sunfish-rig.json', import.meta.url)
const rig = parseRig(JSON.parse(readFileSync(fileURLToPath(MANIFEST), 'utf8')))

const SUNFISH: BoatConfig = makeSunfish(rig)
/**
 * A working breeze. Above about 5 m/s the boat is overpowered close-hauled and
 * lies right over, because crew hiking is not modelled — see the depowering
 * test below, which is the tool a player actually has.
 */
const WIND_SPEED = 4
/** True wind toward +Z, so a boat with its bow at -Z is head to wind. */
const TRUE_WIND: Vec3 = [0, 0, WIND_SPEED]

const degrees = (value: number): number => (value * Math.PI) / 180
const toDegrees = (value: number): number => (value * 180) / Math.PI

function flatWater(): Environment {
  return { trueWind: TRUE_WIND, water: stillWater(0) }
}

function afloat(yawDegrees = 0): RigidBodyState {
  const draft = solveEquilibriumDraft(SUNFISH.hull, SUNFISH.body.mass)
  return restingState([0, -draft, 0], quatFromAxisAngle([0, 1, 0], degrees(yawDegrees)))
}

interface SailResult {
  state: RigidBodyState
  controls: ControlState
  /** Speed made good through the water, m/s. */
  speed: number
  headingDegrees: number
  heelDegrees: number
  boomDegrees: number
}

/**
 * Sails on for a while under fixed inputs, continuing from a state.
 *
 * The headless stand-in for a player: fixed 1/120 s steps, controls advanced
 * each step from the apparent wind exactly as the live loop does.
 */
function sailFrom(
  seconds: number,
  input: ControlInput | ((apparentAngle: number) => ControlInput),
  state: RigidBodyState,
  controls: ControlState,
  environment: Environment,
  onStep?: (boomAngle: number) => void,
): { state: RigidBodyState; controls: ControlState } {
  let current = state
  let currentControls = controls

  for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) {
    const apparent = apparentWindAngle(current, environment.trueWind)
    const resolved = typeof input === 'function' ? input(apparent) : input
    currentControls = stepControls(currentControls, DEFAULT_CONTROL_CONFIG, resolved, apparent, FIXED_DT)
    const loads = boatLoads(SUNFISH, current, currentControls, environment)
    current = step(current, SUNFISH.body, loads.wrench, FIXED_DT)
    onStep?.(currentControls.boomAngle)
  }

  return { state: current, controls: currentControls }
}

function describeRun(state: RigidBodyState, controls: ControlState): SailResult {
  return {
    state,
    controls,
    speed: horizontalSpeed(state.velocity),
    headingDegrees: toDegrees(headingAngle(state)),
    heelDegrees: toDegrees(heelAngle(state)),
    boomDegrees: toDegrees(controls.boomAngle),
  }
}

/** Sails under fixed inputs from rest. */
function sail(
  seconds: number,
  input: ControlInput,
  start: RigidBodyState = afloat(-45),
  environment: Environment = flatWater(),
): SailResult {
  const run = sailFrom(seconds, input, start, NEUTRAL_CONTROLS, environment)
  return describeRun(run.state, run.controls)
}

/**
 * Sails a course, holding an apparent wind angle on the helm.
 *
 * This boat carries mild lee helm — its centre of effort sits forward of the
 * combined lateral resistance — so left to itself it bears away and any fixed
 * input measures wherever it happened to drift. A sailor holds a course, and so
 * does this.
 */
function sailCourse(
  seconds: number,
  targetApparentDegrees: number,
  mainsheet: number,
  environment: Environment = flatWater(),
  start: RigidBodyState = afloat(targetApparentDegrees),
): SailResult {
  const target = degrees(targetApparentDegrees)
  const run = sailFrom(
    seconds,
    (apparent) => ({
      mainsheet,
      tiller: Math.max(-1, Math.min(1, -(apparent - target) * 3)),
    }),
    start,
    NEUTRAL_CONTROLS,
    environment,
  )
  return describeRun(run.state, run.controls)
}

describe('makeSunfish', () => {
  it('puts the centre of mass on the buoyancy centroid', () => {
    expect(SUNFISH.centreOfMass[0]).toBe(0)
    expect(SUNFISH.centreOfMass[2]).toBeGreaterThan(0.4)
    expect(SUNFISH.centreOfMass[2]).toBeLessThan(0.6)
  })

  it('floats at the design waterline at its rated displacement', () => {
    expect(solveEquilibriumDraft(SUNFISH.hull, SUNFISH.body.mass)).toBeCloseTo(0, 6)
  })

  it('measures every part from the centre of mass, not the design origin', () => {
    // The manifest puts the gooseneck forward of the origin; after recentring
    // it must be forward of the centre of mass by more than that again.
    const gooseneck = rig.points.pivot_gooseneck
    expect(SUNFISH.sail.pivot[2]).toBeCloseTo(gooseneck[2] - SUNFISH.centreOfMass[2], 12)
    expect(SUNFISH.rudder.pivot[2]).toBeCloseTo(
      rig.foils.rudder.pivot[2] - SUNFISH.centreOfMass[2],
      12,
    )
    // Rudder still aft of the board, board still forward of the rudder.
    expect(SUNFISH.rudder.pivot[2]).toBeGreaterThan(SUNFISH.daggerboard.pivot[2])
  })

  it('gives the rig most of the roll inertia', () => {
    const withoutRig = makeSunfish(rig, { rigMass: 0 })
    expect(SUNFISH.body.inertia[2]).toBeGreaterThan(withoutRig.body.inertia[2] * 2)
    // And pitch and yaw still dominate roll, as they must for a long thin hull.
    expect(SUNFISH.body.inertia[0]).toBeGreaterThan(SUNFISH.body.inertia[2])
    expect(SUNFISH.body.inertia[1]).toBeGreaterThan(SUNFISH.body.inertia[2])
  })

  it('scales the waterplane so a heavier boat still floats on its lines', () => {
    const loaded = makeSunfish(rig, { mass: 200 })
    expect(solveEquilibriumDraft(loaded.hull, 200)).toBeCloseTo(0, 6)
  })
})

describe('attitude helpers', () => {
  it('reads level as level', () => {
    const level = afloat()
    expect(heelAngle(level)).toBeCloseTo(0, 12)
    expect(pitchAngle(level)).toBeCloseTo(0, 12)
  })

  it('reads heel to starboard as positive', () => {
    // A positive roll about +Z lays the mast to port, so heel is negative.
    const toPort = restingState([0, 0, 0], quatFromAxisAngle([0, 0, 1], 0.3))
    const toStarboard = restingState([0, 0, 0], quatFromAxisAngle([0, 0, 1], -0.3))
    expect(heelAngle(toPort)).toBeCloseTo(-0.3, 9)
    expect(heelAngle(toStarboard)).toBeCloseTo(0.3, 9)
  })

  it('reads bow up as positive pitch', () => {
    expect(pitchAngle(restingState([0, 0, 0], quatFromAxisAngle([1, 0, 0], 0.2)))).toBeCloseTo(0.2, 9)
  })

  it('reads heading the same way wave directions are measured', () => {
    // Heading 0 points along +x. The bow is -Z, so that is a quarter turn.
    const bow = quatRotate(afloat(-90).orientation, [0, 0, -1])
    expect(bow[0]).toBeCloseTo(1, 9)
    expect(headingAngle(afloat(-90))).toBeCloseTo(0, 9)
  })
})

describe('boatLoads', () => {
  it('sums to the parts it reports', () => {
    const state = afloat(-45)
    const controls: ControlState = { boomAngle: degrees(20), rudderAngle: 0 }
    const loads = boatLoads(SUNFISH, state, controls, flatWater())

    for (let axis = 0; axis < 3; axis++) {
      const parts =
        loads.hydrostatics.force[axis] +
        loads.sail.force[axis] +
        loads.daggerboard.force[axis] +
        loads.rudder.force[axis] +
        (axis === 1 ? -SUNFISH.body.mass * SUNFISH.gravity : 0)
      expect(loads.wrench.force[axis]).toBeCloseTo(parts, 6)
    }
  })

  it('balances weight against buoyancy for a boat sitting still', () => {
    const loads = boatLoads(SUNFISH, afloat(), NEUTRAL_CONTROLS, {
      trueWind: [0, 0, 0],
      water: stillWater(0),
    })
    expect(loads.wrench.force[1]).toBeCloseTo(0, 3)
    expect(Math.hypot(...loads.wrench.torque)).toBeLessThan(1)
  })

  it('works on a live wave field as well as flat water', () => {
    const field = compileWaveField(tawasPreset({ heading: 0.7 }), { depth: 4 })
    const loads = boatLoads(SUNFISH, afloat(-45), { boomAngle: degrees(20), rudderAngle: 0 }, {
      trueWind: TRUE_WIND,
      water: gerstnerWater(field, 3.5),
    })
    for (let axis = 0; axis < 3; axis++) {
      expect(Number.isFinite(loads.wrench.force[axis])).toBe(true)
      expect(Number.isFinite(loads.wrench.torque[axis])).toBe(true)
    }
    // Waves put the boat somewhere other than dead level, so it is being pushed.
    expect(Math.hypot(...loads.wrench.torque)).toBeGreaterThan(0)
  })
})

describe('the accept criterion — playable', () => {
  it('accelerates from rest when close-hauled', () => {
    expect(sailCourse(30, -45, 0.15).speed).toBeGreaterThan(1)
  })

  it('reaches a steady speed rather than accelerating for ever', () => {
    const short = sailCourse(30, -45, 0.15).speed
    const long = sailCourse(75, -45, 0.15).speed
    expect(long).toBeGreaterThan(short * 0.85)
    expect(long).toBeLessThan(short * 1.25)
  })

  it('sails at speeds a boat of this length actually reaches', () => {
    // Hull speed for a 4.2 m waterline is somewhere near 2.5 m/s, and nothing
    // here should be sailing past it in a four metre a second breeze.
    for (const [apparent, sheet] of [[-45, 0.15], [-90, 0.45], [-135, 0.7]] as const) {
      const sailed = sailCourse(45, apparent, sheet)
      expect(sailed.speed, `apparent ${apparent}`).toBeGreaterThan(0.8)
      expect(sailed.speed, `apparent ${apparent}`).toBeLessThan(3.2)
    }
  })

  it('sails faster off the wind than close-hauled', () => {
    expect(sailCourse(45, -90, 0.45).speed).toBeGreaterThan(sailCourse(45, -45, 0.15).speed)
  })

  it('heels to leeward under sail', () => {
    const sailed = sailCourse(30, -45, 0.15)
    // Wind on the port bow, so it lies down to starboard.
    expect(sailed.heelDegrees).toBeGreaterThan(1)
    expect(sailed.heelDegrees).toBeLessThan(60)
  })

  it('depowers when the sheet is eased, which is the player only defence', () => {
    // No crew hiking is modelled, so in a breeze the boat is overpowered
    // close-hauled and lies right over. Easing the sheet is what fixes it, and
    // that has to work or the boat is not playable in anything fresh.
    const strong: Environment = { trueWind: [0, 0, 6], water: stillWater(0) }
    const pinned = sailCourse(30, -45, 0.1, strong)
    const eased = sailCourse(30, -45, 0.4, strong)

    expect(pinned.heelDegrees).toBeGreaterThan(30)
    expect(eased.heelDegrees).toBeLessThan(pinned.heelDegrees)
  })

  it('will not sail out of the no-go zone', () => {
    const inIrons = sail(30, { mainsheet: 0.1, tiller: 0 }, afloat(0))
    expect(inIrons.speed).toBeLessThan(0.5)
  })

  it('makes leeway, but far less than it makes progress', () => {
    // The daggerboard earning its keep: without it the sail's side force would
    // just push the hull sideways.
    const sailed = sailCourse(40, -45, 0.15)
    const bow = quatRotate(sailed.state.orientation, [0, 0, -1])
    const forward = sailed.state.velocity[0] * bow[0] + sailed.state.velocity[2] * bow[2]
    const sideways = Math.sqrt(Math.max(sailed.speed ** 2 - forward ** 2, 0))
    expect(forward).toBeGreaterThan(0)
    expect(sideways / forward).toBeLessThan(0.5)
  })

  it('steers, and the tiller works the way a tiller works', () => {
    // Build way on a reach first: a rudder with no water flowing over it does
    // nothing, which is its own test further down.
    const environment = flatWater()
    const moving = sailFrom(
      30,
      (apparent) => ({ mainsheet: 0.45, tiller: Math.max(-1, Math.min(1, -(apparent - degrees(-90)) * 3)) }),
      afloat(-90),
      NEUTRAL_CONTROLS,
      environment,
    )
    const from = toDegrees(headingAngle(moving.state))

    const toPort = sailFrom(8, { mainsheet: 0.45, tiller: 1 }, moving.state, moving.controls, environment)
    const toStarboard = sailFrom(8, { mainsheet: 0.45, tiller: -1 }, moving.state, moving.controls, environment)

    const turnedPort = toDegrees(headingAngle(toPort.state)) - from
    const turnedStarboard = toDegrees(headingAngle(toStarboard.state)) - from

    expect(Math.abs(turnedPort)).toBeGreaterThan(10)
    expect(Math.abs(turnedStarboard)).toBeGreaterThan(10)
    expect(Math.sign(turnedPort)).not.toBe(Math.sign(turnedStarboard))

    // Tiller pushed to starboard turns the boat to port. Heading is measured
    // from +x toward +z, and turning to port lowers it.
    expect(turnedPort).toBeLessThan(0)
  })
})

describe('the accept criterion — can tack', () => {
  /** Close-hauled on port tack with way on, ready to put the helm down. */
  function closeHauled(environment: Environment, onStep?: (boomAngle: number) => void) {
    return sailFrom(
      40,
      (apparent) => ({ mainsheet: 0.15, tiller: Math.max(-1, Math.min(1, -(apparent - degrees(-45)) * 3)) }),
      afloat(-45),
      NEUTRAL_CONTROLS,
      environment,
      onStep,
    )
  }

  it('tacks: helm down, through the wind, boom across, away on the new tack', () => {
    const environment = flatWater()
    let run = closeHauled(environment)

    const tackBefore = tackFromBoom(run.controls.boomAngle)
    const headingBefore = toDegrees(headingAngle(run.state))
    expect(tackBefore).not.toBe(0)
    expect(horizontalSpeed(run.state.velocity)).toBeGreaterThan(0.6)

    // Helm down. The wind is on the port bow, so tacking means turning to port,
    // into it — a positive tiller. Turning the other way bears away and the
    // boom never crosses. Then centre the helm and let her carry through: hold
    // it hard over all the way round and rudder drag alone stops the boat.
    run = sailFrom(8, { mainsheet: 0.15, tiller: 1 }, run.state, run.controls, environment)
    run = sailFrom(30, { mainsheet: 0.15, tiller: 0 }, run.state, run.controls, environment)

    const tackAfter = tackFromBoom(run.controls.boomAngle)
    expect(tackAfter).not.toBe(0)
    expect(tackAfter).not.toBe(tackBefore)

    // It really went round, and it is still sailing at the end.
    expect(Math.abs(toDegrees(headingAngle(run.state)) - headingBefore)).toBeGreaterThan(45)
    expect(horizontalSpeed(run.state.velocity)).toBeGreaterThan(0.6)
  })

  it('gybes too: bear away through dead downwind and the boom slams across', () => {
    // Same mechanism as the tack, approached from the other side. The sheet is
    // eased right out, so the boom crosses a much wider arc and hits the rate
    // limit the whole way over — which is exactly what a gybe feels like.
    const environment = flatWater()
    const booms: number[] = []
    const broadReach = (apparent: number): ControlInput => ({
      mainsheet: 0.75,
      tiller: Math.max(-1, Math.min(1, -(apparent - degrees(-135)) * 3)),
    })

    let run = sailFrom(40, broadReach, afloat(-135), NEUTRAL_CONTROLS, environment, (b) => booms.push(b))
    const tackBefore = tackFromBoom(run.controls.boomAngle)
    expect(tackBefore).not.toBe(0)
    const speedBefore = horizontalSpeed(run.state.velocity)

    // Bear away through dead downwind.
    run = sailFrom(14, { mainsheet: 0.75, tiller: -1 }, run.state, run.controls, environment, (b) => booms.push(b))
    run = sailFrom(25, { mainsheet: 0.75, tiller: 0 }, run.state, run.controls, environment, (b) => booms.push(b))

    expect(tackFromBoom(run.controls.boomAngle)).toBe(-tackBefore)
    // The boom swung right across, not just off the centreline.
    expect(Math.min(...booms)).toBeLessThan(degrees(-50))
    expect(Math.max(...booms)).toBeGreaterThan(degrees(50))
    // A gybe keeps way on, unlike a tack, which is why it is the easy one.
    expect(horizontalSpeed(run.state.velocity)).toBeGreaterThan(speedBefore * 0.7)
  })

  it('sweeps the boom across rather than teleporting it', () => {
    const environment = flatWater()
    const booms: number[] = []
    let run = closeHauled(environment, (b) => booms.push(b))
    run = sailFrom(8, { mainsheet: 0.15, tiller: 1 }, run.state, run.controls, environment, (b) => booms.push(b))
    sailFrom(30, { mainsheet: 0.15, tiller: 0 }, run.state, run.controls, environment, (b) => booms.push(b))

    // The boom visited both sides...
    expect(Math.min(...booms)).toBeLessThan(-0.1)
    expect(Math.max(...booms)).toBeGreaterThan(0.1)

    // ...and never moved faster than the rate limit allows, so the crossing
    // reads as a sweep on screen instead of a jump.
    let biggestJump = 0
    for (let i = 1; i < booms.length; i++) {
      biggestJump = Math.max(biggestJump, Math.abs(booms[i] - booms[i - 1]))
    }
    expect(biggestJump).toBeLessThanOrEqual(DEFAULT_CONTROL_CONFIG.boomRate * FIXED_DT + 1e-12)
  })
})

describe('determinism', () => {
  it('reproduces a whole sailing run exactly', () => {
    const a = sail(15, { mainsheet: 0.2, tiller: -0.3 })
    const b = sail(15, { mainsheet: 0.2, tiller: -0.3 })
    expect(b.state).toStrictEqual(a.state)
    expect(b.controls).toStrictEqual(a.controls)
  })

  it('stays finite through a long run in waves', () => {
    const field = compileWaveField(tawasPreset({ heading: 0.7 }), { depth: 4 })
    let state = afloat(-45)
    let controls = NEUTRAL_CONTROLS

    for (let i = 0; i < 120 * 40; i++) {
      const time = i * FIXED_DT
      const environment: Environment = { trueWind: TRUE_WIND, water: gerstnerWater(field, time) }
      const apparent = apparentWindAngle(state, environment.trueWind)
      controls = stepControls(controls, DEFAULT_CONTROL_CONFIG, { mainsheet: 0.2, tiller: 0 }, apparent, FIXED_DT)
      state = step(state, SUNFISH.body, boatLoads(SUNFISH, state, controls, environment).wrench, FIXED_DT)
    }

    expect(Number.isFinite(state.position[1])).toBe(true)
    // Still the right way up and still on the surface.
    expect(Math.abs(toDegrees(heelAngle(state)))).toBeLessThan(60)
    expect(state.position[1]).toBeGreaterThan(-1)
    expect(state.position[1]).toBeLessThan(1)
  })
})
