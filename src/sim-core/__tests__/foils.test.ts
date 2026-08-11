import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WATER_DENSITY } from '../constants.ts'
import {
  foilLoad,
  leewayAngle,
  makeFoilConfig,
  type FoilBodyState,
  type FoilConfig,
} from '../foils.ts'
import { QUAT_IDENTITY, quatFromAxisAngle, quatRotate } from '../quat.ts'
import { parseRig } from '../rig.ts'
import type { Vec3 } from '../vec.ts'

const MANIFEST = new URL('../../../public/models/sunfish-rig.json', import.meta.url)
const rig = parseRig(JSON.parse(readFileSync(fileURLToPath(MANIFEST), 'utf8')))

const BOARD: FoilConfig = makeFoilConfig(
  rig.foils.daggerboard.pivot,
  rig.foils.daggerboard.span,
  rig.foils.daggerboard.planformArea,
  rig.foils.daggerboard.aspectRatio,
)

const RUDDER: FoilConfig = makeFoilConfig(
  rig.foils.rudder.pivot,
  rig.foils.rudder.span,
  rig.foils.rudder.planformArea,
  rig.foils.rudder.aspectRatio,
)

const degrees = (value: number): number => (value * Math.PI) / 180

/**
 * A boat making way, with an optional leeway angle.
 *
 * Bow is -Z, so going straight ahead is boat-frame velocity (0, 0, -speed).
 * Positive leeway slides the boat to starboard of where it points.
 */
function sailing(speed: number, leewayDegrees = 0, yawDegrees = 0): FoilBodyState {
  const orientation = quatFromAxisAngle([0, 1, 0], degrees(yawDegrees))
  const leeway = degrees(leewayDegrees)
  const bodyVelocity: Vec3 = [speed * Math.sin(leeway), 0, -speed * Math.cos(leeway)]
  return {
    position: [0, 0, 0],
    orientation,
    velocity: quatRotate(orientation, bodyVelocity),
    angularVelocity: [0, 0, 0],
  }
}

describe('makeFoilConfig', () => {
  it('hangs the centre of pressure below the pivot', () => {
    expect(BOARD.centreOfPressure[1]).toBeLessThan(BOARD.pivot[1])
    expect(RUDDER.centreOfPressure[1]).toBeLessThan(RUDDER.pivot[1])
    // And below the waterline, or it could not make side force at all.
    expect(BOARD.centreOfPressure[1]).toBeLessThan(0)
    expect(RUDDER.centreOfPressure[1]).toBeLessThan(0)
  })

  it('keeps the blade on the centreline, at the pivot station', () => {
    for (const foil of [BOARD, RUDDER]) {
      expect(foil.centreOfPressure[0]).toBeCloseTo(foil.pivot[0], 12)
      expect(foil.centreOfPressure[2]).toBeCloseTo(foil.pivot[2], 12)
    }
  })

  it('puts the rudder aft of the board', () => {
    // Bow is -Z, so aft is greater Z.
    expect(RUDDER.pivot[2]).toBeGreaterThan(BOARD.pivot[2])
  })

  it('carries the manifest areas through', () => {
    expect(BOARD.area).toBeCloseTo(rig.foils.daggerboard.planformArea, 12)
    expect(RUDDER.area).toBeCloseTo(rig.foils.rudder.planformArea, 12)
    expect(BOARD.area).toBeGreaterThan(RUDDER.area)
  })
})

describe('leewayAngle', () => {
  it('is zero going straight ahead', () => {
    expect(leewayAngle(sailing(3))).toBeCloseTo(0, 12)
  })

  it('is positive when the boat slides to starboard of its heading', () => {
    expect(leewayAngle(sailing(3, 5))).toBeCloseTo(degrees(5), 9)
    expect(leewayAngle(sailing(3, -5))).toBeCloseTo(degrees(-5), 9)
  })

  it('does not depend on the heading', () => {
    for (const yaw of [-120, -45, 0, 30, 170]) {
      expect(leewayAngle(sailing(3, 7, yaw)), `yaw ${yaw}`).toBeCloseTo(degrees(7), 9)
    }
  })

  it('does not depend on speed', () => {
    for (const speed of [0.5, 2, 9]) {
      expect(leewayAngle(sailing(speed, 4))).toBeCloseTo(degrees(4), 9)
    }
  })

  it('measures motion through the water, not over the ground', () => {
    // A boat drifting with a current has no leeway: the blade feels nothing.
    const current: Vec3 = [1.2, 0, -0.4]
    const drifting: FoilBodyState = {
      position: [0, 0, 0],
      orientation: QUAT_IDENTITY,
      velocity: current,
      angularVelocity: [0, 0, 0],
    }
    expect(leewayAngle(drifting, current)).toBe(0)
  })

  it('is zero rather than undefined when dead in the water', () => {
    expect(leewayAngle(sailing(0))).toBe(0)
  })
})

describe('the daggerboard', () => {
  it('resists leeway: sliding to starboard pushes back to port', () => {
    // This is the whole reason a sailboat has a board. Without it the sail's
    // side force just slides the hull sideways.
    const load = foilLoad(BOARD, sailing(3, 6))
    expect(load.sideForce).toBeLessThan(0)
  })

  it('resists leeway the other way too, by the same amount', () => {
    const starboard = foilLoad(BOARD, sailing(3, 6))
    const port = foilLoad(BOARD, sailing(3, -6))
    expect(port.sideForce).toBeCloseTo(-starboard.sideForce, 9)
  })

  it('makes more side force the harder the boat slides, until it stalls', () => {
    let previous = 0
    for (const leeway of [1, 2, 4, 6, 8]) {
      const side = Math.abs(foilLoad(BOARD, sailing(3, leeway)).sideForce)
      expect(side, `leeway ${leeway}`).toBeGreaterThan(previous)
      previous = side
    }
    // Slam it sideways and the blade gives up.
    expect(foilLoad(BOARD, sailing(3, 45)).stalled).toBe(true)
  })

  it('makes far more side force than drag at a working leeway angle', () => {
    // A useful foil has a high lift-to-drag ratio; that ratio is what lets a
    // boat convert side force into progress to windward.
    const load = foilLoad(BOARD, sailing(3, 4))
    expect(Math.abs(load.sideForce) / Math.abs(load.drive)).toBeGreaterThan(3)
  })

  it('can push the boat forward at leeway, but never does net work on it', () => {
    // Lift is perpendicular to the flow, not to the hull, so at leeway some of
    // it points forward — that is genuine, and it is how a foil converts side
    // force into progress. What a passive blade can never do is add energy, so
    // the invariant to hold is that force dotted with velocity stays negative.
    expect(foilLoad(BOARD, sailing(3, 30)).drive).toBeGreaterThan(0)

    for (const leeway of [-45, -30, -10, -3, 3, 10, 30, 45]) {
      const body = sailing(3, leeway)
      const load = foilLoad(BOARD, body)
      const power =
        load.force[0] * body.velocity[0] +
        load.force[1] * body.velocity[1] +
        load.force[2] * body.velocity[2]
      expect(power, `leeway ${leeway}`).toBeLessThan(0)
    }
  })

  it('goes as the square of boat speed', () => {
    const slow = foilLoad(BOARD, sailing(2, 5))
    const fast = foilLoad(BOARD, sailing(4, 5))
    expect(fast.sideForce / slow.sideForce).toBeCloseTo(4, 6)
  })

  it('produces nothing when the boat is stopped', () => {
    const load = foilLoad(BOARD, sailing(0))
    expect(load.force).toEqual([0, 0, 0])
    expect(load.torque).toEqual([0, 0, 0])
    expect(load.flowSpeed).toBe(0)
  })

  it('adds to the heel rather than opposing it', () => {
    // Not the intuitive answer, and worth pinning. The sail pushes the top of
    // the rig to leeward and the board pushes the bottom of the hull to
    // windward: the two form a couple, and both terms roll the boat the same
    // way. That couple is why heeling moment is reckoned over the height from
    // the centre of lateral resistance up to the centre of effort.
    const load = foilLoad(BOARD, sailing(3, 6))
    expect(load.sideForce).toBeLessThan(0)
    // Side force to port, below the waterline, heels the boat to starboard.
    expect(load.torque[2]).toBeLessThan(0)
  })

  it('feels a current the same way it feels boat speed', () => {
    const still = foilLoad(BOARD, sailing(3, 6))
    const withCurrent = foilLoad(BOARD, sailing(3, 6), { waterVelocity: sailing(3, 6).velocity })
    // Moving exactly with the water means no flow over the blade at all.
    expect(withCurrent.flowSpeed).toBeCloseTo(0, 9)
    expect(still.flowSpeed).toBeGreaterThan(2)
  })

  it('uses fresh water by default', () => {
    const fresh = foilLoad(BOARD, sailing(3, 5))
    const salt = foilLoad(BOARD, sailing(3, 5), { waterDensity: 1025 })
    expect(salt.sideForce / fresh.sideForce).toBeCloseTo(1025 / WATER_DENSITY, 9)
  })
})

describe('the rudder', () => {
  it('makes no side force sitting straight with no leeway', () => {
    expect(foilLoad(RUDDER, sailing(3)).sideForce).toBeCloseTo(0, 9)
    expect(foilLoad(RUDDER, sailing(3)).torque[1]).toBeCloseTo(0, 9)
  })

  it('turns the boat to starboard when the blade goes to starboard', () => {
    const load = foilLoad(RUDDER, sailing(3), { deflection: degrees(15) })

    // Trailing edge to starboard pushes the stern to port.
    expect(load.sideForce).toBeLessThan(0)

    // Which swings the bow to starboard. A positive turn about +Y takes the
    // bow toward port, so turning to starboard is a negative yaw moment.
    expect(load.torque[1]).toBeLessThan(0)
  })

  it('turns to port for the opposite helm, by the same amount', () => {
    const starboard = foilLoad(RUDDER, sailing(3), { deflection: degrees(15) })
    const port = foilLoad(RUDDER, sailing(3), { deflection: degrees(-15) })
    expect(port.torque[1]).toBeCloseTo(-starboard.torque[1], 9)
    expect(port.torque[1]).toBeGreaterThan(0)
  })

  it('bites harder with more helm, and pays for it once stalled', () => {
    let previous = 0
    for (const helm of [3, 6, 10, 12]) {
      const turning = Math.abs(foilLoad(RUDDER, sailing(3), { deflection: degrees(helm) }).torque[1])
      expect(turning, `helm ${helm}`).toBeGreaterThan(previous)
      previous = turning
    }

    // A blade jammed right over does not stop turning the boat — a stalled
    // plate still shoves the stern sideways. What collapses is its efficiency,
    // and on a low-aspect blade that is the whole penalty.
    const working = foilLoad(RUDDER, sailing(3), { deflection: degrees(10) })
    const jammed = foilLoad(RUDDER, sailing(3), { deflection: degrees(45) })

    expect(working.stalled).toBe(false)
    expect(jammed.stalled).toBe(true)
    // Magnitudes: a blade at positive helm runs at negative angle of attack,
    // so both ratios are negative and comparing them signed would invert this.
    const workingRatio = Math.abs(working.coefficients.lift / working.coefficients.drag)
    const jammedRatio = Math.abs(jammed.coefficients.lift / jammed.coefficients.drag)
    expect(workingRatio).toBeGreaterThan(5)
    expect(jammedRatio).toBeLessThan(workingRatio / 3)
  })

  it('does nothing at all with no way on', () => {
    // No steerage way: the classic reason a boat in irons cannot be steered out.
    const load = foilLoad(RUDDER, sailing(0), { deflection: degrees(30) })
    expect(load.torque).toEqual([0, 0, 0])
  })

  it('turns harder the faster the boat is going', () => {
    const slow = Math.abs(foilLoad(RUDDER, sailing(1.5), { deflection: degrees(10) }).torque[1])
    const fast = Math.abs(foilLoad(RUDDER, sailing(3), { deflection: degrees(10) }).torque[1])
    expect(fast / slow).toBeCloseTo(4, 6)
  })

  it('adds its own leeway to the helm angle', () => {
    // A boat already sliding to starboard meets the blade at an angle before
    // the helm is even touched.
    const straight = foilLoad(RUDDER, sailing(3, 5), { deflection: 0 })
    expect(straight.angleOfAttack).not.toBeCloseTo(0, 3)
    // Matching helm to leeway lines the blade up with the flow.
    const matched = foilLoad(RUDDER, sailing(3, 5), { deflection: degrees(-5) })
    expect(Math.abs(matched.angleOfAttack)).toBeLessThan(Math.abs(straight.angleOfAttack))
  })
})

describe('board and rudder together', () => {
  it('gives the board most of the lateral resistance', () => {
    const board = Math.abs(foilLoad(BOARD, sailing(3, 5)).sideForce)
    const rudder = Math.abs(foilLoad(RUDDER, sailing(3, 5)).sideForce)
    expect(board).toBeGreaterThan(rudder)
  })

  it('lets the smaller rudder out-turn the board, on lever alone', () => {
    // The board carries the side force; the rudder, with barely two thirds the
    // area but a lever twenty times as long, carries the steering.
    const board = foilLoad(BOARD, sailing(3, 5))
    const rudder = foilLoad(RUDDER, sailing(3, 5))

    expect(RUDDER.area).toBeLessThan(BOARD.area)
    expect(Math.abs(rudder.torque[1])).toBeGreaterThan(Math.abs(board.torque[1]) * 5)
  })

  it('never returns a non-finite load', () => {
    for (const foil of [BOARD, RUDDER]) {
      for (let leeway = -180; leeway <= 180; leeway += 10) {
        for (const helm of [-40, -10, 0, 10, 40]) {
          const load = foilLoad(foil, sailing(3, leeway), { deflection: degrees(helm) })
          for (let i = 0; i < 3; i++) {
            expect(Number.isFinite(load.force[i]), `leeway ${leeway} helm ${helm}`).toBe(true)
            expect(Number.isFinite(load.torque[i]), `leeway ${leeway} helm ${helm}`).toBe(true)
          }
        }
      }
    }
  })

  it('is deterministic', () => {
    const body = sailing(2.7, 4.5, -33)
    const input = { deflection: degrees(8) }
    const first = foilLoad(RUDDER, body, input)
    for (let i = 0; i < 32; i++) {
      const again = foilLoad(RUDDER, body, input)
      expect(again.force).toStrictEqual(first.force)
      expect(again.torque).toStrictEqual(first.torque)
    }
  })
})
