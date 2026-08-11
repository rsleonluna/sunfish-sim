import { type JSX, useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color, DoubleSide, Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector3 } from 'three'
import type { WaveField } from '../sim-core/gerstner.ts'
import { WATER_FRAGMENT_SHADER, WATER_VERTEX_SHADER } from './water/water-shader.ts'
import { updateWaveUniforms, waveUniforms } from './water/wave-uniforms.ts'

export interface WaterProps {
  field: WaveField
  /** Patch edge length, m. */
  size: number
  /** Quads per edge. Aim for several across the shortest wavelength. */
  segments: number
  opacity: number
  wireframe: boolean
  /** When false the surface holds at `frozenTime`, which keeps captures repeatable. */
  animate: boolean
  frozenTime: number
  /** Live simulation time, s. Overrides the internal clock when given. */
  time?: { current: number }
  /** World point the patch should stay centred on, usually the boat. */
  follow?: { current: readonly [number, number, number] }
  /** Colour in the troughs, where you are looking down into the water. */
  troughColour?: string
  /** Colour on the crests, where sunlight is coming through the shallows. */
  crestColour?: string
  /** Sky colour the surface reflects at grazing angles. */
  skyColour?: string
  /** Unit vector toward the sun. */
  sunDirection?: readonly [number, number, number]
}

/**
 * The Gerstner water surface.
 *
 * The plane is baked into XZ at build time rather than rotated by the mesh, so
 * `position.xz` in the vertex shader is the wave parameter point with no change
 * of basis in between. That is what lets the GLSL stay a literal port.
 */
export function Water({
  field,
  size,
  segments,
  opacity,
  wireframe,
  animate,
  frozenTime,
  time,
  follow,
  troughColour = '#12556a',
  crestColour = '#48a2ac',
  skyColour = '#c2dcea',
  sunDirection,
}: WaterProps): JSX.Element {
  const geometry = useMemo(() => {
    const plane = new PlaneGeometry(size, size, segments, segments)
    plane.rotateX(-Math.PI / 2)
    return plane
  }, [size, segments])

  useEffect(() => () => geometry.dispose(), [geometry])

  // Created once and mutated in place. The material holds these same objects,
  // so rewriting a value reaches the GPU without recompiling the program.
  const waves = useRef(waveUniforms(field))
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: WATER_VERTEX_SHADER,
        fragmentShader: WATER_FRAGMENT_SHADER,
        transparent: true,
        side: DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uOrigin: { value: new Vector2() },
          uTroughColor: { value: new Color(troughColour) },
          uCrestColor: { value: new Color(crestColour) },
          uSkyColor: { value: new Color(skyColour) },
          uSunDirection: { value: new Vector3(6, 10, 4).normalize() },
          uOpacity: { value: 1 },
          uAmplitudeScale: { value: 0.25 },
          ...waves.current,
        },
      }),
    [],
  )

  useEffect(() => () => material.dispose(), [material])

  useEffect(() => {
    updateWaveUniforms(waves.current, field)
    const amplitude = field.waves.reduce((sum, wave) => sum + wave.amplitude, 0)
    material.uniforms.uAmplitudeScale.value = Math.max(amplitude, 1e-4)
  }, [material, field])

  useEffect(() => {
    ;(material.uniforms.uTroughColor.value as Color).set(troughColour)
    ;(material.uniforms.uCrestColor.value as Color).set(crestColour)
    ;(material.uniforms.uSkyColor.value as Color).set(skyColour)
  }, [material, troughColour, crestColour, skyColour])

  useEffect(() => {
    if (sunDirection === undefined) return
    ;(material.uniforms.uSunDirection.value as Vector3)
      .set(sunDirection[0], sunDirection[1], sunDirection[2])
      .normalize()
  }, [material, sunDirection])

  useEffect(() => {
    material.uniforms.uOpacity.value = opacity
    material.wireframe = wireframe
    material.depthWrite = opacity >= 1
  }, [material, opacity, wireframe])

  const elapsed = useRef(frozenTime)

  useEffect(() => {
    if (!animate) {
      elapsed.current = frozenTime
      material.uniforms.uTime.value = frozenTime
    }
  }, [material, animate, frozenTime])

  const mesh = useRef<Mesh>(null)

  useFrame((_, delta) => {
    if (time !== undefined) {
      material.uniforms.uTime.value = time.current
    } else if (animate) {
      elapsed.current += delta
      material.uniforms.uTime.value = elapsed.current
    }

    if (follow !== undefined && mesh.current !== null) {
      // Snap the patch to whole quads. Sliding it continuously would make the
      // vertices swim through the wave field and shimmer.
      const quad = size / segments
      const x = Math.round(follow.current[0] / quad) * quad
      const z = Math.round(follow.current[2] / quad) * quad
      mesh.current.position.set(x, 0, z)
      material.uniforms.uOrigin.value.set(x, z)
    }
  })

  return (
    <mesh ref={mesh} name="water" geometry={geometry} material={material} frustumCulled={false} />
  )
}
