import { Vector4 } from 'three'
import type { WaveField } from '../../sim-core/gerstner.ts'
import { MAX_WAVES } from './gerstner.glsl.ts'

export interface WaveUniforms {
  uWaveA: { value: Vector4[] }
  uWaveB: { value: Vector4[] }
  uWaveCount: { value: number }
}

/**
 * Packs a compiled wave field into the two-vec4-per-wave layout the GLSL chunk
 * expects. Field order here and component order there must not drift apart.
 */
export function waveUniforms(field: WaveField): WaveUniforms {
  if (field.waves.length > MAX_WAVES) {
    throw new Error(
      `water: ${field.waves.length} waves exceeds the shader's MAX_WAVES of ${MAX_WAVES}`,
    )
  }

  const a: Vector4[] = []
  const b: Vector4[] = []

  for (let i = 0; i < MAX_WAVES; i++) {
    const wave = field.waves[i]
    if (wave === undefined) {
      a.push(new Vector4(1, 0, 0, 1))
      b.push(new Vector4(0, 0, 0, 0))
      continue
    }
    a.push(new Vector4(wave.dirX, wave.dirZ, wave.amplitude, wave.wavenumber))
    b.push(new Vector4(wave.angularFrequency, wave.horizontalAmplitude, wave.steepness, wave.phase))
  }

  return {
    uWaveA: { value: a },
    uWaveB: { value: b },
    uWaveCount: { value: field.waves.length },
  }
}

/** Rewrites an existing uniform block in place, so the material is not rebuilt. */
export function updateWaveUniforms(uniforms: WaveUniforms, field: WaveField): void {
  const next = waveUniforms(field)
  for (let i = 0; i < MAX_WAVES; i++) {
    uniforms.uWaveA.value[i].copy(next.uWaveA.value[i])
    uniforms.uWaveB.value[i].copy(next.uWaveB.value[i])
  }
  uniforms.uWaveCount.value = next.uWaveCount.value
}
