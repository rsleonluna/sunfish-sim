/**
 * Asset integrity: the GLB and the rig manifest are generated from one source,
 * so they must agree once both are converted into the boat frame.
 *
 * This is the headless half of Stage 1's acceptance criterion. It reads the GLB
 * container directly rather than through three, so it runs in the same plain
 * node process as the sim-core tests.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gltfToBoat, parseRig, type RigSpec, type Vec3 } from '../../sim-core/rig.ts'

const MODELS = new URL('../../../public/models/', import.meta.url)

interface GltfNode {
  name?: string
  mesh?: number
  translation?: [number, number, number]
  rotation?: [number, number, number, number]
  scale?: [number, number, number]
  children?: number[]
}

interface GltfJson {
  asset: { version: string }
  scenes: Array<{ nodes: number[] }>
  nodes: GltfNode[]
  meshes: Array<{
    name?: string
    primitives: Array<{ attributes: Record<string, number>; targets?: unknown[] }>
    extras?: { targetNames?: string[] }
  }>
  accessors: Array<{ min?: number[]; max?: number[] }>
}

/** Reads the JSON chunk out of a binary glTF container. */
function readGlb(url: URL): GltfJson {
  const buf = readFileSync(fileURLToPath(url))
  expect(buf.subarray(0, 4).toString('ascii'), 'glTF magic').toBe('glTF')
  expect(buf.readUInt32LE(4), 'glTF container version').toBe(2)
  const chunkLength = buf.readUInt32LE(12)
  expect(buf.readUInt32LE(16), 'first chunk must be JSON').toBe(0x4e4f534a)
  return JSON.parse(buf.subarray(20, 20 + chunkLength).toString('utf8')) as GltfJson
}

const rig: RigSpec = parseRig(JSON.parse(readFileSync(fileURLToPath(new URL('sunfish-rig.json', MODELS)), 'utf8')))
const glb: GltfJson = readGlb(new URL(rig.glb, MODELS))

/** Node translations are glTF-frame; the exporter wrote no rotation or scale. */
function nodePositionInBoatFrame(name: string): Vec3 {
  const node = glb.nodes.find((candidate) => candidate.name === name)
  expect(node, `GLB has no node named ${name}`).toBeDefined()
  expect(node!.rotation, `${name} carries a rotation`).toBeUndefined()
  expect(node!.scale, `${name} carries a scale`).toBeUndefined()
  const t = node!.translation ?? [0, 0, 0]
  return gltfToBoat([t[0], t[1], t[2]])
}

function asVec3(values: number[] | undefined, label: string): Vec3 {
  expect(values, label).toHaveLength(3)
  return [values![0], values![1], values![2]]
}

function hullBoundsInBoatFrame(): { min: Vec3; max: Vec3 } {
  const hull = glb.meshes.find((mesh) => mesh.name === 'hull')
  expect(hull, 'GLB has no hull mesh').toBeDefined()
  const accessor = glb.accessors[hull!.primitives[0].attributes.POSITION]
  const lo = gltfToBoat(asVec3(accessor.min, 'hull POSITION accessor min'))
  const hi = gltfToBoat(asVec3(accessor.max, 'hull POSITION accessor max'))
  // gltfToBoat negates one axis, so recover a sorted AABB.
  return {
    min: [Math.min(lo[0], hi[0]), Math.min(lo[1], hi[1]), Math.min(lo[2], hi[2])],
    max: [Math.max(lo[0], hi[0]), Math.max(lo[1], hi[1]), Math.max(lo[2], hi[2])],
  }
}

/** Positions in the GLB are float32; the manifest is float64. */
const F32_TOLERANCE = 1e-5

describe('sunfish.glb', () => {
  it('places every node at the scene root, so translation is world position', () => {
    const scene = glb.scenes[0]
    expect(scene.nodes).toHaveLength(glb.nodes.length)
    for (const node of glb.nodes) {
      expect(node.children, `${node.name} has children`).toBeUndefined()
    }
  })

  it('agrees with the manifest on every named point', () => {
    for (const [name, expected] of Object.entries(rig.points)) {
      const actual = nodePositionInBoatFrame(name)
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(actual[i] - expected[i]), `${name} axis ${i}`).toBeLessThan(F32_TOLERANCE)
      }
    }
  })

  it('agrees with the manifest on every buoyancy probe', () => {
    for (const { name, position } of rig.probes) {
      const actual = nodePositionInBoatFrame(name)
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(actual[i] - position[i]), `${name} axis ${i}`).toBeLessThan(F32_TOLERANCE)
      }
    }
  })

  it('has a hull whose extents match the manifest', () => {
    const { min, max } = hullBoundsInBoatFrame()
    expect(max[0] - min[0], 'beam').toBeCloseTo(rig.hull.beam, 3)
    expect(max[2] - min[2], 'LOA').toBeCloseTo(rig.hull.loa, 3)
    expect(-min[1], 'canoe-body draft').toBeCloseTo(rig.hull.draftCanoeBody, 3)
  })

  it('seats every probe on the hull, deepest one on the keel line', () => {
    const { min, max } = hullBoundsInBoatFrame()
    const skin = 1e-3

    for (const { name, position } of rig.probes) {
      expect(position[0], `${name} outboard to port`).toBeGreaterThanOrEqual(min[0] - skin)
      expect(position[0], `${name} outboard to starboard`).toBeLessThanOrEqual(max[0] + skin)
      expect(position[2], `${name} ahead of the stem`).toBeGreaterThanOrEqual(min[2] - skin)
      expect(position[2], `${name} abaft the transom`).toBeLessThanOrEqual(max[2] + skin)
      expect(position[1], `${name} below the hull`).toBeGreaterThanOrEqual(min[1] - skin)
      // Probes sample the wetted bottom: none may sit up at the sheer.
      expect(position[1], `${name} above the waterline`).toBeLessThan(max[1])
    }

    const deepest = Math.min(...rig.probes.map((probe) => probe.position[1]))
    expect(deepest - min[1], 'deepest probe is off the hull bottom').toBeLessThan(skin)
  })

  it('mirrors probes about the centreline', () => {
    const mirrored = rig.probes.map((probe) => probe.position)
    for (const p of mirrored) {
      const twin = mirrored.find(
        (q) => Math.abs(q[0] + p[0]) < 1e-9 && Math.abs(q[2] - p[2]) < 1e-9,
      )
      expect(twin, `probe at ${JSON.stringify(p)} has no mirror`).toBeDefined()
    }
  })

  it('carries the sail morph target the manifest names', () => {
    const sail = glb.meshes.find((mesh) => mesh.name === 'sail')
    expect(sail, 'GLB has no sail mesh').toBeDefined()
    expect(sail!.primitives[0].targets).toHaveLength(1)
    expect(sail!.extras?.targetNames).toEqual([rig.sail.shapeKey.name])
  })

  it('ships the meshes later stages animate', () => {
    const names = glb.meshes.map((mesh) => mesh.name)
    expect(names).toEqual(
      expect.arrayContaining(['hull', 'daggerboard', 'rudder', 'mast', 'yard', 'boom', 'sail']),
    )
  })
})
