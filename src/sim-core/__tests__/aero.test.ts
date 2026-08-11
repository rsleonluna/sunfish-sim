import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  apparentWind,
  makeSailConfig,
  sailCamber,
  sailLoad,
  swingAboutPivot,
  type SailBodyState,
  type SailConfig,
} from '../aero.ts'
import { QUAT_IDENTITY, quatFromAxisAngle, quatRotate } from '../quat.ts'
import { parseRig, requirePoint } from '../rig.ts'
import type { Vec3 } from '../vec.ts'

const MANIFEST = new URL('../../../public/models/sunfish-rig.json', import.meta.url)
const rig = parseRig(JSON.parse(readFileSync(fileURLToPath(MANIFEST), 'utf8')))

/** Geometric centroid of the sail triangle, straight from the manifest. */
const CENTRE_OF_EFFORT: Vec3 = [
  (rig.sail.head[0] + rig.sail.tack[0] + rig.sail.clew[0]) / 3,
  (rig.sail.head[1] + rig.sail.tack[1] + rig.sail.clew[1]) / 3,
  (rig.sail.head[2] + rig.sail.tack[2] + rig.sail.clew[2]) / 3,
]

const SAIL: SailConfig = makeSailConfig(
  rig.sail.areaBuilt,
  CENTRE_OF_EFFORT,
  requirePoint(rig, 'point_mastfoot'),
  rig.sail.luff,
)

const WIND_SPEED = 5
/**
 * True wind blowing toward +Z. Bow is -Z, so a boat at yaw 0 is head to wind,
 * and yawing negative puts the wind on the port bow.
 */
const TRUE_WIND: Vec3 = [0, 0, WIND_SPEED]

const degrees = (value: number): number => (value * Math.PI) / 180

/** A boat on a heading, optionally making way along its own bow direction. */
function boat(yawDegrees: number, speed = 0): SailBodyState {
  const orientation = quatFromAxisAngle([0, 1, 0], degrees(yawDegrees))
  const forward = quatRotate(orientation, [0, 0, -1])
  return {
    position: [0, 0, 0],
    orientation,
    velocity: [forward[0] * speed, 0, forward[2] * speed],
    angularVelocity: [0, 0, 0],
  }
}

describe('apparentWind', () => {
  it('is the true wind minus the point velocity', () => {
    expect(apparentWind([0, 0, 5], [1, 0, -2])).toEqual([-1, 0, 7])
  })

  it('is the true wind for a boat sitting still', () => {
    expect(apparentWind(TRUE_WIND, [0, 0, 0])).toEqual(TRUE_WIND)
  })

  it('strengthens as the boat sails into it', () => {
    // Boat heading into the wind at yaw 0 moves toward -Z; the wind blows +Z.
    const still = sailLoad(SAIL, boat(-45, 0), { trueWind: TRUE_WIND, sheetAngle: degrees(20) })
    const moving = sailLoad(SAIL, boat(-45, 2), { trueWind: TRUE_WIND, sheetAngle: degrees(20) })
    expect(moving.apparentSpeed).toBeGreaterThan(still.apparentSpeed)
  })

  it('draws the apparent wind forward as the boat accelerates', () => {
    // The classic close-hauled effect: sail faster and the wind moves ahead.
    const still = sailLoad(SAIL, boat(-45, 0), { trueWind: TRUE_WIND, sheetAngle: degrees(20) })
    const moving = sailLoad(SAIL, boat(-45, 3), { trueWind: TRUE_WIND, sheetAngle: degrees(20) })
    expect(Math.abs(moving.apparentAngle)).toBeLessThan(Math.abs(still.apparentAngle))
  })

  it('counts the rig own motion, not just the hull motion', () => {
    const rolling: SailBodyState = {
      position: [0, 0, 0],
      orientation: QUAT_IDENTITY,
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 1.5],
    }
    const still: SailBodyState = { ...rolling, angularVelocity: [0, 0, 0] }
    const a = sailLoad(SAIL, rolling, { trueWind: TRUE_WIND, sheetAngle: 0 })
    const b = sailLoad(SAIL, still, { trueWind: TRUE_WIND, sheetAngle: 0 })
    // The centre of effort is nearly two metres up, so rolling sweeps it hard.
    expect(a.apparentWind[0]).not.toBeCloseTo(b.apparentWind[0], 3)
  })
})

describe('sailCamber', () => {
  it('is flat with the sheet hard in and full when eased right out', () => {
    expect(sailCamber(SAIL, 0)).toBeCloseTo(SAIL.flatCamber, 12)
    expect(sailCamber(SAIL, SAIL.camberEaseAngle)).toBeCloseTo(SAIL.fullCamber, 12)
  })

  it('grows as the sheet is eased, and stops at full', () => {
    let previous = -1
    for (const sheet of [0, 0.2, 0.5, 0.9, 1.3, 1.6]) {
      const camber = sailCamber(SAIL, sheet)
      expect(camber).toBeGreaterThanOrEqual(previous)
      previous = camber
    }
    expect(sailCamber(SAIL, 10)).toBeCloseTo(SAIL.fullCamber, 12)
  })

  it('does not care which side the boom is on', () => {
    expect(sailCamber(SAIL, -0.7)).toBeCloseTo(sailCamber(SAIL, 0.7), 12)
  })

  it('is the value the load reports, so the mesh morph can follow it', () => {
    for (const sheet of [0, 0.3, 0.8, 1.2]) {
      const load = sailLoad(SAIL, boat(-45), { trueWind: TRUE_WIND, sheetAngle: sheet })
      expect(load.camber).toBeCloseTo(sailCamber(SAIL, sheet), 12)
    }
  })

  it('can be overridden without changing the sheet', () => {
    const load = sailLoad(SAIL, boat(-45), { trueWind: TRUE_WIND, sheetAngle: 0.35, camber: 0.11 })
    expect(load.camber).toBe(0.11)
  })
})

describe('swingAboutPivot', () => {
  it('leaves the point alone at zero sheet', () => {
    const pivot = requirePoint(rig, 'point_mastfoot')
    const swung = swingAboutPivot(CENTRE_OF_EFFORT, pivot, 0)
    for (let i = 0; i < 3; i++) expect(swung[i]).toBeCloseTo(CENTRE_OF_EFFORT[i], 12)
  })

  it('swings the clew to starboard for a positive sheet angle', () => {
    const pivot = requirePoint(rig, 'point_mastfoot')
    // The clew is aft of the mast, so easing it out swings it to starboard.
    // This must match the chord direction sailLoad builds, or the heel moment
    // comes out right while the yaw moment comes out backwards.
    expect(swingAboutPivot(rig.sail.clew, pivot, degrees(30))[0]).toBeGreaterThan(0)
    expect(swingAboutPivot(rig.sail.clew, pivot, degrees(-30))[0]).toBeLessThan(0)
  })

  it('keeps the height and the distance from the pivot', () => {
    const pivot = requirePoint(rig, 'point_mastfoot')
    const radius = Math.hypot(
      rig.sail.clew[0] - pivot[0],
      rig.sail.clew[2] - pivot[2],
    )
    for (const angle of [0.2, 0.9, -1.4]) {
      const swung = swingAboutPivot(rig.sail.clew, pivot, angle)
      expect(swung[1]).toBe(rig.sail.clew[1])
      expect(Math.hypot(swung[0] - pivot[0], swung[2] - pivot[2])).toBeCloseTo(radius, 12)
    }
  })
})

describe('the accept criterion', () => {
  it('close-hauled produces forward drive plus heel', () => {
    // Wind on the port bow, boom eased to starboard, which is leeward.
    const load = sailLoad(SAIL, boat(-45), { trueWind: TRUE_WIND, sheetAngle: degrees(20) })

    expect(load.fill).toBeCloseTo(1, 6)
    expect(load.drive).toBeGreaterThan(0)

    // Side force to leeward, which here is starboard.
    expect(load.sideForce).toBeGreaterThan(0)

    // And that side force, two metres up, lays the boat over to leeward. A
    // positive roll about +Z is heel to port, so heel to starboard is negative.
    expect(load.torque[2]).toBeLessThan(0)

    // Heel should dominate drive: this is a boat that needs sitting out.
    expect(Math.abs(load.sideForce)).toBeGreaterThan(load.drive)
  })

  it('head to wind stalls', () => {
    const load = sailLoad(SAIL, boat(0), { trueWind: TRUE_WIND, sheetAngle: 0 })

    // The sail cannot fill: there is no side for it to set to.
    expect(load.fill).toBeCloseTo(0, 6)
    expect(load.lift).toBeCloseTo(0, 9)

    // What is left is drag, pushing the boat backwards.
    expect(load.drive).toBeLessThan(0)
    expect(load.sideForce).toBeCloseTo(0, 6)
  })

  it('stays stalled head to wind however the sheet is set', () => {
    for (const sheet of [-40, -20, 0, 20, 40]) {
      const load = sailLoad(SAIL, boat(0), { trueWind: TRUE_WIND, sheetAngle: degrees(sheet) })
      expect(load.fill, `sheet ${sheet}`).toBeLessThan(0.05)
      expect(load.drive, `sheet ${sheet}`).toBeLessThan(0)
    }
  })

  it('cannot be made to drive forward inside the no-go zone', () => {
    // Sweep every sheet angle at 20 degrees off the wind: nothing works.
    let best = -Infinity
    for (let sheet = -90; sheet <= 90; sheet += 2) {
      best = Math.max(best, sailLoad(SAIL, boat(-15), { trueWind: TRUE_WIND, sheetAngle: degrees(sheet) }).drive)
    }
    expect(best).toBeLessThan(5)
  })
})

describe('points of sail', () => {
  /** Best drive available at a heading, over every sheet angle. */
  function bestDrive(yawDegrees: number, speed = 0): number {
    let best = -Infinity
    for (let sheet = 0; sheet <= 90; sheet += 1) {
      best = Math.max(best, sailLoad(SAIL, boat(yawDegrees, speed), { trueWind: TRUE_WIND, sheetAngle: degrees(sheet) }).drive)
    }
    return best
  }

  it('makes more drive the further it bears away, up to the beam', () => {
    let previous = -Infinity
    for (const heading of [-15, -30, -45, -60, -75, -90]) {
      const drive = bestDrive(heading)
      expect(drive, `heading ${heading}`).toBeGreaterThan(previous)
      previous = drive
    }
  })

  it('peaks on a reach rather than dead downwind', () => {
    // Not the intuitive answer. Off the wind the sail is a parachute limited to
    // drag; on a reach it still works as a wing, and a wing beats a parachute.
    let peak = -Infinity
    let peakHeading = 0
    for (let heading = -180; heading <= 0; heading += 15) {
      const drive = bestDrive(heading)
      if (drive > peak) {
        peak = drive
        peakHeading = heading
      }
    }
    expect(peakHeading).toBeLessThan(-70)
    expect(peakHeading).toBeGreaterThan(-140)
  })

  it('still drives well dead downwind, just less than on a reach', () => {
    const run = bestDrive(-180)
    expect(run).toBeGreaterThan(0)
    expect(run).toBeGreaterThan(bestDrive(-45))
    expect(run).toBeLessThan(bestDrive(-90))
  })

  it('wants the sail eased further the further it bears away', () => {
    const bestSheet = (heading: number): number => {
      let best = -Infinity
      let sheet = 0
      for (let candidate = 0; candidate <= 90; candidate += 1) {
        const drive = sailLoad(SAIL, boat(heading), { trueWind: TRUE_WIND, sheetAngle: degrees(candidate) }).drive
        if (drive > best) {
          best = drive
          sheet = candidate
        }
      }
      return sheet
    }

    // The trim rule every sailor learns, falling out of the model rather than
    // being written into it.
    let previous = -1
    for (const heading of [-30, -45, -60, -75, -90, -120]) {
      const sheet = bestSheet(heading)
      expect(sheet, `heading ${heading}`).toBeGreaterThan(previous)
      previous = sheet
    }
  })

  it('has a definite best sheet angle rather than more always being better', () => {
    let best = -Infinity
    let bestSheet = 0
    for (let sheet = 0; sheet <= 90; sheet += 1) {
      const drive = sailLoad(SAIL, boat(-45, 2), { trueWind: TRUE_WIND, sheetAngle: degrees(sheet) }).drive
      if (drive > best) {
        best = drive
        bestSheet = sheet
      }
    }
    // Close-hauled wants the sail in, but not right in on the centreline.
    expect(bestSheet).toBeGreaterThan(5)
    expect(bestSheet).toBeLessThan(40)
  })

  it('luffs when the sheet is eased past the apparent wind', () => {
    const drawing = sailLoad(SAIL, boat(-45, 2), { trueWind: TRUE_WIND, sheetAngle: degrees(20) })
    const flogging = sailLoad(SAIL, boat(-45, 2), { trueWind: TRUE_WIND, sheetAngle: degrees(40) })
    expect(flogging.fill).toBeLessThan(drawing.fill)
    expect(flogging.drive).toBeLessThan(drawing.drive)
  })

  it('mirrors exactly on the other tack', () => {
    const port = sailLoad(SAIL, boat(-45), { trueWind: TRUE_WIND, sheetAngle: degrees(20) })
    const starboard = sailLoad(SAIL, boat(45), { trueWind: TRUE_WIND, sheetAngle: degrees(-20) })

    expect(starboard.drive).toBeCloseTo(port.drive, 9)
    expect(starboard.sideForce).toBeCloseTo(-port.sideForce, 9)
    expect(starboard.torque[2]).toBeCloseTo(-port.torque[2], 9)
    expect(starboard.apparentAngle).toBeCloseTo(-port.apparentAngle, 9)
  })
})

describe('force scaling', () => {
  it('goes as the square of the wind speed', () => {
    const light = sailLoad(SAIL, boat(-60), { trueWind: [0, 0, 4], sheetAngle: degrees(25) })
    const strong = sailLoad(SAIL, boat(-60), { trueWind: [0, 0, 8], sheetAngle: degrees(25) })
    expect(strong.drive / light.drive).toBeCloseTo(4, 6)
    expect(strong.sideForce / light.sideForce).toBeCloseTo(4, 6)
  })

  it('scales with sail area', () => {
    const bigger = makeSailConfig(
      rig.sail.areaBuilt * 2,
      CENTRE_OF_EFFORT,
      requirePoint(rig, 'point_mastfoot'),
      rig.sail.luff,
    )
    // Same surface model, twice the cloth: exactly twice the force.
    const small = sailLoad(SAIL, boat(-60), { trueWind: TRUE_WIND, sheetAngle: degrees(25) })
    const large = sailLoad({ ...bigger, surface: SAIL.surface }, boat(-60), {
      trueWind: TRUE_WIND,
      sheetAngle: degrees(25),
    })
    expect(large.drive / small.drive).toBeCloseTo(2, 9)
  })

  it('produces nothing in a dead calm', () => {
    const load = sailLoad(SAIL, boat(-45), { trueWind: [0, 0, 0], sheetAngle: degrees(20) })
    expect(load.force).toEqual([0, 0, 0])
    expect(load.torque).toEqual([0, 0, 0])
    expect(load.apparentSpeed).toBe(0)
  })

  it('levers heel through the height of the centre of effort', () => {
    const low = makeSailConfig(rig.sail.areaBuilt, [0, 0.2, CENTRE_OF_EFFORT[2]], requirePoint(rig, 'point_mastfoot'), rig.sail.luff)
    const high = sailLoad(SAIL, boat(-60), { trueWind: TRUE_WIND, sheetAngle: degrees(25) })
    const ducked = sailLoad(low, boat(-60), { trueWind: TRUE_WIND, sheetAngle: degrees(25) })
    expect(Math.abs(high.torque[2])).toBeGreaterThan(Math.abs(ducked.torque[2]))
  })

  it('puts the centre of effort where the manifest says the sail is', () => {
    const load = sailLoad(SAIL, boat(0), { trueWind: TRUE_WIND, sheetAngle: 0 })
    // A couple of metres up, on the centreline, near the middle of the boat.
    expect(load.centreOfEffort[1]).toBeCloseTo(CENTRE_OF_EFFORT[1], 9)
    expect(load.centreOfEffort[1]).toBeGreaterThan(1.5)
    expect(load.centreOfEffort[1]).toBeLessThan(rig.mast.mastLength)
    expect(Math.abs(load.centreOfEffort[0])).toBeLessThan(1e-9)
  })
})

describe('determinism', () => {
  it('gives bit-identical loads for repeated calls', () => {
    const body = boat(-37, 1.8)
    const input = { trueWind: TRUE_WIND, sheetAngle: degrees(22) }
    const first = sailLoad(SAIL, body, input)
    for (let i = 0; i < 32; i++) {
      const again = sailLoad(SAIL, body, input)
      expect(again.force).toStrictEqual(first.force)
      expect(again.torque).toStrictEqual(first.torque)
      expect(again.camber).toBe(first.camber)
    }
  })

  it('never returns a non-finite force', () => {
    for (let yaw = -180; yaw <= 180; yaw += 5) {
      for (let sheet = -90; sheet <= 90; sheet += 10) {
        for (const speed of [0, 2, 6]) {
          const load = sailLoad(SAIL, boat(yaw, speed), { trueWind: TRUE_WIND, sheetAngle: degrees(sheet) })
          for (let i = 0; i < 3; i++) {
            expect(Number.isFinite(load.force[i]), `yaw ${yaw} sheet ${sheet}`).toBe(true)
            expect(Number.isFinite(load.torque[i]), `yaw ${yaw} sheet ${sheet}`).toBe(true)
          }
        }
      }
    }
  })
})
