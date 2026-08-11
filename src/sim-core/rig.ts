/**
 * Rig manifest parsing and frame normalisation.
 *
 * Pure TypeScript. No three, no DOM, no fetch. Callers hand in already-parsed
 * JSON; this module validates it and converts every point into the boat frame
 * defined by the project coordinate contract:
 *
 *   +Y up, bow along -Z, starboard +X, right-handed, metres.
 *
 * The manifest itself is written in the authoring (Blender) frame:
 *
 *   +X forward (bow), +Y to port, +Z up, right-handed, metres.
 *
 * The GLB beside it was exported with `export_yup=True`, so a glTF consumer
 * sees the asset in a third frame:
 *
 *   +X forward (bow), +Y up, +Z starboard.
 *
 * All three are the same asset. Everything downstream of this module speaks
 * boat frame only.
 */

import type { Vec3 } from './vec.ts'

export type { Vec3 }

/**
 * Yaw, in radians, that must be applied about +Y to the glTF scene so the
 * rendered model sits in the boat frame (bow from +X round to -Z).
 */
export const GLTF_TO_BOAT_YAW: number = Math.PI / 2

/** Manifest schema string this parser understands. */
export const RIG_SCHEMA: string = 'sunfish-rig/1'

/** Blender frame (x fwd, y port, z up) -> glTF frame (x fwd, y up, z stbd). */
export function blenderToGltf(v: Vec3): Vec3 {
  return [v[0], v[2], -v[1]]
}

/** glTF frame (x fwd, y up, z stbd) -> boat frame (x stbd, y up, z aft). */
export function gltfToBoat(v: Vec3): Vec3 {
  return [v[2], v[1], -v[0]]
}

/** Blender frame -> boat frame. Composition of the two conversions above. */
export function blenderToBoat(v: Vec3): Vec3 {
  return [-v[1], v[2], -v[0]]
}

export interface HullSpec {
  /** Length overall, m. */
  readonly loa: number
  /** Maximum beam, m. */
  readonly beam: number
  /** Canoe-body draft below the design waterline, m. */
  readonly draftCanoeBody: number
}

export interface MastSpec {
  readonly mastLength: number
  readonly mastRakeRad: number
  readonly yardLength: number
  readonly boomLength: number
  readonly apexAngleRad: number
  readonly gooseneckHeight: number
  /** Distance from the yard tack end to the halyard attachment, m. */
  readonly halyardAlongYard: number
  /** Distance from the boom tack end to the gooseneck, m. */
  readonly gooseneckAlongBoom: number
}

export interface SailShapeKey {
  readonly name: string
  readonly min: number
  readonly max: number
  /** Shape-key influence the mesh was exported at. */
  readonly exportedAt: number
  /** Chordwise fraction where maximum draft sits. */
  readonly draftMaxAt: number
  /** Head-to-tack falloff applied to camber. */
  readonly twistFactor: number
}

export interface SailSpec {
  readonly luff: number
  readonly foot: number
  readonly leech: number
  /** Sail area as built from the exported mesh, m^2. */
  readonly areaBuilt: number
  readonly head: Vec3
  readonly tack: Vec3
  readonly clew: Vec3
  readonly shapeKey: SailShapeKey
}

export interface FoilSpec {
  readonly rootChord: number
  readonly tipChord: number
  readonly span: number
  readonly thicknessRatio: number
  readonly planformArea: number
  readonly aspectRatio: number
  /** Pivot in boat frame, m. */
  readonly pivot: Vec3
}

export interface Probe {
  readonly name: string
  /** Position in boat frame, m. */
  readonly position: Vec3
}

export interface RigSpec {
  readonly schema: string
  readonly glb: string
  readonly hull: HullSpec
  readonly mast: MastSpec
  readonly sail: SailSpec
  readonly foils: {
    readonly daggerboard: FoilSpec
    readonly rudder: FoilSpec
  }
  /** Named attachment points in boat frame, m. Keyed by manifest name. */
  readonly points: Readonly<Record<string, Vec3>>
  /** Buoyancy probes in boat frame, m, in manifest name order. */
  readonly probes: readonly Probe[]
}

const DEG_TO_RAD = Math.PI / 180

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`rig: expected an object at ${path}`)
  }
  return value as Record<string, unknown>
}

function child(parent: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  return record(parent[key], `${path}.${key}`)
}

function num(parent: Record<string, unknown>, key: string, path: string): number {
  const value = parent[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`rig: expected a finite number at ${path}.${key}, got ${JSON.stringify(value)}`)
  }
  return value
}

function str(parent: Record<string, unknown>, key: string, path: string): string {
  const value = parent[key]
  if (typeof value !== 'string') {
    throw new Error(`rig: expected a string at ${path}.${key}, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Reads a `[x, y, z]` array written in the authoring frame, returns boat frame. */
function point(parent: Record<string, unknown>, key: string, path: string): Vec3 {
  const value = parent[key]
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`rig: expected a 3-element array at ${path}.${key}`)
  }
  for (const component of value) {
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw new Error(`rig: non-finite component at ${path}.${key}`)
    }
  }
  return blenderToBoat(value as unknown as Vec3)
}

function parseFoil(parent: Record<string, unknown>, key: string, path: string): FoilSpec {
  const foil = child(parent, key, path)
  const here = `${path}.${key}`
  return {
    rootChord: num(foil, 'root_chord', here),
    tipChord: num(foil, 'tip_chord', here),
    span: num(foil, 'span', here),
    thicknessRatio: num(foil, 'thickness_ratio', here),
    planformArea: num(foil, 'planform_area', here),
    aspectRatio: num(foil, 'aspect_ratio', here),
    pivot: point(foil, 'pivot', here),
  }
}

/**
 * Validates a parsed `sunfish-rig.json` and converts it to boat frame.
 *
 * Throws with the offending JSON path if the manifest is malformed or carries
 * an unrecognised schema. Pure: same input always yields an equal result.
 */
export function parseRig(json: unknown): RigSpec {
  const root = record(json, '$')

  const schema = str(root, 'schema', '$')
  if (schema !== RIG_SCHEMA) {
    throw new Error(`rig: unsupported schema ${JSON.stringify(schema)}, expected ${JSON.stringify(RIG_SCHEMA)}`)
  }

  const units = child(root, 'units', '$')
  if (str(units, 'length', '$.units') !== 'metre') {
    throw new Error('rig: manifest lengths must be metres')
  }
  if (str(units, 'angle', '$.units') !== 'degree') {
    throw new Error('rig: manifest angles must be degrees')
  }

  const hullRaw = child(root, 'hull', '$')
  const rigRaw = child(root, 'rig', '$')
  const derivedRaw = child(rigRaw, 'derived', '$.rig')
  const sailRaw = child(root, 'sail', '$')
  const shapeKeyRaw = child(sailRaw, 'shape_key', '$.sail')
  const foilsRaw = child(root, 'foils', '$')
  const pointsRaw = child(root, 'points', '$')
  const probesRaw = child(root, 'buoyancy_probes', '$')

  const points: Record<string, Vec3> = {}
  for (const key of Object.keys(pointsRaw).sort()) {
    points[key] = point(pointsRaw, key, '$.points')
  }

  const probes: Probe[] = Object.keys(probesRaw)
    .sort()
    .map((name) => ({ name, position: point(probesRaw, name, '$.buoyancy_probes') }))

  if (probes.length === 0) {
    throw new Error('rig: manifest declares no buoyancy probes')
  }

  return {
    schema,
    glb: str(root, 'glb', '$'),
    hull: {
      loa: num(hullRaw, 'loa', '$.hull'),
      beam: num(hullRaw, 'beam', '$.hull'),
      draftCanoeBody: num(hullRaw, 'draft_canoe_body', '$.hull'),
    },
    mast: {
      mastLength: num(rigRaw, 'mast_length', '$.rig'),
      mastRakeRad: num(rigRaw, 'mast_rake_deg', '$.rig') * DEG_TO_RAD,
      yardLength: num(rigRaw, 'yard_length', '$.rig'),
      boomLength: num(rigRaw, 'boom_length', '$.rig'),
      apexAngleRad: num(rigRaw, 'apex_angle_deg', '$.rig') * DEG_TO_RAD,
      gooseneckHeight: num(rigRaw, 'gooseneck_height', '$.rig'),
      halyardAlongYard: num(derivedRaw, 'halyard_along_yard', '$.rig.derived'),
      gooseneckAlongBoom: num(derivedRaw, 'gooseneck_along_boom', '$.rig.derived'),
    },
    sail: {
      luff: num(sailRaw, 'luff', '$.sail'),
      foot: num(sailRaw, 'foot', '$.sail'),
      leech: num(sailRaw, 'leech', '$.sail'),
      areaBuilt: num(sailRaw, 'area_built', '$.sail'),
      head: point(sailRaw, 'head', '$.sail'),
      tack: point(sailRaw, 'tack', '$.sail'),
      clew: point(sailRaw, 'clew', '$.sail'),
      shapeKey: {
        name: str(shapeKeyRaw, 'name', '$.sail.shape_key'),
        min: num(shapeKeyRaw, 'min', '$.sail.shape_key'),
        max: num(shapeKeyRaw, 'max', '$.sail.shape_key'),
        exportedAt: num(shapeKeyRaw, 'exported_at', '$.sail.shape_key'),
        draftMaxAt: num(shapeKeyRaw, 'draft_max_at', '$.sail.shape_key'),
        twistFactor: num(shapeKeyRaw, 'twist_factor', '$.sail.shape_key'),
      },
    },
    foils: {
      daggerboard: parseFoil(foilsRaw, 'daggerboard', '$.foils'),
      rudder: parseFoil(foilsRaw, 'rudder', '$.foils'),
    },
    points,
    probes,
  }
}

/** Looks up a named attachment point, throwing rather than returning undefined. */
export function requirePoint(rig: RigSpec, name: string): Vec3 {
  const value = rig.points[name]
  if (value === undefined) {
    throw new Error(`rig: no point named ${JSON.stringify(name)}`)
  }
  return value
}
