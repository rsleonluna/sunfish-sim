import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  GLTF_TO_BOAT_YAW,
  RIG_SCHEMA,
  blenderToBoat,
  blenderToGltf,
  gltfToBoat,
  parseRig,
  requirePoint,
  type RigSpec,
  type Vec3,
} from '../rig.ts'

const MANIFEST_URL = new URL('../../../public/models/sunfish-rig.json', import.meta.url)

function loadManifest(): unknown {
  return JSON.parse(readFileSync(fileURLToPath(MANIFEST_URL), 'utf8'))
}

function expectVec3(actual: Vec3, expected: Vec3, precision = 9): void {
  expect(actual).toHaveLength(3)
  for (let i = 0; i < 3; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], precision)
  }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

describe('frame conversions', () => {
  const BLENDER_BOW: Vec3 = [1, 0, 0]
  const BLENDER_PORT: Vec3 = [0, 1, 0]
  const BLENDER_UP: Vec3 = [0, 0, 1]

  it('maps the authoring axes onto the glTF axes', () => {
    // glTF frame: +X bow, +Y up, +Z starboard.
    expectVec3(blenderToGltf(BLENDER_BOW), [1, 0, 0])
    expectVec3(blenderToGltf(BLENDER_PORT), [0, 0, -1])
    expectVec3(blenderToGltf(BLENDER_UP), [0, 1, 0])
  })

  it('maps the authoring axes onto the boat frame contract', () => {
    // Boat frame: +Y up, bow -Z, starboard +X.
    expectVec3(blenderToBoat(BLENDER_BOW), [0, 0, -1])
    expectVec3(blenderToBoat(BLENDER_PORT), [-1, 0, 0])
    expectVec3(blenderToBoat(BLENDER_UP), [0, 1, 0])
  })

  it('composes: blenderToBoat equals gltfToBoat after blenderToGltf', () => {
    const samples: Vec3[] = [
      [0, 0, 0],
      [1.771144, 0, 0.649494],
      [-2.280152, 0.405219, -0.111957],
      [-7.5, 3.25, 12.125],
    ]
    for (const v of samples) {
      expectVec3(blenderToBoat(v), gltfToBoat(blenderToGltf(v)), 12)
    }
  })

  it('preserves length and right-handedness', () => {
    const a: Vec3 = [0.3, -1.2, 4.4]
    const b: Vec3 = [-2.1, 0.7, 0.05]
    const lengthOf = (v: Vec3): number => Math.hypot(v[0], v[1], v[2])

    expect(lengthOf(blenderToBoat(a))).toBeCloseTo(lengthOf(a), 12)
    // A right-handed map commutes with the cross product.
    expectVec3(blenderToBoat(cross(a, b)), cross(blenderToBoat(a), blenderToBoat(b)), 12)
  })

  it('yaws the glTF bow onto the boat-frame bow', () => {
    // Rotation about +Y by GLTF_TO_BOAT_YAW, applied to glTF-frame +X (bow).
    const c = Math.cos(GLTF_TO_BOAT_YAW)
    const s = Math.sin(GLTF_TO_BOAT_YAW)
    expectVec3([c, 0, -s], [0, 0, -1], 12)
    // ...and glTF-frame +Z (starboard) onto boat-frame +X.
    expectVec3([s, 0, c], [1, 0, 0], 12)
  })
})

describe('parseRig validation', () => {
  it('rejects a non-object', () => {
    expect(() => parseRig(null)).toThrow(/expected an object/)
    expect(() => parseRig([1, 2, 3])).toThrow(/expected an object/)
  })

  it('rejects an unknown schema', () => {
    expect(() => parseRig({ schema: 'sunfish-rig/99' })).toThrow(/unsupported schema/)
  })

  it('rejects non-metre units', () => {
    const raw = loadManifest() as Record<string, unknown>
    const units = raw.units as Record<string, unknown>
    expect(() => parseRig({ ...raw, units: { ...units, length: 'foot' } })).toThrow(/must be metres/)
  })

  it('names the offending path when a field is missing', () => {
    const raw = loadManifest() as Record<string, unknown>
    const hullWithoutLoa = { ...(raw.hull as Record<string, unknown>) }
    delete hullWithoutLoa.loa
    expect(() => parseRig({ ...raw, hull: hullWithoutLoa })).toThrow(/\$\.hull\.loa/)
  })

  it('rejects a manifest with no probes', () => {
    const raw = loadManifest() as Record<string, unknown>
    expect(() => parseRig({ ...raw, buoyancy_probes: {} })).toThrow(/no buoyancy probes/)
  })

  it('is pure: parsing the same input twice gives deep-equal results', () => {
    expect(parseRig(loadManifest())).toEqual(parseRig(loadManifest()))
  })
})

describe('sunfish-rig.json', () => {
  const rig: RigSpec = parseRig(loadManifest())

  it('carries the expected schema and glb reference', () => {
    expect(rig.schema).toBe(RIG_SCHEMA)
    expect(rig.glb).toBe('sunfish.glb')
  })

  it('reports Sunfish hull dimensions', () => {
    expect(rig.hull.loa).toBeCloseTo(4.19, 3)
    expect(rig.hull.beam).toBeCloseTo(1.24, 3)
    expect(rig.hull.draftCanoeBody).toBeGreaterThan(0)
  })

  it('converts degrees to radians', () => {
    expect(rig.mast.mastRakeRad).toBeCloseTo((3 * Math.PI) / 180, 12)
    expect(rig.mast.apexAngleRad).toBeCloseTo((65.0432 * Math.PI) / 180, 12)
  })

  it('exposes every named point in boat frame', () => {
    expect(Object.keys(rig.points).sort()).toEqual([
      'pivot_board',
      'pivot_gooseneck',
      'pivot_rudder',
      'point_clew',
      'point_halyard',
      'point_mastfoot',
    ])
    // Manifest [1.771144, 0, 0.649494] (bow-forward, up) -> boat frame.
    expectVec3(rig.sail.tack, [0, 0.649494, -1.771144], 6)
    // Bow is -Z, so aft is +Z: the clew trails the tack.
    expect(rig.sail.clew[2]).toBeGreaterThan(rig.sail.tack[2])
    // The masthead is the highest point on the rig.
    expect(requirePoint(rig, 'point_halyard')[1]).toBeGreaterThan(rig.sail.tack[1])
  })

  it('puts the whole rig on the centreline', () => {
    for (const [name, p] of Object.entries(rig.points)) {
      expect(Math.abs(p[0]), `${name} is off centreline`).toBeLessThan(1e-9)
    }
  })

  it('reads twelve probes in a stable order', () => {
    expect(rig.probes).toHaveLength(12)
    expect(rig.probes.map((p) => p.name)).toEqual([
      'probe_00',
      'probe_01',
      'probe_02',
      'probe_03',
      'probe_04',
      'probe_05',
      'probe_06',
      'probe_07',
      'probe_08',
      'probe_09',
      'probe_10',
      'probe_11',
    ])
  })

  it('places probes symmetrically about the centreline', () => {
    // The manifest lays probes out in port/centre/starboard triples per station.
    for (let i = 0; i < rig.probes.length; i += 3) {
      const port = rig.probes[i].position
      const centre = rig.probes[i + 1].position
      const starboard = rig.probes[i + 2].position

      expect(Math.abs(centre[0])).toBeLessThan(1e-9)
      // Mirrored across x = 0.
      expect(port[0]).toBeCloseTo(-starboard[0], 9)
      expect(Math.abs(port[0])).toBeGreaterThan(0.05)
      // Same station along the hull, same height to within the hull's own asymmetry.
      expect(port[2]).toBeCloseTo(starboard[2], 9)
      expect(port[2]).toBeCloseTo(centre[2], 9)
      // Heights mirror only to within the subdivision surface's own asymmetry.
      expect(Math.abs(port[1] - starboard[1])).toBeLessThan(1e-3)
      // The centreline probe is the deepest of its triple: that is the keel line.
      expect(centre[1]).toBeLessThanOrEqual(Math.min(port[1], starboard[1]))
    }
  })

  it('keeps probes on the hull bottom, within the canoe-body draft', () => {
    const deepest = Math.min(...rig.probes.map((p) => p.position[1]))
    // Deepest probe sits on the keel line, at the quoted canoe-body draft.
    expect(deepest).toBeCloseTo(-rig.hull.draftCanoeBody, 2)
    for (const probe of rig.probes) {
      expect(probe.position[1], `${probe.name} below the hull`).toBeGreaterThanOrEqual(
        -rig.hull.draftCanoeBody - 1e-6,
      )
      // Inside the hull's plan envelope.
      expect(Math.abs(probe.position[0]), `${probe.name} outside the beam`).toBeLessThanOrEqual(
        rig.hull.beam / 2,
      )
      expect(Math.abs(probe.position[2]), `${probe.name} outside the LOA`).toBeLessThanOrEqual(
        rig.hull.loa,
      )
    }
  })

  it('spreads probes fore and aft so trim is observable', () => {
    const zs = rig.probes.map((p) => p.position[2])
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(rig.hull.loa * 0.5)
  })

  it('reads both foils with sane planforms', () => {
    for (const foil of [rig.foils.daggerboard, rig.foils.rudder]) {
      expect(foil.span).toBeGreaterThan(0)
      expect(foil.planformArea).toBeGreaterThan(0)
      expect(foil.aspectRatio).toBeCloseTo(foil.span ** 2 / foil.planformArea, 2)
      expect(foil.tipChord).toBeLessThanOrEqual(foil.rootChord)
    }
    // The rudder hangs off the transom, aft of the daggerboard.
    expect(rig.foils.rudder.pivot[2]).toBeGreaterThan(rig.foils.daggerboard.pivot[2])
  })

  it('matches foil pivots against the shared points table', () => {
    expectVec3(rig.foils.daggerboard.pivot, requirePoint(rig, 'pivot_board'), 12)
    expectVec3(rig.foils.rudder.pivot, requirePoint(rig, 'pivot_rudder'), 12)
  })

  it('reads the sail shape key the aero model will drive', () => {
    expect(rig.sail.shapeKey.name).toBe('Camber')
    expect(rig.sail.shapeKey.min).toBeLessThan(rig.sail.shapeKey.max)
    expect(rig.sail.shapeKey.draftMaxAt).toBeGreaterThan(0)
    expect(rig.sail.shapeKey.draftMaxAt).toBeLessThan(1)
    expect(rig.sail.areaBuilt).toBeCloseTo(7.44, 1)
  })

  it('closes the sail triangle against its quoted edge lengths', () => {
    const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
    expect(dist(rig.sail.head, rig.sail.tack)).toBeCloseTo(rig.sail.luff, 2)
    expect(dist(rig.sail.tack, rig.sail.clew)).toBeCloseTo(rig.sail.foot, 2)
    expect(dist(rig.sail.head, rig.sail.clew)).toBeCloseTo(rig.sail.leech, 2)
  })

  it('throws for an unknown point name', () => {
    expect(() => requirePoint(rig, 'pivot_nope')).toThrow(/no point named/)
  })
})
