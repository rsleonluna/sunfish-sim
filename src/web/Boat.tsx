import { type JSX, useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import {
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  Object3D,
  Quaternion,
  Vector3,
  type Material,
} from 'three'
import { GLTF_TO_BOAT_YAW, type RigSpec } from '../sim-core/rig.ts'
import { logRig } from './log-rig.ts'
import type { BoatFrame } from './useBoatSim.ts'

const RIG_SWING = 'rig-swing'

export interface BoatProps {
  rig: RigSpec
  url: string
  /** Live simulation output. Read inside the frame loop, never through React. */
  frame: { current: BoatFrame | null }
  /** Boat-frame offset from the design origin to the centre of mass, m. */
  centreOfMass: readonly [number, number, number]
  showProbes: boolean
  probeRadius: number
  hullOpacity: number
  hullWireframe: boolean
}

/**
 * The Sunfish, driven by the simulation.
 *
 * Two separate jobs. The outer group carries the rigid body's pose. Inside it,
 * the rig is animated: the yard, boom and sail swing together about
 * `pivot_gooseneck`, the rudder turns about `pivot_rudder`, and the sail's
 * Camber shape key is driven by the very number `aero.ts` used to compute the
 * force. If those two ever disagree, the boat is lying about what it is doing.
 *
 * The GLB is authored bow-along-+X and yawed into the boat frame, but every
 * rotation here is about +Y — and rotations about a shared axis commute — so
 * the sign conventions carry across the yaw unchanged.
 */
export function Boat({
  rig,
  url,
  frame,
  centreOfMass,
  showProbes,
  probeRadius,
  hullOpacity,
  hullWireframe,
}: BoatProps): JSX.Element {
  const { scene } = useGLTF(url)
  const root = useRef<Group>(null)
  // The rig cross-check compares against manifest coordinates, which are
  // measured from the design origin — so it has to run on the group that still
  // sits there, not the outer one carrying the centre-of-mass offset.
  const designOrigin = useRef<Group>(null)

  // The rig parts share an origin at the tack, not at the gooseneck, so they
  // are reparented under a group placed on the pivot itself.
  //
  // This MUST be idempotent. `useGLTF` hands back a cached scene shared by
  // every caller, and StrictMode invokes a memo factory twice on purpose, so a
  // setup that blindly mutates node positions runs twice on the same objects
  // and subtracts the gooseneck offset twice — dropping the whole rig 0.65 m
  // and pushing it 0.68 m forward, straight through the deck.
  const rigParts = useMemo(() => {
    const existing = scene.getObjectByName(RIG_SWING)
    const swing = existing ?? new Object3D()

    if (existing === undefined) {
      swing.name = RIG_SWING
      const gooseneck = scene.getObjectByName('pivot_gooseneck')
      if (gooseneck !== undefined) swing.position.copy(gooseneck.position)

      for (const name of ['yard', 'boom', 'sail']) {
        const part = scene.getObjectByName(name)
        if (part === undefined) continue
        part.position.sub(swing.position)
        swing.add(part)
      }
      scene.add(swing)
    }

    const sail = swing.getObjectByName('sail')
    if (sail instanceof Mesh) {
      // Sailcloth. Two-sided because the sail is a zero-thickness triangle and
      // would otherwise vanish on one tack, and transmissive because the thing
      // that makes a sail look like a sail is the sun coming through it from
      // the far side — the leeward face glows and the battens show as shadows.
      // Transmission has to stay low. Dialled up it behaves like glass and the
      // sail goes dark, showing whatever is behind it; a sail is not
      // transparent, it is translucent. A little transmission plus a lot of
      // sheen is what reads as sunlit cloth.
      const cloth = new MeshPhysicalMaterial({
        color: '#fbf6ea',
        side: DoubleSide,
        roughness: 0.75,
        metalness: 0,
        transmission: 0.18,
        thickness: 0.004,
        ior: 1.05,
        sheen: 1,
        sheenRoughness: 0.9,
        sheenColor: new Color('#fffaf0'),
        specularIntensity: 0.12,
        emissive: new Color('#2b2a24'),
        emissiveIntensity: 0.35,
      })
      sail.material = cloth
      sail.castShadow = false
    }

    return {
      swing,
      rudder: scene.getObjectByName('rudder') ?? null,
      sail: sail instanceof Mesh ? sail : null,
    }
  }, [scene])

  useEffect(() => {
    if (designOrigin.current === null) return
    logRig(designOrigin.current, scene, rig)

    // The sail node's own origin is the tack, so after reparenting it must land
    // exactly on the manifest's tack. This is the check that would have caught
    // the rig being set up twice.
    const sail = rigParts.sail
    if (sail === null) return
    designOrigin.current.updateWorldMatrix(true, true)
    const tack = designOrigin.current.worldToLocal(sail.getWorldPosition(new Vector3()))
    const offset = Math.hypot(
      tack.x - rig.sail.tack[0],
      tack.y - rig.sail.tack[1],
      tack.z - rig.sail.tack[2],
    )
    if (offset > 1e-3) {
      console.error(
        `[rig] sail tack is ${offset.toFixed(4)} m from where the manifest puts it ` +
          `(${tack.x.toFixed(3)}, ${tack.y.toFixed(3)}, ${tack.z.toFixed(3)} vs ` +
          `${rig.sail.tack.map((v) => v.toFixed(3)).join(', ')})`,
      )
    } else {
      console.info(`[rig] sail tack matches the manifest to ${offset.toExponential(1)} m`)
    }
  }, [scene, rig, rigParts])

  useEffect(() => {
    const restore: Array<() => void> = []
    scene.traverse((object) => {
      if (!(object instanceof Mesh)) return
      for (const material of materialsOf(object.material)) {
        const { transparent, opacity, depthWrite } = material
        const wireframe = 'wireframe' in material ? (material.wireframe as boolean) : false
        restore.push(() => {
          material.transparent = transparent
          material.opacity = opacity
          material.depthWrite = depthWrite
          if ('wireframe' in material) material.wireframe = wireframe
          material.needsUpdate = true
        })

        material.transparent = hullOpacity < 1
        material.opacity = hullOpacity
        material.depthWrite = hullOpacity >= 1
        if ('wireframe' in material) material.wireframe = hullWireframe
        material.needsUpdate = true
      }
    })
    return () => {
      for (const undo of restore) undo()
    }
  }, [scene, hullOpacity, hullWireframe])

  const orientation = useMemo(() => new Quaternion(), [])
  const position = useMemo(() => new Vector3(), [])

  useFrame(() => {
    const current = frame.current
    if (current === null || root.current === null) return

    const { render, controls, camberInfluence } = current

    position.set(render.position[0], render.position[1], render.position[2])
    orientation.set(
      render.orientation[0],
      render.orientation[1],
      render.orientation[2],
      render.orientation[3],
    )
    root.current.position.copy(position)
    root.current.quaternion.copy(orientation)

    // Positive boom angle swings the clew to starboard, which is a positive
    // turn about +Y in both the glTF frame and the boat frame.
    rigParts.swing.rotation.y = controls.boomAngle
    if (rigParts.rudder !== null) rigParts.rudder.rotation.y = controls.rudderAngle

    const influences = rigParts.sail?.morphTargetInfluences
    if (influences !== undefined && influences.length > 0) {
      // The Camber key runs -1 to 1, so the sign bags the cloth to leeward.
      influences[0] = camberInfluence
    }
  })

  return (
    <group ref={root} name="boat">
      <group ref={designOrigin} position={[-centreOfMass[0], -centreOfMass[1], -centreOfMass[2]]}>
        <group rotation={[0, GLTF_TO_BOAT_YAW, 0]}>
          <primitive object={scene} />
        </group>
        {showProbes && <ProbeMarkers rig={rig} radius={probeRadius} />}
      </group>
    </group>
  )
}

function materialsOf(material: Material | Material[]): Material[] {
  return Array.isArray(material) ? material : [material]
}

/**
 * Debug spheres at every buoyancy probe, colour-coded by side: green to
 * starboard, red to port, white on the centreline.
 */
function ProbeMarkers({ rig, radius }: { rig: RigSpec; radius: number }): JSX.Element {
  return (
    <group name="buoyancy-probes">
      {rig.probes.map(({ name, position }) => {
        const side = position[0]
        const color = Math.abs(side) < 1e-6 ? '#ffffff' : side > 0 ? '#22dd66' : '#ff3355'
        return (
          <mesh key={name} name={name} position={[position[0], position[1], position[2]]}>
            <sphereGeometry args={[radius, 16, 12]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} />
          </mesh>
        )
      })}
    </group>
  )
}
