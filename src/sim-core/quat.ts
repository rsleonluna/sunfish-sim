/**
 * Minimal quaternion helpers. Pure, allocation-per-call, no classes.
 *
 * Layout is (x, y, z, w) with w last, matching glTF and three. A unit
 * quaternion here rotates a vector from boat frame into world frame.
 *
 * Stage 5 extends this with integration; only what hydrostatics needs to place
 * probes in the world lives here so far.
 */

import type { Vec3, Vec4 } from './vec.ts'

export type Quat = Vec4

export const QUAT_IDENTITY: Quat = [0, 0, 0, 1]

/** Rotates a vector by a unit quaternion: v + 2w(q x v) + 2(q x (q x v)). */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q
  const [vx, vy, vz] = v

  const tx = 2 * (qy * vz - qz * vy)
  const ty = 2 * (qz * vx - qx * vz)
  const tz = 2 * (qx * vy - qy * vx)

  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ]
}

/** Rotates a vector by the inverse of a unit quaternion: world back to body. */
export function quatRotateInverse(q: Quat, v: Vec3): Vec3 {
  return quatRotate(quatConjugate(q), v)
}

export function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]]
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

export function quatLength(q: Quat): number {
  return Math.hypot(q[0], q[1], q[2], q[3])
}

export function quatNormalize(q: Quat): Quat {
  const length = quatLength(q)
  if (length === 0) {
    throw new Error('quat: cannot normalise a zero quaternion')
  }
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length]
}

/** Rotation of `angle` radians about `axis`, which need not be unit length. */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const length = Math.hypot(axis[0], axis[1], axis[2])
  if (length === 0) {
    throw new Error('quat: rotation axis must be non-zero')
  }
  const half = angle / 2
  const scale = Math.sin(half) / length
  return [axis[0] * scale, axis[1] * scale, axis[2] * scale, Math.cos(half)]
}

export function quatDot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
}

/**
 * Shortest-arc interpolation between two unit quaternions.
 *
 * Negates one input when they point into opposite hemispheres, so the result
 * always takes the short way round rather than spinning most of a turn the
 * wrong way. Falls back to a normalised lerp when the two are nearly parallel,
 * where the sine denominator loses precision — which is the common case when
 * this is used to interpolate one 1/120 s frame for rendering.
 */
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let cosine = quatDot(a, b)
  let end: Quat = b

  if (cosine < 0) {
    end = [-b[0], -b[1], -b[2], -b[3]]
    cosine = -cosine
  }

  if (cosine > 0.9995) {
    return quatNormalize([
      a[0] + (end[0] - a[0]) * t,
      a[1] + (end[1] - a[1]) * t,
      a[2] + (end[2] - a[2]) * t,
      a[3] + (end[3] - a[3]) * t,
    ])
  }

  const angle = Math.acos(cosine)
  const sine = Math.sin(angle)
  const scaleA = Math.sin((1 - t) * angle) / sine
  const scaleB = Math.sin(t * angle) / sine

  return [
    a[0] * scaleA + end[0] * scaleB,
    a[1] * scaleA + end[1] * scaleB,
    a[2] * scaleA + end[2] * scaleB,
    a[3] * scaleA + end[3] * scaleB,
  ]
}

/**
 * Roll about the bow axis, then pitch about the starboard axis, then yaw about
 * up. Convenient for posing the boat in tests and debug UI.
 */
export function quatFromRollPitchYaw(roll: number, pitch: number, yaw: number): Quat {
  const qYaw = quatFromAxisAngle([0, 1, 0], yaw)
  const qPitch = quatFromAxisAngle([1, 0, 0], pitch)
  const qRoll = quatFromAxisAngle([0, 0, 1], roll)
  return quatMultiply(qYaw, quatMultiply(qPitch, qRoll))
}
