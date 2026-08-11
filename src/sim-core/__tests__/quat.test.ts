import { describe, expect, it } from 'vitest'
import {
  QUAT_IDENTITY,
  quatConjugate,
  quatFromAxisAngle,
  quatFromRollPitchYaw,
  quatLength,
  quatMultiply,
  quatNormalize,
  quatRotate,
  quatRotateInverse,
  type Quat,
} from '../quat.ts'
import type { Vec3 } from '../vec.ts'

const STARBOARD: Vec3 = [1, 0, 0]
const UP: Vec3 = [0, 1, 0]
const BOW: Vec3 = [0, 0, -1]

function expectVec3(actual: Vec3, expected: Vec3, precision = 12): void {
  for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], precision)
}

describe('quatRotate', () => {
  it('leaves vectors alone under the identity', () => {
    for (const v of [STARBOARD, UP, BOW, [1.5, -2.25, 0.75]] as Vec3[]) {
      expectVec3(quatRotate(QUAT_IDENTITY, v), v)
    }
  })

  it('yaws the bow to starboard for a positive turn about up', () => {
    // Right-handed about +Y: bow (-Z) swings toward... -X, i.e. to port.
    const yaw = quatFromAxisAngle(UP, Math.PI / 2)
    expectVec3(quatRotate(yaw, BOW), [-1, 0, 0])
    expectVec3(quatRotate(yaw, STARBOARD), [0, 0, -1])
    expectVec3(quatRotate(yaw, UP), UP)
  })

  it('heels the masthead to starboard for a positive roll about the bow axis', () => {
    // Roll is about +Z, which points aft, so a positive angle lays the mast
    // over to starboard.
    const roll = quatFromAxisAngle([0, 0, 1], Math.PI / 2)
    expectVec3(quatRotate(roll, UP), [-1, 0, 0])
  })

  it('preserves length', () => {
    const q = quatNormalize([0.3, -0.7, 0.25, 0.9])
    for (const v of [STARBOARD, [3, -4, 12], [0.001, 0, -0.002]] as Vec3[]) {
      const rotated = quatRotate(q, v)
      expect(Math.hypot(...rotated)).toBeCloseTo(Math.hypot(...v), 12)
    }
  })

  it('preserves angles between vectors', () => {
    const q = quatNormalize([-0.2, 0.55, 0.1, 0.8])
    const a: Vec3 = [1, 2, 3]
    const b: Vec3 = [-2, 0.5, 1]
    const ra = quatRotate(q, a)
    const rb = quatRotate(q, b)
    const dot = (u: Vec3, v: Vec3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
    expect(dot(ra, rb)).toBeCloseTo(dot(a, b), 12)
  })

  it('round-trips through the inverse', () => {
    const q = quatNormalize([0.42, 0.11, -0.63, 0.5])
    const v: Vec3 = [1.25, -3.5, 0.75]
    expectVec3(quatRotateInverse(q, quatRotate(q, v)), v)
    expectVec3(quatRotate(q, quatRotateInverse(q, v)), v)
  })

  it('is deterministic', () => {
    const q = quatNormalize([0.1, 0.2, 0.3, 0.4])
    const first = quatRotate(q, [1.5, -2.25, 0.75])
    for (let i = 0; i < 16; i++) {
      expect(quatRotate(q, [1.5, -2.25, 0.75])).toStrictEqual(first)
    }
  })
})

describe('quatMultiply', () => {
  it('composes rotations in apply-right-first order', () => {
    const a = quatFromAxisAngle(UP, 0.4)
    const b = quatFromAxisAngle(STARBOARD, -0.7)
    const v: Vec3 = [0.3, 1.1, -2.2]
    expectVec3(quatRotate(quatMultiply(a, b), v), quatRotate(a, quatRotate(b, v)))
  })

  it('has the identity as its unit', () => {
    const q: Quat = quatNormalize([0.2, -0.4, 0.5, 0.75])
    expect(quatMultiply(q, QUAT_IDENTITY)).toStrictEqual(q)
    const other = quatMultiply(QUAT_IDENTITY, q)
    for (let i = 0; i < 4; i++) expect(other[i]).toBeCloseTo(q[i], 15)
  })

  it('cancels against its conjugate', () => {
    const q = quatNormalize([0.5, 0.5, -0.2, 0.67])
    const product = quatMultiply(q, quatConjugate(q))
    expectVec3([product[0], product[1], product[2]], [0, 0, 0])
    expect(product[3]).toBeCloseTo(1, 12)
  })

  it('keeps unit quaternions unit', () => {
    const a = quatFromAxisAngle([1, 2, 3], 0.9)
    const b = quatFromAxisAngle([-2, 0.5, 1], -1.4)
    expect(quatLength(quatMultiply(a, b))).toBeCloseTo(1, 12)
  })
})

describe('quatFromAxisAngle', () => {
  it('produces a unit quaternion regardless of axis length', () => {
    for (const axis of [[1, 0, 0], [0, 3, 0], [1, 1, 1], [-4, 2, 7]] as Vec3[]) {
      expect(quatLength(quatFromAxisAngle(axis, 1.1))).toBeCloseTo(1, 12)
    }
  })

  it('does not move vectors along its own axis', () => {
    const axis: Vec3 = [0.6, 0.8, 0]
    expectVec3(quatRotate(quatFromAxisAngle(axis, 1.3), axis), axis)
  })

  it('is the identity at zero angle', () => {
    const q = quatFromAxisAngle([1, 2, 3], 0)
    expectVec3([q[0], q[1], q[2]], [0, 0, 0])
    expect(q[3]).toBeCloseTo(1, 15)
  })

  it('composes additively about a fixed axis', () => {
    const axis: Vec3 = [0, 1, 0]
    const v: Vec3 = [1, 0.5, -2]
    const combined = quatRotate(quatFromAxisAngle(axis, 0.3 + 0.45), v)
    const chained = quatRotate(quatFromAxisAngle(axis, 0.3), quatRotate(quatFromAxisAngle(axis, 0.45), v))
    expectVec3(combined, chained)
  })

  it('rejects a zero axis', () => {
    expect(() => quatFromAxisAngle([0, 0, 0], 1)).toThrow(/non-zero/)
  })
})

describe('quatNormalize', () => {
  it('scales to unit length', () => {
    expect(quatLength(quatNormalize([2, -4, 8, 16]))).toBeCloseTo(1, 12)
  })

  it('leaves a unit quaternion where it is', () => {
    const q = quatFromAxisAngle([1, 1, 0], 0.8)
    const again = quatNormalize(q)
    for (let i = 0; i < 4; i++) expect(again[i]).toBeCloseTo(q[i], 15)
  })

  it('rejects the zero quaternion', () => {
    expect(() => quatNormalize([0, 0, 0, 0])).toThrow(/zero quaternion/)
  })
})

describe('quatFromRollPitchYaw', () => {
  it('is the identity for no rotation', () => {
    const q = quatFromRollPitchYaw(0, 0, 0)
    expect(quatLength(q)).toBeCloseTo(1, 15)
    expectVec3(quatRotate(q, BOW), BOW)
  })

  it('matches applying yaw, then pitch, then roll', () => {
    const roll = 0.2
    const pitch = -0.35
    const yaw = 1.1
    const v: Vec3 = [0.4, -1.2, 2.5]
    const expected = quatRotate(
      quatFromAxisAngle([0, 1, 0], yaw),
      quatRotate(quatFromAxisAngle([1, 0, 0], pitch), quatRotate(quatFromAxisAngle([0, 0, 1], roll), v)),
    )
    expectVec3(quatRotate(quatFromRollPitchYaw(roll, pitch, yaw), v), expected)
  })

  it('stays unit across a sweep', () => {
    for (let angle = -3; angle < 3; angle += 0.37) {
      expect(quatLength(quatFromRollPitchYaw(angle, angle / 2, -angle))).toBeCloseTo(1, 12)
    }
  })
})
