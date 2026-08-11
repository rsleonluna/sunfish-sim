import { type JSX, useEffect, useMemo } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three'
import { buildShore, lighthousePosition, scatterTrees } from './terrain.ts'

/** The land: beach, dune, treeline and the backdrop ridge behind it. */
export function Shore(): JSX.Element {
  const geometry = useMemo(() => {
    const { positions, colours, indices } = buildShore()
    const shore = new BufferGeometry()
    shore.setAttribute('position', new BufferAttribute(positions, 3))
    shore.setAttribute('color', new BufferAttribute(colours, 3))
    shore.setIndex(new BufferAttribute(indices, 1))
    shore.computeVertexNormals()
    return shore
  }, [])

  useEffect(() => () => geometry.dispose(), [geometry])

  return (
    <mesh geometry={geometry} name="shore" frustumCulled={false}>
      {/* Lambert, not standard: the land is matte and there is a lot of it. */}
      <meshLambertMaterial vertexColors side={DoubleSide} />
    </mesh>
  )
}

/**
 * The treeline, as two instanced meshes.
 *
 * Pines dominate the back of the point; a few paler birches sit in the dune
 * grass nearer the water. Instancing keeps fourteen hundred trees to two draw
 * calls, which matters because they are on screen the whole time.
 */
export function Trees(): JSX.Element {
  const { pines, birches } = useMemo(() => {
    const all = scatterTrees()
    return {
      pines: all.filter((tree) => tree.deciduous === 0),
      birches: all.filter((tree) => tree.deciduous === 1),
    }
  }, [])

  return (
    <>
      <TreeBatch trees={pines} colour="#2f4a30" taper={0.32} />
      <TreeBatch trees={birches} colour="#5d7043" taper={0.62} />
    </>
  )
}

function TreeBatch({
  trees,
  colour,
  taper,
}: {
  trees: ReturnType<typeof scatterTrees>
  colour: string
  taper: number
}): JSX.Element {
  const mesh = useMemo(() => {
    const geometry = new BufferGeometry()
    const cone = coneGeometry(taper)
    geometry.setAttribute('position', new BufferAttribute(cone.positions, 3))
    geometry.setIndex(new BufferAttribute(cone.indices, 1))
    geometry.computeVertexNormals()

    const material = new MeshLambertMaterial({ color: new Color(colour) })
    const instanced = new InstancedMesh(geometry, material, Math.max(trees.length, 1))
    instanced.frustumCulled = false

    const matrix = new Matrix4()
    const position = new Vector3()
    const rotation = new Quaternion()
    const scale = new Vector3()

    trees.forEach((tree, index) => {
      position.set(tree.position[0], tree.position[1], tree.position[2])
      rotation.setFromAxisAngle(UP, tree.rotation)
      scale.set(tree.radius, tree.height, tree.radius)
      instanced.setMatrixAt(index, matrix.compose(position, rotation, scale))
    })
    instanced.instanceMatrix.needsUpdate = true
    return instanced
  }, [trees, colour, taper])

  useEffect(
    () => () => {
      mesh.geometry.dispose()
      ;(mesh.material as MeshLambertMaterial).dispose()
      mesh.dispose()
    },
    [mesh],
  )

  return <primitive object={mesh} />
}

const UP = new Vector3(0, 1, 0)

/** A unit cone, standing on the origin, tapering from `taper` at the base. */
function coneGeometry(taper: number): { positions: Float32Array; indices: Uint32Array } {
  const sides = 6
  const positions = new Float32Array((sides * 2 + 1) * 3)
  const indices: number[] = []

  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2
    // Base ring.
    positions[i * 3 + 0] = Math.cos(angle)
    positions[i * 3 + 1] = 0
    positions[i * 3 + 2] = Math.sin(angle)
    // A waist, so the silhouette is not a plain triangle.
    const waist = sides + i
    positions[waist * 3 + 0] = Math.cos(angle) * taper
    positions[waist * 3 + 1] = 0.45
    positions[waist * 3 + 2] = Math.sin(angle) * taper
  }
  const apex = sides * 2
  positions[apex * 3 + 1] = 1

  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides
    indices.push(i, sides + i, sides + next, i, sides + next, next)
    indices.push(sides + i, apex, sides + next)
  }

  return { positions, indices: new Uint32Array(indices) }
}

/**
 * Tawas Point Light: a white conical tower with a black lantern and gallery,
 * with the keeper's dwelling attached at its foot.
 */
export function Lighthouse(): JSX.Element {
  const { position } = useMemo(() => lighthousePosition(), [])

  return (
    <group position={[position[0], position[1], position[2]]} name="lighthouse">
      {/* Tower: 20 m, tapering, cream brick. */}
      <mesh position={[0, 10, 0]}>
        <cylinderGeometry args={[1.5, 2.6, 20, 16]} />
        <meshLambertMaterial color="#efeade" />
      </mesh>
      {/* Gallery deck. */}
      <mesh position={[0, 20.2, 0]}>
        <cylinderGeometry args={[2.4, 2.4, 0.5, 16]} />
        <meshLambertMaterial color="#2b2b2e" />
      </mesh>
      {/* Lantern room, black ironwork with the glass inside. */}
      <mesh position={[0, 21.9, 0]}>
        <cylinderGeometry args={[1.5, 1.6, 3, 12]} />
        <meshLambertMaterial color="#25262a" />
      </mesh>
      <mesh position={[0, 21.9, 0]}>
        <cylinderGeometry args={[1.15, 1.15, 2.1, 12]} />
        <meshBasicMaterial color="#ffe9b0" />
      </mesh>
      {/* Cap and finial. */}
      <mesh position={[0, 24, 0]}>
        <coneGeometry args={[1.8, 1.6, 12]} />
        <meshLambertMaterial color="#25262a" />
      </mesh>

      {/* Keeper's dwelling: two storeys, gable roof, attached to the tower. */}
      <mesh position={[6.5, 3.4, 0]}>
        <boxGeometry args={[11, 6.8, 8]} />
        <meshLambertMaterial color="#e8e2d4" />
      </mesh>
      <mesh position={[6.5, 8.6, 0]} rotation={[0, Math.PI / 4, 0]}>
        <coneGeometry args={[8, 3.4, 4]} />
        <meshLambertMaterial color="#7a4a3a" />
      </mesh>
    </group>
  )
}
