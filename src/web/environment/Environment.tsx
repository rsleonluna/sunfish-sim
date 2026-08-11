import { type JSX, useMemo, useRef } from 'react'
import { Sky } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { BackSide, Mesh, Vector3 } from 'three'
import type { Vec3 } from '../../sim-core/vec.ts'
import { Lighthouse, Shore, Trees } from './Shore.tsx'

export interface SunOptions {
  /** Degrees above the horizon. */
  readonly elevation: number
  /** Bearing in degrees, measured from +x toward +z. */
  readonly azimuth: number
}

/** Unit vector pointing at the sun, from elevation and bearing. */
export function sunDirection({ elevation, azimuth }: SunOptions): Vec3 {
  const phi = (elevation * Math.PI) / 180
  const theta = (azimuth * Math.PI) / 180
  const horizontal = Math.cos(phi)
  return [horizontal * Math.cos(theta), Math.sin(phi), horizontal * Math.sin(theta)]
}

export interface TawasEnvironmentProps {
  readonly sun: SunOptions
  /** Boat position, so the far water and haze stay centred on the viewer. */
  readonly follow: { current: Vec3 }
  /** Inner radius of the far water: just outside the simulated wave patch. */
  readonly patchSize: number
  readonly showLand: boolean
  readonly hazeColour: string
  readonly farWaterColour: string
}

/**
 * Tawas Bay: sky, the water that runs to the horizon, and the land around it.
 *
 * The simulated wave patch is only a hundred-odd metres across. Everything
 * beyond it is scenery, and its whole job is to make the bay read as a place
 * rather than as a tile of water with an edge.
 */
export function TawasEnvironment({
  sun,
  follow,
  patchSize,
  showLand,
  hazeColour,
  farWaterColour,
}: TawasEnvironmentProps): JSX.Element {
  const direction = useMemo(() => sunDirection(sun), [sun])
  const sunPosition = useMemo(
    () => new Vector3(direction[0], direction[1], direction[2]).multiplyScalar(1000),
    [direction],
  )

  return (
    <>
      {/*
        Distance haze. This does more for the bay reading as a real place than
        anything else here: it softens the seam where the simulated wave patch
        gives way to flat far water, and it stops the treeline being a hard
        painted wall. Lake Huron in summer rarely gives you a crisp horizon.
        The wave patch is well inside `near`, so the simulated water is never
        touched by it.
      */}
      <fog attach="fog" args={[hazeColour, 260, 2600]} />

      <Sky
        distance={45000}
        sunPosition={sunPosition}
        // A hazy summer afternoon over the lake rather than a hard alpine sky.
        turbidity={5}
        rayleigh={1.4}
        mieCoefficient={0.008}
        mieDirectionalG={0.82}
      />

      <FarWater follow={follow} innerRadius={patchSize * 0.48} colour={farWaterColour} />
      <Haze follow={follow} colour={hazeColour} />

      {showLand && (
        <>
          <Shore />
          <Trees />
          <Lighthouse />
        </>
      )}
    </>
  )
}

/**
 * Flat water from the edge of the wave patch out to the horizon.
 *
 * A ring, not a disc, so it never fights the simulated surface for depth. It
 * sits a little below the deepest wave trough, which hides the seam: the step
 * is 35 cm at sixty metres and further, well under a tenth of a degree.
 */
function FarWater({
  follow,
  innerRadius,
  colour,
}: {
  follow: { current: Vec3 }
  innerRadius: number
  colour: string
}): JSX.Element {
  const mesh = useRef<Mesh>(null)

  useFrame(() => {
    if (mesh.current === null) return
    mesh.current.position.set(follow.current[0], -0.35, follow.current[2])
  })

  return (
    <mesh ref={mesh} rotation={[-Math.PI / 2, 0, 0]} frustumCulled={false} name="far-water">
      <ringGeometry args={[innerRadius, 9000, 96, 1]} />
      {/*
        Unlit on purpose. A lit material here picks up the full sun and comes
        out far brighter than the shaded wave patch, which draws a hard tonal
        line right where the simulated water stops. Unlit plus fog lets the two
        meet without a seam.
      */}
      <meshBasicMaterial color={colour} fog />
    </mesh>
  )
}

/**
 * A dome of haze that fades the far shore into the sky.
 *
 * Lake Huron in summer rarely gives you a hard horizon; the far side of the bay
 * goes pale and blue long before it goes out of sight. Rendered on the inside
 * of a sphere, unlit, with the sky visible above it.
 */
function Haze({ follow, colour }: { follow: { current: Vec3 }; colour: string }): JSX.Element {
  const mesh = useRef<Mesh>(null)

  useFrame(() => {
    if (mesh.current === null) return
    mesh.current.position.set(follow.current[0], 0, follow.current[2])
  })

  return (
    <mesh ref={mesh} frustumCulled={false} name="haze">
      {/* Only the band just above the horizon: phiStart/phiLength cut the cap off. */}
      <sphereGeometry args={[7200, 48, 12, 0, Math.PI * 2, Math.PI * 0.455, Math.PI * 0.06]} />
      <meshBasicMaterial color={colour} side={BackSide} transparent opacity={0.4} depthWrite={false} />
    </mesh>
  )
}
