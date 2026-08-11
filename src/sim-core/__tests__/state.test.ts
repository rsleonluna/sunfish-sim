import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GRAVITY } from '../constants.ts'
import {
  centreOfBuoyancy,
  hydrostaticLoad,
  makeHullConfig,
  recentreProbes,
  solveEquilibriumDraft,
  stillWater,
  uniformProbes,
  waterplaneAreaForDraft,
  type HullConfig,
} from '../hydrostatics.ts'
import { QUAT_IDENTITY, quatFromAxisAngle, quatLength, quatRotate } from '../quat.ts'
import { parseRig } from '../rig.ts'
import {
  FIXED_DT,
  INITIAL_CLOCK,
  MAX_SUBSTEPS,
  ZERO_WRENCH,
  addWrench,
  advance,
  angularMomentum,
  boxInertia,
  gravityWrench,
  gyrationInertia,
  interpolate,
  kineticEnergy,
  makeBody,
  restingState,
  step,
  type RigidBody,
  type RigidBodyState,
  type Wrench,
} from '../state.ts'
import type { Vec3 } from '../vec.ts'

const MANIFEST = new URL('../../../public/models/sunfish-rig.json', import.meta.url)
const rig = parseRig(JSON.parse(readFileSync(fileURLToPath(MANIFEST), 'utf8')))

const SAILING_MASS = 130
const HULL_DEPTH = 0.364
const PROBE_POSITIONS: Vec3[] = rig.probes.map((probe) => probe.position)
const WATERPLANE_AREA = waterplaneAreaForDraft(PROBE_POSITIONS, SAILING_MASS, 0, HULL_DEPTH)

/**
 * The Sunfish as a rigid body, with the probe set moved onto the centre of
 * mass.
 *
 * Stage 4 showed the buoyancy centroid sits about 0.48 m aft of the design
 * origin, so the centre of mass has to go there or the hull carries a standing
 * bow-down moment it can never trim out.
 */
function sunfish(): { body: RigidBody; hull: HullConfig; centreOfMass: Vec3 } {
  const designProbes = uniformProbes(PROBE_POSITIONS, WATERPLANE_AREA, HULL_DEPTH)
  const lcb = centreOfBuoyancy(designProbes, 0)
  const centreOfMass: Vec3 = [0, 0, lcb[2]]

  const hull = makeHullConfig(recentreProbes(designProbes, centreOfMass))
  // Hull box plus the rig's mass carried well above the deck; the roll moment
  // is what the mast dominates.
  const body = makeBody(SAILING_MASS, boxInertia(SAILING_MASS, [rig.hull.beam, HULL_DEPTH, rig.hull.loa]))

  return { body, hull, centreOfMass }
}

function freeBody(): RigidBody {
  return makeBody(2, [0.5, 1.25, 2])
}

/** Runs the boat in flat water for a while and reports where it ends up. */
function floatFor(
  seconds: number,
  start: RigidBodyState,
): { state: RigidBodyState; steps: number } {
  const { body, hull } = sunfish()
  const water = stillWater(0)
  const weight = gravityWrench(body, GRAVITY)

  let state = start
  const steps = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < steps; i++) {
    const load = hydrostaticLoad(hull, state, water)
    state = step(state, body, addWrench(weight, { force: load.force, torque: load.torque }), FIXED_DT)
  }
  return { state, steps }
}

describe('body properties', () => {
  it('rejects a nonsense body', () => {
    expect(() => makeBody(0, [1, 1, 1])).toThrow(/mass/)
    expect(() => makeBody(-3, [1, 1, 1])).toThrow(/mass/)
    expect(() => makeBody(1, [0, 1, 1])).toThrow(/inertia\[0\]/)
    expect(() => makeBody(1, [1, 1, Number.NaN])).toThrow(/inertia\[2\]/)
  })

  it('computes box inertia about the right axes', () => {
    // A long thin hull resists pitch and yaw far more than roll.
    const inertia = boxInertia(130, [1.24, 0.364, 4.19])
    expect(inertia[0]).toBeGreaterThan(inertia[2])
    expect(inertia[1]).toBeGreaterThan(inertia[2])
    expect(inertia[0]).toBeCloseTo((130 * (0.364 ** 2 + 4.19 ** 2)) / 12, 9)
  })

  it('agrees with radii of gyration', () => {
    const size: Vec3 = [2, 4, 6]
    const box = boxInertia(3, size)
    const radii: Vec3 = [
      Math.sqrt(box[0] / 3),
      Math.sqrt(box[1] / 3),
      Math.sqrt(box[2] / 3),
    ]
    const gyration = gyrationInertia(3, radii)
    for (let i = 0; i < 3; i++) expect(gyration[i]).toBeCloseTo(box[i], 9)
  })

  it('puts weight at the centre of mass, so it makes no torque', () => {
    const weight = gravityWrench(makeBody(130, [1, 1, 1]), GRAVITY)
    expect(weight.force).toEqual([0, -130 * GRAVITY, 0])
    expect(weight.torque).toEqual([0, 0, 0])
  })
})

describe('linear motion', () => {
  const body = freeBody()

  it('coasts in a straight line with no force', () => {
    let state: RigidBodyState = {
      position: [0, 0, 0],
      orientation: QUAT_IDENTITY,
      velocity: [1.5, -0.5, 2],
      angularVelocity: [0, 0, 0],
    }
    for (let i = 0; i < 240; i++) state = step(state, body, ZERO_WRENCH, FIXED_DT)

    expect(state.velocity).toEqual([1.5, -0.5, 2])
    expect(state.position[0]).toBeCloseTo(1.5 * 2, 9)
    expect(state.position[1]).toBeCloseTo(-0.5 * 2, 9)
    expect(state.position[2]).toBeCloseTo(2 * 2, 9)
  })

  it('gets velocity exactly right under constant acceleration', () => {
    const wrench: Wrench = { force: [0, -body.mass * GRAVITY, 0], torque: [0, 0, 0] }
    let state = restingState([0, 0, 0], QUAT_IDENTITY)
    const steps = 360
    for (let i = 0; i < steps; i++) state = step(state, body, wrench, FIXED_DT)

    // Semi-implicit Euler integrates velocity exactly for a constant force.
    expect(state.velocity[1]).toBeCloseTo(-GRAVITY * steps * FIXED_DT, 9)
  })

  it('matches the closed form of its own position update', () => {
    // Not the continuous answer: symplectic Euler lands half a step ahead of
    // it, and the discrete sum is the thing worth pinning.
    const wrench: Wrench = { force: [0, -body.mass * GRAVITY, 0], torque: [0, 0, 0] }
    let state = restingState([0, 5, 0], QUAT_IDENTITY)
    const steps = 120
    for (let i = 0; i < steps; i++) state = step(state, body, wrench, FIXED_DT)

    const expected = 5 - GRAVITY * FIXED_DT * FIXED_DT * ((steps * (steps + 1)) / 2)
    expect(state.position[1]).toBeCloseTo(expected, 9)
    // And it should sit within one step of the continuous solution.
    const continuous = 5 - 0.5 * GRAVITY * (steps * FIXED_DT) ** 2
    expect(Math.abs(state.position[1] - continuous)).toBeLessThan(GRAVITY * FIXED_DT * steps * FIXED_DT)
  })

  it('does not couple linear motion into rotation', () => {
    let state = restingState([0, 0, 0], QUAT_IDENTITY)
    for (let i = 0; i < 120; i++) {
      state = step(state, body, { force: [10, 4, -7], torque: [0, 0, 0] }, FIXED_DT)
    }
    expect(state.angularVelocity).toEqual([0, 0, 0])
    expect(state.orientation).toEqual(QUAT_IDENTITY)
  })
})

describe('rotational motion', () => {
  const body = freeBody()

  it('keeps the orientation a unit quaternion', () => {
    let state: RigidBodyState = {
      position: [0, 0, 0],
      orientation: QUAT_IDENTITY,
      velocity: [0, 0, 0],
      angularVelocity: [1.3, -2.1, 0.7],
    }
    for (let i = 0; i < 1200; i++) {
      state = step(state, body, ZERO_WRENCH, FIXED_DT)
      expect(quatLength(state.orientation)).toBeCloseTo(1, 12)
    }
  })

  it('spins steadily about a principal axis', () => {
    // Spin about body Y, a principal axis, so the gyroscopic term vanishes.
    const rate = 1.5
    let state: RigidBodyState = {
      position: [0, 0, 0],
      orientation: QUAT_IDENTITY,
      velocity: [0, 0, 0],
      angularVelocity: [0, rate, 0],
    }
    for (let i = 0; i < 120; i++) state = step(state, body, ZERO_WRENCH, FIXED_DT)

    expect(state.angularVelocity[0]).toBeCloseTo(0, 12)
    expect(state.angularVelocity[1]).toBeCloseTo(rate, 12)
    expect(state.angularVelocity[2]).toBeCloseTo(0, 12)

    // After one second it has turned by rate radians about +Y.
    const turned = quatRotate(state.orientation, [1, 0, 0])
    expect(Math.atan2(-turned[2], turned[0])).toBeCloseTo(rate, 3)
  })

  it('accelerates least about the axis with least inertia', () => {
    const spin = (axis: number): number => {
      const torque: Vec3 = [0, 0, 0]
      const applied = [...torque] as [number, number, number]
      applied[axis] = 1
      let state = restingState([0, 0, 0], QUAT_IDENTITY)
      for (let i = 0; i < 60; i++) {
        state = step(state, body, { force: [0, 0, 0], torque: applied }, FIXED_DT)
      }
      return Math.abs(state.angularVelocity[axis])
    }
    // inertia is [0.5, 1.25, 2], so the same torque spins X up fastest.
    expect(spin(0)).toBeGreaterThan(spin(1))
    expect(spin(1)).toBeGreaterThan(spin(2))
  })

  it('conserves angular momentum with no torque', () => {
    let state: RigidBodyState = {
      position: [0, 0, 0],
      orientation: QUAT_IDENTITY,
      velocity: [0, 0, 0],
      angularVelocity: [0.8, 1.6, -0.4],
    }
    const initial = angularMomentum(state, body)

    for (let i = 0; i < 1200; i++) state = step(state, body, ZERO_WRENCH, FIXED_DT)

    const final = angularMomentum(state, body)
    for (let i = 0; i < 3; i++) {
      expect(final[i], `axis ${i}`).toBeCloseTo(initial[i], 2)
    }
  })

  it('tumbles when spun about the intermediate axis', () => {
    // The tennis-racket theorem: spin about the middle moment is unstable, so
    // a small perturbation must grow. This is the payoff for keeping the
    // gyroscopic term rather than dropping it.
    let state: RigidBodyState = {
      position: [0, 0, 0],
      orientation: QUAT_IDENTITY,
      velocity: [0, 0, 0],
      angularVelocity: [0.01, 6, 0.01],
    }
    let worstOffAxis = 0
    for (let i = 0; i < 1200; i++) {
      state = step(state, body, ZERO_WRENCH, FIXED_DT)
      worstOffAxis = Math.max(worstOffAxis, Math.hypot(state.angularVelocity[0], state.angularVelocity[2]))
    }
    expect(worstOffAxis).toBeGreaterThan(1)
  })

  it('holds a realistic spin on the largest moment', () => {
    // At rates a hull actually sees, the axis stays put. Spun much faster the
    // first-order energy drift tilts it — see the convergence test below.
    let state: RigidBodyState = {
      position: [0, 0, 0],
      orientation: QUAT_IDENTITY,
      velocity: [0, 0, 0],
      angularVelocity: [0.005, 0.005, 1],
    }
    let worstOffAxis = 0
    for (let i = 0; i < 1200; i++) {
      state = step(state, body, ZERO_WRENCH, FIXED_DT)
      worstOffAxis = Math.max(worstOffAxis, Math.hypot(state.angularVelocity[0], state.angularVelocity[1]))
    }
    expect(worstOffAxis).toBeLessThan(0.05)
  })

  it('leaks energy only as fast as a first-order scheme should', () => {
    // Semi-implicit Euler does not conserve energy for a tumbling body. What
    // matters is that the error is truncation error and converges away, not
    // that it is absent — so assert the convergence, which is the real claim.
    // Ten seconds, not a hundred: at 1/120 over 100 s the drift reaches 75% and
    // compounds, which leaves the asymptotic regime where the order is
    // measurable at all.
    const driftOver10s = (dt: number): number => {
      let state: RigidBodyState = {
        position: [0, 0, 0],
        orientation: QUAT_IDENTITY,
        velocity: [0, 0, 0],
        angularVelocity: [1.1, 0.4, -0.9],
      }
      const initial = kineticEnergy(state, body)
      for (let i = 0; i < Math.round(10 / dt); i++) state = step(state, body, ZERO_WRENCH, dt)
      return kineticEnergy(state, body) / initial - 1
    }

    const coarse = driftOver10s(FIXED_DT)
    const fine = driftOver10s(FIXED_DT / 2)
    const finer = driftOver10s(FIXED_DT / 4)

    expect(coarse).toBeGreaterThan(0)
    // Halving the step halves the drift: that is what first order means.
    expect(fine / coarse).toBeGreaterThan(0.4)
    expect(fine / coarse).toBeLessThan(0.6)
    expect(finer / fine).toBeGreaterThan(0.4)
    expect(finer / fine).toBeLessThan(0.6)
  })

  it('conserves angular momentum far better than energy', () => {
    // Momentum conservation is structural here, not a tolerance: torque
    // integrates it directly, so with no torque it simply does not change.
    let state: RigidBodyState = {
      position: [0, 0, 0],
      orientation: QUAT_IDENTITY,
      velocity: [0, 0, 0],
      angularVelocity: [1.1, 0.4, -0.9],
    }
    const initial = angularMomentum(state, body)
    for (let i = 0; i < 12000; i++) state = step(state, body, ZERO_WRENCH, FIXED_DT)
    const final = angularMomentum(state, body)

    const magnitude = Math.hypot(initial[0], initial[1], initial[2])
    const error = Math.hypot(final[0] - initial[0], final[1] - initial[1], final[2] - initial[2])
    expect(error / magnitude).toBeLessThan(1e-9)
  })

  it('sheds energy rather than gaining it once the hull is in the water', () => {
    // The drift above is irrelevant to the boat: drag dominates it completely.
    const { body: hullBody, hull } = sunfish()
    const water = stillWater(0)
    const weight = gravityWrench(hullBody, GRAVITY)
    let state: RigidBodyState = {
      position: [0, 0, 0],
      orientation: QUAT_IDENTITY,
      velocity: [0, 0, 0],
      angularVelocity: [0.3, 0, 0.6],
    }
    const initial = kineticEnergy(state, hullBody)
    for (let i = 0; i < 600; i++) {
      const load = hydrostaticLoad(hull, state, water)
      state = step(state, hullBody, addWrench(weight, { force: load.force, torque: load.torque }), FIXED_DT)
    }
    expect(kineticEnergy(state, hullBody)).toBeLessThan(initial * 0.1)
  })
})

describe('fixed-step accumulator', () => {
  const body = freeBody()
  const noForces = (): Wrench => ZERO_WRENCH

  it('runs two steps for a 60 Hz frame', () => {
    const result = advance(restingState([0, 0, 0], QUAT_IDENTITY), body, INITIAL_CLOCK, 1 / 60, noForces)
    expect(result.steps).toBe(2)
    expect(result.clock.time).toBeCloseTo(2 * FIXED_DT, 12)
    expect(result.clock.remainder).toBeCloseTo(0, 12)
    expect(result.dropped).toBe(0)
  })

  it('carries the remainder across frames instead of losing it', () => {
    let state = restingState([0, 0, 0], QUAT_IDENTITY)
    let clock = INITIAL_CLOCK
    let total = 0

    // 100 Hz frames do not divide the 120 Hz step, so every frame leaves some.
    for (let frame = 0; frame < 100; frame++) {
      const result = advance(state, body, clock, 1 / 100, noForces)
      state = result.state
      clock = result.clock
      total += result.steps
      expect(clock.remainder).toBeGreaterThanOrEqual(0)
      expect(clock.remainder).toBeLessThan(FIXED_DT)
    }

    // One second of frames must buy 120 steps, give or take the one in flight.
    expect(total).toBeGreaterThanOrEqual(119)
    expect(total).toBeLessThanOrEqual(120)
    expect(clock.time).toBeCloseTo(total * FIXED_DT, 12)
  })

  it('reports alpha as the fraction of a step still pending', () => {
    const half = advance(restingState([0, 0, 0], QUAT_IDENTITY), body, INITIAL_CLOCK, FIXED_DT * 1.5, noForces)
    expect(half.steps).toBe(1)
    expect(half.alpha).toBeCloseTo(0.5, 9)
    expect(half.alpha).toBeGreaterThanOrEqual(0)
    expect(half.alpha).toBeLessThan(1)
  })

  it('does nothing for a frame shorter than a step', () => {
    const state = restingState([0, 3, 0], QUAT_IDENTITY)
    const result = advance(state, body, INITIAL_CLOCK, FIXED_DT / 3, noForces)
    expect(result.steps).toBe(0)
    expect(result.state).toBe(state)
    expect(result.previous).toBe(state)
  })

  it('caps the substeps and reports what it dropped', () => {
    // A one-second stall must not try to run 120 steps in one frame.
    const result = advance(restingState([0, 0, 0], QUAT_IDENTITY), body, INITIAL_CLOCK, 1, noForces)
    expect(result.steps).toBe(MAX_SUBSTEPS)
    expect(result.dropped).toBeGreaterThan(0)
    expect(result.clock.remainder).toBeLessThan(FIXED_DT)
    expect(result.steps * FIXED_DT + result.dropped + result.clock.remainder).toBeCloseTo(1, 9)
  })

  it('samples forces at each substep, not once per frame', () => {
    const seen: number[] = []
    advance(restingState([0, 0, 0], QUAT_IDENTITY), body, INITIAL_CLOCK, FIXED_DT * 4, (_, time) => {
      seen.push(time)
      return ZERO_WRENCH
    })
    expect(seen).toHaveLength(4)
    for (let i = 0; i < seen.length; i++) expect(seen[i]).toBeCloseTo(i * FIXED_DT, 12)
  })

  it('rejects a nonsense frame time', () => {
    const state = restingState([0, 0, 0], QUAT_IDENTITY)
    expect(() => advance(state, body, INITIAL_CLOCK, -1, noForces)).toThrow(/frameTime/)
    expect(() => advance(state, body, INITIAL_CLOCK, Number.NaN, noForces)).toThrow(/frameTime/)
  })

  it('gives the same trajectory whatever the frame boundaries are', () => {
    // The whole point of the accumulator: rendering cadence must not change
    // the physics.
    const gravity = (): Wrench => ({ force: [0, -body.mass * GRAVITY, 0], torque: [0, 0, 0] })
    const run = (frameTime: number, frames: number): RigidBodyState => {
      let state = restingState([0, 10, 0], QUAT_IDENTITY)
      let clock = INITIAL_CLOCK
      for (let i = 0; i < frames; i++) {
        const result = advance(state, body, clock, frameTime, gravity)
        state = result.state
        clock = result.clock
      }
      return state
    }

    // 120 steps' worth of time, delivered as 60 Hz frames and as 240 Hz frames.
    const slow = run(1 / 60, 60)
    const fast = run(1 / 240, 240)
    expect(fast.position[1]).toBeCloseTo(slow.position[1], 9)
    expect(fast.velocity[1]).toBeCloseTo(slow.velocity[1], 9)
  })
})

describe('render interpolation', () => {
  const a = restingState([0, 0, 0], QUAT_IDENTITY)
  const b: RigidBodyState = {
    position: [2, 4, -6],
    orientation: quatFromAxisAngle([0, 1, 0], 0.6),
    velocity: [1, 2, 3],
    angularVelocity: [0.1, 0.2, 0.3],
  }

  it('returns the endpoints at alpha 0 and 1', () => {
    const start = interpolate(a, b, 0)
    expect(start.position).toEqual(a.position)
    for (let i = 0; i < 4; i++) expect(start.orientation[i]).toBeCloseTo(a.orientation[i], 12)

    const end = interpolate(a, b, 1)
    expect(end.position).toEqual(b.position)
    for (let i = 0; i < 4; i++) expect(end.orientation[i]).toBeCloseTo(b.orientation[i], 12)
  })

  it('lands halfway at alpha 0.5', () => {
    const middle = interpolate(a, b, 0.5)
    expect(middle.position).toEqual([1, 2, -3])
    expect(middle.velocity).toEqual([0.5, 1, 1.5])
    // Half of a 0.6 rad turn about +Y.
    const turned = quatRotate(middle.orientation, [1, 0, 0])
    expect(Math.atan2(-turned[2], turned[0])).toBeCloseTo(0.3, 9)
  })

  it('keeps the blended orientation unit length', () => {
    for (let alpha = 0; alpha <= 1; alpha += 0.05) {
      expect(quatLength(interpolate(a, b, alpha).orientation)).toBeCloseTo(1, 12)
    }
  })

  it('takes the short way round', () => {
    // Two orientations 350 degrees apart the long way, 10 the short way.
    const from = quatFromAxisAngle([0, 1, 0], -Math.PI + 0.05)
    const to = quatFromAxisAngle([0, 1, 0], Math.PI - 0.05)
    const middle = interpolate({ ...a, orientation: from }, { ...a, orientation: to }, 0.5)
    const turned = quatRotate(middle.orientation, [1, 0, 0])
    // Going the short way passes through the half turn, not through zero.
    expect(Math.abs(Math.atan2(-turned[2], turned[0]))).toBeGreaterThan(3)
  })
})

describe('the accept criteria', () => {
  it('drops from 0.5 m and damps to a steady float', () => {
    const { body, hull } = sunfish()
    const expectedDraft = solveEquilibriumDraft(hull, body.mass)
    const settled = floatFor(30, restingState([0, 0.5, 0], QUAT_IDENTITY))

    expect(settled.state.position[1]).toBeCloseTo(-expectedDraft, 4)
    expect(Math.abs(settled.state.velocity[1])).toBeLessThan(1e-4)

    // Steady means steady in every degree of freedom, not just heave.
    expect(Math.hypot(...settled.state.velocity)).toBeLessThan(1e-4)
    expect(Math.hypot(...settled.state.angularVelocity)).toBeLessThan(1e-4)
    expect(quatLength(settled.state.orientation)).toBeCloseTo(1, 12)
  })

  it('sits level once settled, because the mass is on the buoyancy centroid', () => {
    const settled = floatFor(30, restingState([0, 0.5, 0], QUAT_IDENTITY))
    const up = quatRotate(settled.state.orientation, [0, 1, 0])
    // Mast still pointing at the sky, to within a tenth of a degree.
    expect(up[1]).toBeGreaterThan(Math.cos(0.002))
  })

  it('rights itself after being dropped heeled over', () => {
    const heeled = restingState([0, 0.4, 0], quatFromAxisAngle([0, 0, 1], 0.5))
    const settled = floatFor(40, heeled)

    const up = quatRotate(settled.state.orientation, [0, 1, 0])
    expect(up[1]).toBeGreaterThan(Math.cos(0.01))
    expect(Math.hypot(...settled.state.angularVelocity)).toBeLessThan(1e-3)
  })

  it('never leaves the water going down, or dives through the bottom', () => {
    const { body, hull } = sunfish()
    const water = stillWater(0)
    const weight = gravityWrench(body, GRAVITY)
    let state = restingState([0, 0.5, 0], QUAT_IDENTITY)

    for (let i = 0; i < 120 * 30; i++) {
      const load = hydrostaticLoad(hull, state, water)
      state = step(state, body, addWrench(weight, { force: load.force, torque: load.torque }), FIXED_DT)
      expect(Number.isFinite(state.position[1])).toBe(true)
      expect(state.position[1]).toBeLessThan(0.6)
      expect(state.position[1]).toBeGreaterThan(-0.5)
    }
  })

  it('gives bit-identical output for an identical input sequence', () => {
    const { body, hull } = sunfish()
    const water = stillWater(0)
    const weight = gravityWrench(body, GRAVITY)

    // Deliberately awkward start: off-axis spin and a tilt, so every term in
    // the integrator is exercised, not just heave.
    const start: RigidBodyState = {
      position: [0.25, 0.45, -0.75],
      orientation: quatFromAxisAngle([0.3, 0.5, 0.81], 0.42),
      velocity: [0.6, -1.2, 0.3],
      angularVelocity: [0.4, -0.7, 0.9],
    }

    const run = (): RigidBodyState => {
      let state = start
      for (let i = 0; i < 1800; i++) {
        const load = hydrostaticLoad(hull, state, water)
        state = step(state, body, addWrench(weight, { force: load.force, torque: load.torque }), FIXED_DT)
      }
      return state
    }

    const first = run()
    const second = run()

    expect(second.position).toStrictEqual(first.position)
    expect(second.orientation).toStrictEqual(first.orientation)
    expect(second.velocity).toStrictEqual(first.velocity)
    expect(second.angularVelocity).toStrictEqual(first.angularVelocity)
  })

  it('gives bit-identical output through the accumulator too', () => {
    const { body, hull } = sunfish()
    const water = stillWater(0)
    const weight = gravityWrench(body, GRAVITY)
    const forces = (state: RigidBodyState): Wrench => {
      const load = hydrostaticLoad(hull, state, water)
      return addWrench(weight, { force: load.force, torque: load.torque })
    }

    // An irregular frame cadence, replayed exactly.
    const frames = [1 / 60, 1 / 61, 1 / 58, 1 / 144, 1 / 30, 1 / 59.94]
    const run = (): RigidBodyState => {
      let state = restingState([0, 0.5, 0], quatFromAxisAngle([0, 0, 1], 0.2))
      let clock = INITIAL_CLOCK
      for (let i = 0; i < 600; i++) {
        const result = advance(state, body, clock, frames[i % frames.length], forces)
        state = result.state
        clock = result.clock
      }
      return state
    }

    expect(run()).toStrictEqual(run())
  })

  it('does not depend on how the run is chopped into calls', () => {
    const { body } = sunfish()
    const wrench: Wrench = { force: [3, -7, 2], torque: [0.4, -0.2, 0.9] }
    const forces = (): Wrench => wrench

    const oneGo = advance(restingState([0, 0, 0], QUAT_IDENTITY), body, INITIAL_CLOCK, FIXED_DT * 4, forces)

    let state = restingState([0, 0, 0], QUAT_IDENTITY)
    let clock = INITIAL_CLOCK
    for (let i = 0; i < 4; i++) {
      const result = advance(state, body, clock, FIXED_DT, forces)
      state = result.state
      clock = result.clock
    }

    expect(state).toStrictEqual(oneGo.state)
  })
})
