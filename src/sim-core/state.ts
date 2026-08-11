/**
 * 6-DOF rigid body: semi-implicit Euler on a fixed 1/120 s timestep.
 *
 * Pure TypeScript, no mutation. `step` takes a state and returns a new one, so
 * a trajectory is a fold over a sequence of wrenches and nothing can alias.
 *
 * ## Frames
 * Position, velocity, angular velocity, force and torque are all world-frame.
 * The inertia tensor is body-frame and diagonal, which is exact for a hull with
 * a centreline plane of symmetry and close enough for one without.
 *
 * Torque and the inertia tensor are both about the centre of mass, and
 * `position` IS the centre of mass — not the design origin the rig manifest is
 * measured from. `recentreProbes` in hydrostatics exists to bridge the two.
 *
 * ## Integration
 * Semi-implicit (symplectic) Euler: velocity is updated first, then position
 * moves at the new velocity. It costs one force evaluation per step, does not
 * pump energy the way explicit Euler does, and is trivial to reproduce in C++.
 *
 * Orientation advances by the exponential map of the angular velocity, which
 * is exact for constant omega over the step. Rotation is carried as world-frame angular momentum rather
 * than angular velocity: dL/dt is exactly the torque, so a free body conserves
 * momentum by construction and angular velocity is re-derived each step through
 * the rotated inertia tensor. A body spun about its intermediate axis still
 * tumbles the way a real one does, but without the energy drift that comes of
 * explicitly stepping the gyroscopic term.
 *
 * ## Accuracy, measured
 * Angular momentum is conserved to about 1e-12 relative over a hundred seconds
 * of free tumbling — that part is structural, not a tolerance.
 *
 * Kinetic energy is not conserved, and this is first-order truncation error
 * rather than a defect: a free body tumbling at 1.5 rad/s gains 0.68% per
 * second at 1/120 s, and halving the step halves the rate (1.75x, 1.26x, 1.13x,
 * 1.06x over 100 s at 1/120, 1/240, 1/480, 1/960). Because momentum is fixed,
 * gaining energy tilts the spin axis toward the smallest moment, so a body spun
 * fast about its largest axis will slowly wander off it.
 *
 * None of that reaches the boat: hydrostatic drag removes energy orders of
 * magnitude faster than the integrator adds it, and a hull does not tumble
 * freely. Anything that does — a capsize spun up hard, say — wants a smaller
 * step or a higher-order scheme.
 *
 * ## Determinism
 * Same initial state and same sequence of (wrench, dt) gives bit-identical
 * output. The accumulator makes that true frame to frame as well: what varies
 * between runs is how many fixed steps a frame consumes, never the step itself.
 */

import {
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  quatRotate,
  quatRotateInverse,
  quatSlerp,
  type Quat,
} from './quat.ts'
import type { Vec3 } from './vec.ts'

/** The project's fixed simulation timestep, s. */
export const FIXED_DT = 1 / 120

/**
 * Most fixed steps one `advance` call will run.
 *
 * Without a cap, a frame that takes longer than the steps it schedules makes
 * the next frame schedule even more — the spiral of death. Past this the
 * surplus is dropped and reported, so the sim runs slow rather than locking up.
 */
export const MAX_SUBSTEPS = 8

export interface RigidBody {
  readonly mass: number
  /** Principal moments about the centre of mass, body frame, kg m^2. */
  readonly inertia: Vec3
}

export interface RigidBodyState {
  /** Centre of mass in world space, m. */
  readonly position: Vec3
  /** Body-to-world rotation. */
  readonly orientation: Quat
  /** Linear velocity of the centre of mass, world frame, m/s. */
  readonly velocity: Vec3
  /** Angular velocity, world frame, rad/s. */
  readonly angularVelocity: Vec3
}

/** A force and a torque, both world-frame, the torque about the centre of mass. */
export interface Wrench {
  readonly force: Vec3
  readonly torque: Vec3
}

export const ZERO_WRENCH: Wrench = { force: [0, 0, 0], torque: [0, 0, 0] }

export interface SimClock {
  /** Total simulated time, s. */
  readonly time: number
  /** Frame time not yet consumed by a fixed step, s. Always in [0, FIXED_DT). */
  readonly remainder: number
}

export const INITIAL_CLOCK: SimClock = { time: 0, remainder: 0 }

/** Computes the loads acting on a state at a given simulation time. Must be pure. */
export type WrenchSource = (state: RigidBodyState, time: number) => Wrench

export interface AdvanceResult {
  readonly state: RigidBodyState
  /** State one fixed step earlier, for render interpolation. */
  readonly previous: RigidBodyState
  readonly clock: SimClock
  /** Blend factor in [0, 1) between `previous` and `state`. */
  readonly alpha: number
  readonly steps: number
  /** Simulation time discarded because MAX_SUBSTEPS was reached, s. */
  readonly dropped: number
}

export function makeBody(mass: number, inertia: Vec3): RigidBody {
  if (!(mass > 0) || !Number.isFinite(mass)) {
    throw new Error(`state: mass must be finite and positive, got ${mass}`)
  }
  for (let axis = 0; axis < 3; axis++) {
    if (!(inertia[axis] > 0) || !Number.isFinite(inertia[axis])) {
      throw new Error(`state: inertia[${axis}] must be finite and positive, got ${inertia[axis]}`)
    }
  }
  return { mass, inertia }
}

/**
 * Principal moments of a uniform box, about its centre.
 *
 * A crude stand-in for a hull, but the right order of magnitude and easy to
 * reason about. `size` is the full extents along each body axis.
 */
export function boxInertia(mass: number, size: Vec3): Vec3 {
  const [x, y, z] = size
  return [
    (mass * (y * y + z * z)) / 12,
    (mass * (x * x + z * z)) / 12,
    (mass * (x * x + y * y)) / 12,
  ]
}

/** Principal moments from radii of gyration, when those are what is known. */
export function gyrationInertia(mass: number, radii: Vec3): Vec3 {
  return [mass * radii[0] * radii[0], mass * radii[1] * radii[1], mass * radii[2] * radii[2]]
}

/** Weight acting at the centre of mass, so it contributes no torque. */
export function gravityWrench(body: RigidBody, gravity: number): Wrench {
  return { force: [0, -body.mass * gravity, 0], torque: [0, 0, 0] }
}

export function addWrench(a: Wrench, b: Wrench): Wrench {
  return {
    force: [a.force[0] + b.force[0], a.force[1] + b.force[1], a.force[2] + b.force[2]],
    torque: [a.torque[0] + b.torque[0], a.torque[1] + b.torque[1], a.torque[2] + b.torque[2]],
  }
}

export function restingState(position: Vec3, orientation: Quat): RigidBodyState {
  return { position, orientation, velocity: [0, 0, 0], angularVelocity: [0, 0, 0] }
}

/**
 * Advances one body by one timestep. Pure: the input state is untouched.
 *
 * The wrench is held constant across the step, which is what makes the result a
 * function of its arguments alone.
 */
export function step(
  state: RigidBodyState,
  body: RigidBody,
  wrench: Wrench,
  dt: number,
): RigidBodyState {
  // Linear: new velocity first, then move at it. That is what makes this
  // symplectic rather than explicit.
  const velocity: Vec3 = [
    state.velocity[0] + (wrench.force[0] / body.mass) * dt,
    state.velocity[1] + (wrench.force[1] / body.mass) * dt,
    state.velocity[2] + (wrench.force[2] / body.mass) * dt,
  ]
  const position: Vec3 = [
    state.position[0] + velocity[0] * dt,
    state.position[1] + velocity[1] * dt,
    state.position[2] + velocity[2] * dt,
  ]

  // Angular motion runs on momentum, not on angular velocity.
  //
  // In world frame dL/dt is just the torque, with no gyroscopic term, so a
  // free body's momentum is carried across the step untouched. Integrating
  // Euler's equations for omega directly instead means explicit-Euler stepping
  // a nonlinear term, which pumps energy badly for a tumbling body — measured
  // at +87% over a hundred seconds before this was changed.
  //
  // The tumbling still emerges: omega is re-derived from the fixed momentum
  // through an inertia tensor that rotates with the body.
  const [ix, iy, iz] = body.inertia
  const startBodyOmega = quatRotateInverse(state.orientation, state.angularVelocity)
  const startMomentum = quatRotate(state.orientation, [
    ix * startBodyOmega[0],
    iy * startBodyOmega[1],
    iz * startBodyOmega[2],
  ])

  const momentum: Vec3 = [
    startMomentum[0] + wrench.torque[0] * dt,
    startMomentum[1] + wrench.torque[1] * dt,
    startMomentum[2] + wrench.torque[2] * dt,
  ]

  // Rotate using the angular velocity the new momentum implies at the current
  // attitude, matching the velocity-first ordering of the linear update.
  const midBodyMomentum = quatRotateInverse(state.orientation, momentum)
  const midOmega = quatRotate(state.orientation, [
    midBodyMomentum[0] / ix,
    midBodyMomentum[1] / iy,
    midBodyMomentum[2] / iz,
  ])

  // Rotate by the exponential map rather than q += 0.5 * omega * q * dt.
  //
  // The linearised form is only first order in the angle, so it drifts once a
  // step turns through a meaningful angle: at 6 rad/s it went unstable and grew
  // spurious off-axis rates. Building the delta rotation from the axis and
  // angle directly integrates constant angular velocity exactly, for the cost
  // of one sine and cosine, and needs no renormalisation to stay unit.
  const spinRate = Math.hypot(midOmega[0], midOmega[1], midOmega[2])
  const orientation =
    spinRate === 0
      ? state.orientation
      : quatNormalize(quatMultiply(quatFromAxisAngle(midOmega, spinRate * dt), state.orientation))

  // Report the angular velocity consistent with the new attitude, so the next
  // step reconstructs the same momentum rather than a slightly different one.
  const endBodyMomentum = quatRotateInverse(orientation, momentum)
  const angularVelocity = quatRotate(orientation, [
    endBodyMomentum[0] / ix,
    endBodyMomentum[1] / iy,
    endBodyMomentum[2] / iz,
  ])

  return { position, orientation, velocity, angularVelocity }
}

/**
 * Consumes a frame's worth of elapsed time in fixed steps.
 *
 * Returns the state before the last step alongside the current one, so a
 * renderer can blend between them with `alpha` and show smooth motion without
 * the simulation ever seeing a variable timestep.
 */
export function advance(
  state: RigidBodyState,
  body: RigidBody,
  clock: SimClock,
  frameTime: number,
  wrenches: WrenchSource,
): AdvanceResult {
  if (!Number.isFinite(frameTime) || frameTime < 0) {
    throw new Error(`state: frameTime must be finite and non-negative, got ${frameTime}`)
  }

  let pending = clock.remainder + frameTime
  let time = clock.time
  let current = state
  let previous = state
  let steps = 0

  while (pending >= FIXED_DT && steps < MAX_SUBSTEPS) {
    previous = current
    current = step(current, body, wrenches(current, time), FIXED_DT)
    time += FIXED_DT
    pending -= FIXED_DT
    steps++
  }

  // Whatever is left over after the cap is time the sim will never run.
  let dropped = 0
  if (pending >= FIXED_DT) {
    dropped = pending - (pending % FIXED_DT)
    pending -= dropped
  }

  return {
    state: current,
    previous,
    clock: { time, remainder: pending },
    alpha: pending / FIXED_DT,
    steps,
    dropped,
  }
}

/**
 * Blends two states for rendering. Positions and velocities lerp, orientation
 * slerps. Never feed the result back into the simulation.
 */
export function interpolate(
  previous: RigidBodyState,
  current: RigidBodyState,
  alpha: number,
): RigidBodyState {
  const blend = (a: Vec3, b: Vec3): Vec3 => [
    a[0] + (b[0] - a[0]) * alpha,
    a[1] + (b[1] - a[1]) * alpha,
    a[2] + (b[2] - a[2]) * alpha,
  ]

  return {
    position: blend(previous.position, current.position),
    orientation: quatSlerp(previous.orientation, current.orientation, alpha),
    velocity: blend(previous.velocity, current.velocity),
    angularVelocity: blend(previous.angularVelocity, current.angularVelocity),
  }
}

/** World-frame angular momentum. Conserved when no torque acts, so a useful probe. */
export function angularMomentum(state: RigidBodyState, body: RigidBody): Vec3 {
  const bodyOmega = quatRotateInverse(state.orientation, state.angularVelocity)
  return quatRotate(state.orientation, [
    body.inertia[0] * bodyOmega[0],
    body.inertia[1] * bodyOmega[1],
    body.inertia[2] * bodyOmega[2],
  ])
}

/** Translational plus rotational kinetic energy, J. */
export function kineticEnergy(state: RigidBodyState, body: RigidBody): number {
  const [vx, vy, vz] = state.velocity
  const linear = 0.5 * body.mass * (vx * vx + vy * vy + vz * vz)

  const bodyOmega = quatRotateInverse(state.orientation, state.angularVelocity)
  const rotational =
    0.5 *
    (body.inertia[0] * bodyOmega[0] * bodyOmega[0] +
      body.inertia[1] * bodyOmega[1] * bodyOmega[1] +
      body.inertia[2] * bodyOmega[2] * bodyOmega[2])

  return linear + rotational
}
