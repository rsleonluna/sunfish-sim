import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GRAVITY, WATER_DENSITY } from '../constants.ts'
import {
  DEFAULT_LINEAR_DRAG,
  DEFAULT_QUADRATIC_DRAG,
  centreOfBuoyancy,
  displacedVolumeAtDraft,
  hydrostaticLoad,
  makeHullConfig,
  solveEquilibriumDraft,
  stillWater,
  uniformProbes,
  waterplaneAreaForDraft,
  type BodyState,
  type HullConfig,
  type WaterSampler,
} from '../hydrostatics.ts'
import { QUAT_IDENTITY, quatFromAxisAngle, quatRotate } from '../quat.ts'
import { parseRig } from '../rig.ts'
import type { Vec3 } from '../vec.ts'

const MANIFEST = new URL('../../../public/models/sunfish-rig.json', import.meta.url)
const rig = parseRig(JSON.parse(readFileSync(fileURLToPath(MANIFEST), 'utf8')))
const PROBE_POSITIONS: Vec3[] = rig.probes.map((probe) => probe.position)

/**
 * Sunfish hull is 130 lb; add a skipper and the sailing displacement is around
 * 130 kg. The waterplane area is then solved so the boat floats at exactly the
 * design waterline, which is the datum the manifest's probes are measured from.
 */
const SAILING_MASS = 130
/** Hull bottom to deck: below this the station can still gain buoyancy. */
const HULL_DEPTH = 0.364

const WATERPLANE_AREA = waterplaneAreaForDraft(PROBE_POSITIONS, SAILING_MASS, 0, HULL_DEPTH)

function sunfishHull(overrides: Partial<Omit<HullConfig, 'probes'>> = {}): HullConfig {
  return makeHullConfig(uniformProbes(PROBE_POSITIONS, WATERPLANE_AREA, HULL_DEPTH), overrides)
}

/**
 * Draft is positive-down: it is how far the boat origin has sunk below the
 * surface. With the water at height 0 that makes `position.y = -draft`.
 */
function heightForDraft(draft: number): number {
  return -draft
}

function restingBody(y: number, orientation = QUAT_IDENTITY): BodyState {
  return {
    position: [0, y, 0],
    orientation,
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  }
}

/**
 * One-DOF heave integrator, standing in for Stage 5. Semi-implicit Euler at the
 * project's fixed 1/120 s so the accept criterion is exercised the way the real
 * loop will drive it.
 */
function settleHeave(
  hull: HullConfig,
  mass: number,
  startY: number,
  seconds: number,
  water: WaterSampler = stillWater(0),
): { y: number; velocity: number; steps: number } {
  const dt = 1 / 120
  const steps = Math.round(seconds / dt)
  let y = startY
  let velocity = 0

  for (let i = 0; i < steps; i++) {
    const load = hydrostaticLoad(
      hull,
      { position: [0, y, 0], orientation: QUAT_IDENTITY, velocity: [0, velocity, 0], angularVelocity: [0, 0, 0] },
      water,
    )
    const acceleration = load.force[1] / mass - hull.gravity
    velocity += acceleration * dt
    y += velocity * dt
  }

  return { y, velocity, steps }
}

describe('probe set calibration', () => {
  it('solves a waterplane area that floats the Sunfish at its design waterline', () => {
    // Sanity on the model rather than on my arithmetic: roughly LOA x beam x a
    // dinghy waterplane coefficient, so a few square metres.
    expect(WATERPLANE_AREA).toBeGreaterThan(2)
    expect(WATERPLANE_AREA).toBeLessThan(4)
    // Waterplane area cannot exceed the rectangle the hull sits in.
    expect(WATERPLANE_AREA).toBeLessThan(rig.hull.loa * rig.hull.beam)
  })

  it('displaces exactly the sailing mass at zero draft', () => {
    const hull = sunfishHull()
    expect(displacedVolumeAtDraft(hull.probes, 0)).toBeCloseTo(SAILING_MASS / WATER_DENSITY, 12)
  })

  it('leaves the bow probes dry at the design waterline', () => {
    // The manifest puts the forward triple above the datum: the bow rides clear.
    const dry = rig.probes.filter((probe) => probe.position[1] > 0)
    expect(dry.map((probe) => probe.name)).toEqual(['probe_00', 'probe_01', 'probe_02'])
  })

  it('rejects a degenerate probe set', () => {
    expect(() => uniformProbes([], 3, 0.3)).toThrow(/at least one probe/)
    expect(() => uniformProbes(PROBE_POSITIONS, 0, 0.3)).toThrow(/waterplaneArea/)
    expect(() => uniformProbes(PROBE_POSITIONS, 3, -1)).toThrow(/maxDepth/)
    // Above every probe, nothing is wet, so no area can carry the load.
    expect(() => waterplaneAreaForDraft(PROBE_POSITIONS, 130, -0.5, 0.364)).toThrow(/no probe/)
  })
})

describe('displaced volume', () => {
  const hull = sunfishHull()

  it('is zero above the shallowest probe and rises monotonically', () => {
    const shallowest = Math.min(...PROBE_POSITIONS.map((p) => p[1]))
    expect(displacedVolumeAtDraft(hull.probes, shallowest - 1e-9)).toBe(0)

    let previous = -1
    for (let draft = -0.2; draft <= 0.6; draft += 0.01) {
      const volume = displacedVolumeAtDraft(hull.probes, draft)
      expect(volume).toBeGreaterThanOrEqual(previous)
      previous = volume
    }
  })

  it('saturates once every station is buried', () => {
    const full = WATERPLANE_AREA * HULL_DEPTH
    expect(displacedVolumeAtDraft(hull.probes, 100)).toBeCloseTo(full, 9)
    expect(displacedVolumeAtDraft(hull.probes, 1000)).toBeCloseTo(full, 9)
  })
})

describe('equilibrium draft', () => {
  const hull = sunfishHull()

  it('puts the sailing mass exactly on the design waterline', () => {
    expect(solveEquilibriumDraft(hull, SAILING_MASS)).toBeCloseTo(0, 9)
  })

  it('sinks the boat deeper as it is loaded', () => {
    const light = solveEquilibriumDraft(hull, 80)
    const heavy = solveEquilibriumDraft(hull, 200)
    expect(light).toBeLessThan(0)
    expect(heavy).toBeGreaterThan(0)
    expect(heavy).toBeGreaterThan(light)
  })

  it('balances weight against buoyancy at the solved draft', () => {
    for (const mass of [60, 95, 130, 180, 240]) {
      const draft = solveEquilibriumDraft(hull, mass)
      const buoyancy = WATER_DENSITY * GRAVITY * displacedVolumeAtDraft(hull.probes, draft)
      expect(buoyancy).toBeCloseTo(mass * GRAVITY, 6)
    }
  })

  it('reports a swamped hull rather than an absurd draft', () => {
    const capacity = WATER_DENSITY * WATERPLANE_AREA * HULL_DEPTH
    expect(solveEquilibriumDraft(hull, capacity * 1.1)).toBe(Infinity)
  })

  it('rejects a nonsense mass', () => {
    expect(() => solveEquilibriumDraft(hull, 0)).toThrow(/mass/)
    expect(() => solveEquilibriumDraft(hull, -5)).toThrow(/mass/)
  })
})

describe('settling — the accept criterion', () => {
  const hull = sunfishHull()

  it('settles from 0.5 m up to a stable draft matching hull mass', () => {
    const expected = heightForDraft(solveEquilibriumDraft(hull, SAILING_MASS))
    const settled = settleHeave(hull, SAILING_MASS, 0.5, 20)

    expect(settled.y).toBeCloseTo(expected, 5)
    expect(Math.abs(settled.velocity)).toBeLessThan(1e-4)
  })

  it('settles from below the surface up to the same draft', () => {
    const expected = heightForDraft(solveEquilibriumDraft(hull, SAILING_MASS))
    const settled = settleHeave(hull, SAILING_MASS, -0.3, 20)
    expect(settled.y).toBeCloseTo(expected, 5)
    expect(settled.steps).toBe(2400)
  })

  it('settles deeper when more weight is aboard, and matches the solver each time', () => {
    let previous = Infinity
    for (const mass of [70, 100, 130, 175, 220]) {
      const settled = settleHeave(hull, mass, 0.5, 25)
      const expected = heightForDraft(solveEquilibriumDraft(hull, mass))
      expect(settled.y, `mass ${mass} kg`).toBeCloseTo(expected, 4)
      expect(settled.y, `mass ${mass} kg floats lower`).toBeLessThan(previous)
      previous = settled.y
    }
  })

  it('stays put once settled', () => {
    const expected = heightForDraft(solveEquilibriumDraft(hull, SAILING_MASS))
    const settled = settleHeave(hull, SAILING_MASS, expected, 10)
    expect(settled.y).toBeCloseTo(expected, 8)
    expect(Math.abs(settled.velocity)).toBeLessThan(1e-6)
  })

  it('damps rather than rings: each swing is smaller than the last', () => {
    const expected = heightForDraft(solveEquilibriumDraft(hull, SAILING_MASS))
    const dt = 1 / 120
    let y = 0.5
    let velocity = 0
    let previousSign = 0
    const peaks: number[] = []

    for (let i = 0; i < 120 * 30; i++) {
      const load = hydrostaticLoad(
        hull,
        { position: [0, y, 0], orientation: QUAT_IDENTITY, velocity: [0, velocity, 0], angularVelocity: [0, 0, 0] },
        stillWater(0),
      )
      velocity += (load.force[1] / SAILING_MASS - hull.gravity) * dt
      y += velocity * dt
      expect(Number.isFinite(y)).toBe(true)

      const sign = Math.sign(velocity)
      if (previousSign !== 0 && sign !== 0 && sign !== previousSign) {
        const amplitude = Math.abs(y - expected)
        // Stop once the swing is smaller than a nanometre: past that the motion
        // is rounding noise, not physics, and monotonicity stops meaning
        // anything.
        if (amplitude > 1e-9) peaks.push(amplitude)
      }
      previousSign = sign
    }

    // It really does oscillate, and every swing is smaller than the one before.
    expect(peaks.length).toBeGreaterThan(3)
    for (let i = 1; i < peaks.length; i++) {
      expect(peaks[i]).toBeLessThan(peaks[i - 1])
    }
  })

  it('is damped near the ratio the default drag targets', () => {
    // Heave stiffness rho*g*A over mass gives the natural frequency; the log
    // decrement of the free response gives the damping ratio that came out.
    const expected = heightForDraft(solveEquilibriumDraft(hull, SAILING_MASS))
    const dt = 1 / 120
    let y = expected + 0.05
    let velocity = 0
    let previousSign = 0
    const peaks: number[] = []

    for (let i = 0; i < 120 * 20; i++) {
      const load = hydrostaticLoad(
        hull,
        { position: [0, y, 0], orientation: QUAT_IDENTITY, velocity: [0, velocity, 0], angularVelocity: [0, 0, 0] },
        stillWater(0),
      )
      velocity += (load.force[1] / SAILING_MASS - hull.gravity) * dt
      y += velocity * dt
      const sign = Math.sign(velocity)
      if (previousSign !== 0 && sign !== 0 && sign !== previousSign) peaks.push(Math.abs(y - expected))
      previousSign = sign
    }

    // Successive peaks are half a cycle apart, so the log decrement over one
    // full cycle uses peaks two apart.
    const decrement = Math.log(peaks[0] / peaks[2])
    const ratio = decrement / Math.sqrt(4 * Math.PI ** 2 + decrement ** 2)
    expect(ratio).toBeGreaterThan(0.15)
    expect(ratio).toBeLessThan(0.5)
  })
})

describe('forces at rest', () => {
  const hull = sunfishHull()
  const water = stillWater(0)

  it('carries the weight exactly at the equilibrium draft', () => {
    const draft = solveEquilibriumDraft(hull, SAILING_MASS)
    const load = hydrostaticLoad(hull, restingBody(draft), water)
    expect(load.force[1]).toBeCloseTo(SAILING_MASS * GRAVITY, 6)
    expect(load.displacedVolume).toBeCloseTo(SAILING_MASS / WATER_DENSITY, 9)
  })

  it('produces no force at all when the hull is clear of the water', () => {
    const load = hydrostaticLoad(hull, restingBody(5), water)
    expect(load.force).toEqual([0, 0, 0])
    expect(load.torque).toEqual([0, 0, 0])
    expect(load.wettedProbes).toBe(0)
    expect(load.displacedVolume).toBe(0)
    expect(load.probes.every((probe) => probe.depth < 0)).toBe(true)
  })

  it('is purely vertical, with only asset-level roll asymmetry', () => {
    const load = hydrostaticLoad(hull, restingBody(0), water)
    expect(load.force[0]).toBeCloseTo(0, 12)
    expect(load.force[2]).toBeCloseTo(0, 12)
    expect(load.torque[1]).toBeCloseTo(0, 12)
    // The manifest's port and starboard probes differ by a few tenths of a
    // millimetre in height, from the subdivision surface. That leaves a real
    // but negligible roll moment: well under a thousandth of the righting
    // moment at a quarter radian of heel.
    expect(Math.abs(load.torque[2])).toBeLessThan(0.05)
  })

  it('trims bow-down, because the buoyancy centroid is aft of the origin', () => {
    const load = hydrostaticLoad(hull, restingBody(0), water)
    const lcb = centreOfBuoyancy(hull.probes, 0)

    // The forward probe triple sits above the datum and stays dry, so all the
    // lift is aft. Bow is -Z, so lift aft of the origin drives the bow down.
    expect(lcb[2]).toBeGreaterThan(0.4)
    expect(load.torque[0]).toBeLessThan(0)

    // With every force vertical, the trim moment is exactly -Fy * z_cb. Stage 5
    // has to put the centre of mass here or the boat sails permanently bow-down.
    expect(load.torque[0]).toBeCloseTo(-load.force[1] * lcb[2], 9)
  })

  it('counts wetted probes as the hull sinks', () => {
    // Higher position.y means the boat rides higher and fewer probes are wet.
    expect(hydrostaticLoad(hull, restingBody(0.15), water).wettedProbes).toBe(0)
    expect(hydrostaticLoad(hull, restingBody(0), water).wettedProbes).toBe(9)
    expect(hydrostaticLoad(hull, restingBody(-0.05), water).wettedProbes).toBe(9)
    expect(hydrostaticLoad(hull, restingBody(-0.15), water).wettedProbes).toBe(12)
  })

  it('reports per-probe detail that sums to the total', () => {
    const load = hydrostaticLoad(hull, restingBody(0.05), water)
    expect(load.probes).toHaveLength(12)
    const summed = load.probes.reduce((sum, probe) => sum + probe.buoyancy, 0)
    expect(summed).toBeCloseTo(load.force[1], 9)
    const volume = load.probes.reduce((sum, probe) => sum + probe.displacedVolume, 0)
    expect(volume).toBeCloseTo(load.displacedVolume, 12)
  })
})

describe('righting moments', () => {
  const hull = sunfishHull()
  const water = stillWater(0)

  it('rights the boat when heeled to starboard', () => {
    // Heel about the bow axis (+Z). Buoyancy must push back the other way.
    const heel = quatFromAxisAngle([0, 0, 1], 0.25)
    const load = hydrostaticLoad(hull, restingBody(0, heel), water)
    expect(load.torque[2]).toBeLessThan(0)
  })

  it('rights the boat when heeled to port, by the same amount', () => {
    const toPort = hydrostaticLoad(hull, restingBody(0, quatFromAxisAngle([0, 0, 1], -0.25)), water)
    const toStarboard = hydrostaticLoad(hull, restingBody(0, quatFromAxisAngle([0, 0, 1], 0.25)), water)
    expect(toPort.torque[2]).toBeGreaterThan(0)
    // Not exactly equal: the asset's own port/starboard asymmetry shows up here
    // too, at a few parts in a hundred thousand.
    const asymmetry = Math.abs(toPort.torque[2] + toStarboard.torque[2]) / Math.abs(toStarboard.torque[2])
    expect(asymmetry).toBeLessThan(1e-3)
  })

  it('grows the righting moment with heel angle, over the useful range', () => {
    let previous = 0
    for (const angle of [0.05, 0.1, 0.2, 0.3, 0.4]) {
      const load = hydrostaticLoad(hull, restingBody(0, quatFromAxisAngle([0, 0, 1], angle)), water)
      const righting = -load.torque[2]
      expect(righting, `heel ${angle} rad`).toBeGreaterThan(previous)
      previous = righting
    }
  })

  it('resists pitch in both directions', () => {
    // Level trim already carries a bow-down moment, so what matters is the
    // change: burying the bow must push it back up relative to level.
    const level = hydrostaticLoad(hull, restingBody(0), water).torque[0]
    const bowDown = hydrostaticLoad(hull, restingBody(0, quatFromAxisAngle([1, 0, 0], -0.15)), water).torque[0]
    const bowUp = hydrostaticLoad(hull, restingBody(0, quatFromAxisAngle([1, 0, 0], 0.15)), water).torque[0]

    expect(bowDown).toBeGreaterThan(level)
    expect(bowUp).toBeLessThan(level)
  })

  it('places probes in the world using the orientation', () => {
    const heel = quatFromAxisAngle([0, 0, 1], 0.3)
    const load = hydrostaticLoad(hull, restingBody(0.1, heel), water)
    for (let i = 0; i < hull.probes.length; i++) {
      const rotated = quatRotate(heel, hull.probes[i].position)
      expect(load.probes[i].world[0]).toBeCloseTo(rotated[0], 12)
      expect(load.probes[i].world[1]).toBeCloseTo(0.1 + rotated[1], 12)
      expect(load.probes[i].world[2]).toBeCloseTo(rotated[2], 12)
    }
  })
})

describe('drag', () => {
  const hull = sunfishHull()
  const water = stillWater(0)

  function heaveDrag(velocity: number): number {
    const load = hydrostaticLoad(
      hull,
      { position: [0, 0, 0], orientation: QUAT_IDENTITY, velocity: [0, velocity, 0], angularVelocity: [0, 0, 0] },
      water,
    )
    return load.probes.reduce((sum, probe) => sum + probe.drag[1], 0)
  }

  it('opposes motion in every direction', () => {
    for (const velocity of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [-0.6, 0.3, 0.9],
    ] as Vec3[]) {
      const load = hydrostaticLoad(
        hull,
        { position: [0, 0, 0], orientation: QUAT_IDENTITY, velocity, angularVelocity: [0, 0, 0] },
        water,
      )
      const drag = load.probes.reduce(
        (sum, probe) => [sum[0] + probe.drag[0], sum[1] + probe.drag[1], sum[2] + probe.drag[2]],
        [0, 0, 0],
      )
      const along = drag[0] * velocity[0] + drag[1] * velocity[1] + drag[2] * velocity[2]
      expect(along).toBeLessThan(0)
    }
  })

  it('is linear at low speed and quadratic at high speed', () => {
    // At a millimetre a second the quadratic term is negligible beside the
    // linear one, so doubling speed doubles the force.
    expect(heaveDrag(0.002) / heaveDrag(0.001)).toBeCloseTo(2, 2)

    // At 20 m/s the quadratic term dominates by 30:1, so it should nearly
    // quadruple instead.
    expect(heaveDrag(40) / heaveDrag(20)).toBeGreaterThan(3.85)
    expect(heaveDrag(40) / heaveDrag(20)).toBeLessThan(4.0)
  })

  it('matches the closed-form drag for a fully wetted probe set', () => {
    const deep = -5
    const speed = 1.5
    const load = hydrostaticLoad(
      hull,
      { position: [0, deep, 0], orientation: QUAT_IDENTITY, velocity: [0, -speed, 0], angularVelocity: [0, 0, 0] },
      water,
    )
    // Every probe is buried past maxDepth, so wetness is 1 across the board.
    const expected = WATERPLANE_AREA * (DEFAULT_LINEAR_DRAG * speed + DEFAULT_QUADRATIC_DRAG * speed * speed)
    const drag = load.probes.reduce((sum, probe) => sum + probe.drag[1], 0)
    expect(drag).toBeCloseTo(expected, 6)
  })

  it('vanishes when the probe moves with the water', () => {
    const current: Vec3 = [0.8, -0.2, 0.35]
    const movingWater: WaterSampler = () => ({ height: 0, velocity: current })
    const load = hydrostaticLoad(
      hull,
      { position: [0, 0, 0], orientation: QUAT_IDENTITY, velocity: current, angularVelocity: [0, 0, 0] },
      movingWater,
    )
    for (const probe of load.probes) {
      expect(probe.drag[0]).toBeCloseTo(0, 12)
      expect(probe.drag[1]).toBeCloseTo(0, 12)
      expect(probe.drag[2]).toBeCloseTo(0, 12)
    }
  })

  it('damps rotation through the probes offset from the centre', () => {
    const load = hydrostaticLoad(
      hull,
      { position: [0, 0, 0], orientation: QUAT_IDENTITY, velocity: [0, 0, 0], angularVelocity: [0, 0, 1.2] },
      water,
    )
    // Roll rate is +Z, so the damping torque must be -Z.
    expect(load.torque[2]).toBeLessThan(0)
  })

  it('is absent on a dry probe', () => {
    const load = hydrostaticLoad(
      hull,
      { position: [0, 5, 0], orientation: QUAT_IDENTITY, velocity: [3, 3, 3], angularVelocity: [1, 1, 1] },
      water,
    )
    expect(load.force).toEqual([0, 0, 0])
  })
})

describe('centre of buoyancy', () => {
  const hull = sunfishHull()

  it('sits on the centreline', () => {
    for (const draft of [-0.02, 0, 0.05, 0.2]) {
      expect(Math.abs(centreOfBuoyancy(hull.probes, draft)[0])).toBeLessThan(1e-3)
    }
  })

  it('moves forward as the bow buries', () => {
    // Sinking the hull wets the forward triple, dragging the centroid toward -Z.
    const shallow = centreOfBuoyancy(hull.probes, 0)[2]
    const deep = centreOfBuoyancy(hull.probes, 0.25)[2]
    expect(deep).toBeLessThan(shallow)
  })

  it('is the origin when the hull is clear of the water', () => {
    expect(centreOfBuoyancy(hull.probes, -1)).toEqual([0, 0, 0])
  })
})

describe('determinism', () => {
  const hull = sunfishHull()

  it('gives bit-identical loads for repeated calls', () => {
    const body: BodyState = {
      position: [1.5, -0.04, -2.25],
      orientation: quatFromAxisAngle([0.3, 0.5, 0.81], 0.42),
      velocity: [0.7, -0.25, 1.1],
      angularVelocity: [0.15, -0.4, 0.6],
    }
    const water: WaterSampler = (x, z) => ({
      height: 0.05 * Math.sin(x * 0.9) + 0.03 * Math.cos(z * 1.4),
      velocity: [0.1, 0.02, -0.05],
    })

    const first = hydrostaticLoad(hull, body, water)
    for (let i = 0; i < 32; i++) {
      const again = hydrostaticLoad(hull, body, water)
      expect(again.force).toStrictEqual(first.force)
      expect(again.torque).toStrictEqual(first.torque)
      expect(again.displacedVolume).toBe(first.displacedVolume)
    }
  })

  it('reproduces a settle trajectory exactly', () => {
    const a = settleHeave(hull, SAILING_MASS, 0.4, 6)
    const b = settleHeave(hull, SAILING_MASS, 0.4, 6)
    expect(a.y).toBe(b.y)
    expect(a.velocity).toBe(b.velocity)
  })
})
