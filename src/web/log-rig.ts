import { Object3D, Vector3 } from 'three'
import type { RigSpec, Vec3 } from '../sim-core/rig.ts'

interface RigRow {
  name: string
  kind: 'pivot' | 'point' | 'probe'
  /** World position, metres, boat frame. */
  x: number
  y: number
  z: number
  /** Distance from the manifest value to the GLB node's world position, metres. */
  deltaFromGlb: number | 'no node'
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6

function kindOf(name: string): RigRow['kind'] {
  if (name.startsWith('probe_')) return 'probe'
  if (name.startsWith('pivot_')) return 'pivot'
  return 'point'
}

/**
 * Logs every rig point and buoyancy probe with its position, and checks each
 * against the matching node inside the GLB.
 *
 * `designOrigin` must be the object whose local frame is the manifest's frame —
 * the design origin, not the centre of mass the rigid body is posed about.
 * Positions are converted back into that frame before comparing, so the check
 * keeps working wherever the boat has sailed to.
 *
 * The manifest and the GLB are generated from the same source, so a non-zero
 * delta means the two have drifted apart or the frame conversion is wrong.
 * Returns the largest delta seen, in metres.
 */
export function logRig(designOrigin: Object3D, glbScene: Object3D, rig: RigSpec): number {
  designOrigin.updateWorldMatrix(true, true)

  const world = new Vector3()
  const rows: RigRow[] = []
  let worstDelta = 0

  const push = (name: string, manifest: Vec3): void => {
    const node = glbScene.getObjectByName(name)
    let delta: number | 'no node' = 'no node'
    if (node !== undefined) {
      node.getWorldPosition(world)
      designOrigin.worldToLocal(world)
      delta = round(world.distanceTo(new Vector3(manifest[0], manifest[1], manifest[2])))
      worstDelta = Math.max(worstDelta, delta)
    }
    rows.push({
      name,
      kind: kindOf(name),
      x: round(manifest[0]),
      y: round(manifest[1]),
      z: round(manifest[2]),
      deltaFromGlb: delta,
    })
  }

  for (const [name, position] of Object.entries(rig.points)) push(name, position)
  for (const probe of rig.probes) push(probe.name, probe.position)

  console.group(
    `%c[rig] ${rig.glb} — boat frame: +Y up, bow -Z, starboard +X`,
    'font-weight:bold',
  )
  console.table(rows)
  console.info(
    `hull: LOA ${rig.hull.loa} m, beam ${rig.hull.beam} m, canoe-body draft ${rig.hull.draftCanoeBody} m`,
  )
  console.info(
    `sail: ${rig.sail.areaBuilt.toFixed(3)} m^2 built, shape key "${rig.sail.shapeKey.name}" exported at ${rig.sail.shapeKey.exportedAt}`,
  )
  const deepest = rig.probes.reduce((a, b) => (b.position[1] < a.position[1] ? b : a))
  console.info(
    `probes: ${rig.probes.length}, deepest ${deepest.name} at y = ${deepest.position[1].toFixed(6)} m`,
  )
  if (worstDelta > 1e-4) {
    console.error(`[rig] manifest and GLB disagree by up to ${worstDelta} m`)
  } else {
    console.info(`[rig] manifest matches GLB to ${worstDelta} m`)
  }
  console.groupEnd()

  return worstDelta
}
