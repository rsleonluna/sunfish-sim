/**
 * Tawas Bay shoreline, generated rather than modelled.
 *
 * Pure functions with a seeded PRNG, so the coast is identical on every reload
 * and a screenshot can be compared against an earlier one.
 *
 * ## The geography, and one deliberate lie
 * Tawas Bay sits on the west shore of Lake Huron. The mainland wraps it to the
 * west and north; Tawas Point is a low sandy spit that hooks up from the south
 * and shelters the bay, with the lighthouse near its tip; the open lake lies to
 * the east and northeast.
 *
 * The real bay is about three kilometres across. At that scale a twenty metre
 * lighthouse subtends less than a degree and reads as a speck. Everything here
 * is compressed to roughly a sixth of that, which keeps the landmarks legible
 * from a boat sailing near the origin. The shape is right; the scale is not.
 */

import type { Vec2 } from '../../sim-core/vec.ts'

/** Distance from the bay's centre to the waterline, by bearing. */
interface ShoreControl {
  /** Bearing in degrees, measured from +x toward +z, matching wave headings. */
  readonly bearing: number
  /** Distance to the waterline, m. */
  readonly distance: number
}

/**
 * The bay outline. Small distances are close shore, large ones are open lake
 * receding to the horizon.
 */
const SHORE: readonly ShoreControl[] = [
  { bearing: -180, distance: 430 },
  { bearing: -150, distance: 470 },
  { bearing: -120, distance: 540 },
  { bearing: -90, distance: 700 },
  { bearing: -60, distance: 1500 },
  { bearing: -30, distance: 2600 },
  { bearing: 0, distance: 2900 },
  { bearing: 30, distance: 900 },
  { bearing: 45, distance: 420 },
  { bearing: 60, distance: 300 },
  { bearing: 90, distance: 270 },
  { bearing: 120, distance: 320 },
  { bearing: 150, distance: 380 },
  { bearing: 180, distance: 430 },
]

/**
 * How much land there is at a bearing, 0 to 1.
 *
 * The bay is only enclosed on three sides. To the east and north-east it opens
 * into Lake Huron, and looking that way from a boat there is nothing on the
 * horizon at all. Pushing the shoreline further away is not enough — land at
 * three kilometres still draws a treeline right across the view. The land has
 * to actually sink below the horizon, which is what this scales.
 */
export function landiness(bearingRadians: number): number {
  let degrees = ((bearingRadians * 180) / Math.PI) % 360
  if (degrees > 180) degrees -= 360
  if (degrees < -180) degrees += 360

  // Fully open from -35 to +12; land returns over twenty-odd degrees either side.
  const openStart = -35
  const openEnd = 12
  if (degrees > openStart && degrees < openEnd) return 0

  const toOpen =
    degrees <= openStart ? openStart - degrees : degrees - openEnd
  const t = Math.min(toOpen / 26, 1)
  return t * t * (3 - 2 * t)
}

/** Where the point narrows to its tip: the lighthouse stands here. */
export const LIGHTHOUSE_BEARING = 52
export const LIGHTHOUSE_INLAND = 34

/** Deterministic PRNG. The coast must not reshuffle itself between reloads. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TWO_PI = Math.PI * 2

/** Smooth interpolation of the control table, wrapping at the seam. */
export function shoreDistance(bearingRadians: number): number {
  let degrees = ((bearingRadians * 180) / Math.PI) % 360
  if (degrees > 180) degrees -= 360
  if (degrees < -180) degrees += 360

  for (let i = 0; i < SHORE.length - 1; i++) {
    const a = SHORE[i]
    const b = SHORE[i + 1]
    if (degrees >= a.bearing && degrees <= b.bearing) {
      const t = (degrees - a.bearing) / (b.bearing - a.bearing)
      // Smoothstep between controls: a piecewise-linear coast looks faceted.
      const smooth = t * t * (3 - 2 * t)
      return a.distance + (b.distance - a.distance) * smooth
    }
  }
  return SHORE[0].distance
}

/**
 * Cross-shore profile: how far inland, and how high.
 *
 * Tawas Point is sand. It comes out of the water almost flat, rises through a
 * low dune and only then reaches trees — there is no cliff anywhere in the bay.
 */
interface Band {
  /** Distance inland from the waterline, m. */
  readonly inland: number
  /** Height above the still waterline, m. */
  readonly height: number
  /** Ground colour, linear-ish sRGB triplet. */
  readonly colour: readonly [number, number, number]
}

const PROFILE: readonly Band[] = [
  // Starts below the water so the beach meets the surface without a seam.
  { inland: -14, height: -1.1, colour: [0.42, 0.44, 0.36] },
  { inland: 0, height: 0.12, colour: [0.78, 0.72, 0.57] },
  { inland: 9, height: 0.5, colour: [0.85, 0.79, 0.63] },
  { inland: 26, height: 1.5, colour: [0.72, 0.71, 0.5] },
  { inland: 70, height: 3.2, colour: [0.42, 0.5, 0.32] },
  { inland: 190, height: 6.5, colour: [0.22, 0.31, 0.22] },
  { inland: 520, height: 13, colour: [0.26, 0.34, 0.3] },
  { inland: 1500, height: 26, colour: [0.34, 0.41, 0.42] },
]

export interface ShoreMesh {
  readonly positions: Float32Array
  readonly colours: Float32Array
  readonly indices: Uint32Array
}

/**
 * Builds the land as a ring: the waterline is the inner edge and the profile
 * runs outward from it.
 */
export function buildShore(bearingSegments: number = 320, seed: number = 0x7a5): ShoreMesh {
  const random = mulberry32(seed)

  // Per-bearing wobble so the coast is not a drawn curve. Generated once and
  // reused across the profile so the bands stay parallel to the shore.
  const wobble = new Float32Array(bearingSegments)
  for (let i = 0; i < bearingSegments; i++) {
    const theta = (i / bearingSegments) * TWO_PI
    wobble[i] =
      Math.sin(theta * 7 + 1.3) * 9 +
      Math.sin(theta * 17 + 4.1) * 4 +
      (random() - 0.5) * 6
  }

  const rings = PROFILE.length
  const vertexCount = bearingSegments * rings
  const positions = new Float32Array(vertexCount * 3)
  const colours = new Float32Array(vertexCount * 3)

  for (let ring = 0; ring < rings; ring++) {
    const band = PROFILE[ring]
    for (let i = 0; i < bearingSegments; i++) {
      const theta = (i / bearingSegments) * TWO_PI
      // Only the near shore wobbles; the far backdrop stays smooth or the
      // horizon turns into a saw edge.
      const falloff = Math.max(0, 1 - band.inland / 400)
      const distance = shoreDistance(theta) + band.inland + wobble[i] * falloff

      // Where the bay opens to the lake the land drops away under the horizon
      // instead of drawing a treeline across the open water.
      const land = landiness(theta)
      const height = band.height * land - (1 - land) * 40

      const index = ring * bearingSegments + i
      positions[index * 3 + 0] = Math.cos(theta) * distance
      positions[index * 3 + 1] = height
      positions[index * 3 + 2] = Math.sin(theta) * distance

      colours[index * 3 + 0] = band.colour[0]
      colours[index * 3 + 1] = band.colour[1]
      colours[index * 3 + 2] = band.colour[2]
    }
  }

  const indices = new Uint32Array(bearingSegments * (rings - 1) * 6)
  let cursor = 0
  for (let ring = 0; ring < rings - 1; ring++) {
    for (let i = 0; i < bearingSegments; i++) {
      const next = (i + 1) % bearingSegments
      const a = ring * bearingSegments + i
      const b = ring * bearingSegments + next
      const c = (ring + 1) * bearingSegments + i
      const d = (ring + 1) * bearingSegments + next

      // Wound so the surface faces up, seen from a boat inside the ring.
      indices[cursor++] = a
      indices[cursor++] = c
      indices[cursor++] = b
      indices[cursor++] = b
      indices[cursor++] = c
      indices[cursor++] = d
    }
  }

  return { positions, colours, indices }
}

export interface TreeInstance {
  /** World position of the trunk base. */
  readonly position: readonly [number, number, number]
  readonly height: number
  readonly radius: number
  /** Rotation about up, radians, so the instances are not clones. */
  readonly rotation: number
  /** 0 for pine green, 1 for the paler birch mixed in along the dune. */
  readonly deciduous: number
}

/** Height of the ground at a given distance inland, m. */
export function groundHeight(inland: number): number {
  if (inland <= PROFILE[0].inland) return PROFILE[0].height
  for (let i = 0; i < PROFILE.length - 1; i++) {
    const a = PROFILE[i]
    const b = PROFILE[i + 1]
    if (inland >= a.inland && inland <= b.inland) {
      const t = (inland - a.inland) / (b.inland - a.inland)
      return a.height + (b.height - a.height) * t
    }
  }
  return PROFILE[PROFILE.length - 1].height
}

/**
 * Scatters the treeline.
 *
 * Nothing grows on the beach, so the band starts well inland; density rises
 * going back from the water, which is what gives a shoreline its soft edge
 * rather than a wall of trunks.
 */
export function scatterTrees(count: number = 1400, seed: number = 0x7ee5): TreeInstance[] {
  const random = mulberry32(seed)
  const trees: TreeInstance[] = []

  for (let i = 0; i < count; i++) {
    const theta = random() * TWO_PI

    // Biased toward the water so the treeline reads as an edge, not a slab.
    const roll = random()
    const inland = 34 + roll * roll * 520

    const distance = shoreDistance(theta) + inland
    const height = groundHeight(inland)

    // Nothing grows out in the open lake.
    if (landiness(theta) < 0.85) continue
    // Thinner where the sand is still bare.
    if (inland < 55 && random() > 0.35) continue

    const deciduous = inland < 130 && random() < 0.4 ? 1 : 0
    const scale = 0.65 + random() * 0.75

    trees.push({
      position: [Math.cos(theta) * distance, height, Math.sin(theta) * distance],
      height: (deciduous === 1 ? 7 : 12) * scale,
      radius: (deciduous === 1 ? 2.6 : 2.1) * scale,
      rotation: random() * TWO_PI,
      deciduous,
    })
  }

  return trees
}

/** Where the lighthouse stands, on the tip of the point. */
export function lighthousePosition(): { position: readonly [number, number, number]; bearing: number } {
  const theta = (LIGHTHOUSE_BEARING * Math.PI) / 180
  const distance = shoreDistance(theta) + LIGHTHOUSE_INLAND
  return {
    position: [Math.cos(theta) * distance, groundHeight(LIGHTHOUSE_INLAND), Math.sin(theta) * distance],
    bearing: LIGHTHOUSE_BEARING,
  }
}

/** Horizontal bearing and range from the boat to the lighthouse, for the HUD. */
export function bearingTo(from: Vec2, to: readonly [number, number, number]): {
  bearing: number
  range: number
} {
  const dx = to[0] - from[0]
  const dz = to[2] - from[1]
  return { bearing: Math.atan2(dz, dx), range: Math.hypot(dx, dz) }
}
