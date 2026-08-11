/**
 * CPU/GPU parity check for the Gerstner wave field.
 *
 * Runs `sampleDisplacement` and `sampleNormal` from sim-core against the GLSL
 * chunk the water mesh ships with, over the same set of sample points, and
 * reports the largest disagreement.
 *
 * This needs a real WebGL2 context with float render targets, which the
 * node-environment vitest process does not have, so it is not a `.test.ts` and
 * does not run in `npm test`. Run it with `npm run parity`, which serves the
 * app, drives a headless browser to `/parity.html` and fails the process on a
 * delta over tolerance. `/parity.html` also works in a normal browser.
 *
 * Method: draw one GL_POINT per sample into a 1-pixel-tall float target, with
 * the *vertex* shader computing the value and the fragment shader writing it
 * straight out. That exercises the same shader stage the water mesh uses.
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  GLSL3,
  OrthographicCamera,
  Points,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  WebGLRenderTarget,
  WebGLRenderer,
  FloatType,
  NearestFilter,
} from 'three'
import {
  compileWaveField,
  sampleDisplacement,
  sampleNormal,
  tawasPreset,
  type WaveField,
} from '../../sim-core/gerstner.ts'
import { GERSTNER_GLSL } from '../water/gerstner.glsl.ts'
import { waveUniforms } from '../water/wave-uniforms.ts'

export interface ParityOptions {
  /** Number of (x, z, t) samples. */
  sampleCount?: number
  /** PRNG seed, so a failure is reproducible. */
  seed?: number
  /** Half-width of the sampled patch, m. */
  extent?: number
  /** Sampled time span, s. */
  duration?: number
  /** Still-water depth for the field under test, m. */
  depth?: number
  /** Maximum tolerated absolute difference. */
  tolerance?: number
}

export interface ParityFailure {
  index: number
  x: number
  z: number
  t: number
  quantity: 'displacement' | 'normal'
  axis: number
  cpu: number
  gpu: number
  delta: number
}

export interface ParityReport {
  passed: boolean
  tolerance: number
  sampleCount: number
  seed: number
  maxDisplacementDelta: number
  maxNormalDelta: number
  /** Largest error from the harness itself, with no wave maths involved. */
  passthroughDelta: number
  /** Per-axis maxima for displacement, then for the normal. */
  displacementByAxis: [number, number, number]
  normalByAxis: [number, number, number]
  worst: ParityFailure | null
  failures: ParityFailure[]
  renderer: string
  durationMs: number
}

/** Small deterministic PRNG. sim-core stays random-free; this is test scaffolding. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PARITY_VERTEX_SHADER = /* glsl */ `
in vec3 aSample;
in float aIndex;

uniform float uCount;
uniform int uQuantity;

// Flat, so nothing goes through the rasterizer's interpolator. With one point
// per pixel that turns out to be exact either way — the pass-through pass below
// measures a noise floor of 0 — but this keeps the harness from depending on
// that happening to be true on some other driver.
flat out vec3 vValue;

${GERSTNER_GLSL}

void main() {
  vec2 p = aSample.xy;
  float t = aSample.z;

  // uQuantity 2 is a pass-through: it measures what the attribute upload,
  // rasteriser, float target and readback cost on their own, so the wave
  // numbers below can be read as shader error rather than pipeline noise.
  if (uQuantity == 0) vValue = gerstnerDisplacement(p, t);
  else if (uQuantity == 1) vValue = gerstnerNormal(p, t);
  else vValue = aSample;

  // One sample per pixel of a uCount x 1 target, landing on the pixel centre.
  float ndcX = (aIndex + 0.5) / uCount * 2.0 - 1.0;
  gl_Position = vec4(ndcX, 0.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`

const PARITY_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

flat in vec3 vValue;
layout(location = 0) out vec4 fragColor;

void main() {
  fragColor = vec4(vValue, 1.0);
}
`

/**
 * Runs the comparison. Creates and disposes its own renderer, so it can be
 * called from a bare page with no scene set up.
 */
export function runParity(options: ParityOptions = {}): ParityReport {
  const sampleCount = options.sampleCount ?? 500
  const seed = options.seed ?? 0x5f15c0de
  const extent = options.extent ?? 30
  const duration = options.duration ?? 20
  const depth = options.depth ?? 4
  const tolerance = options.tolerance ?? 1e-4

  const started = performance.now()
  const field: WaveField = compileWaveField(tawasPreset({ heading: 0.7 }), { depth })

  // Sample values are float32 on the GPU, so round them here too and compare
  // like with like. Anything else would measure the input conversion, not the
  // shader.
  const random = mulberry32(seed)
  const samples = new Float32Array(sampleCount * 3)
  const indices = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    samples[i * 3 + 0] = Math.fround((random() * 2 - 1) * extent)
    samples[i * 3 + 1] = Math.fround((random() * 2 - 1) * extent)
    samples[i * 3 + 2] = Math.fround(random() * duration)
    indices[i] = i
  }

  const canvas = document.createElement('canvas')
  canvas.width = sampleCount
  canvas.height = 1

  const renderer = new WebGLRenderer({ canvas, antialias: false })
  const context = renderer.getContext()
  if (context.getExtension('EXT_color_buffer_float') === null) {
    renderer.dispose()
    throw new Error('parity: EXT_color_buffer_float is unavailable, cannot read float targets')
  }

  const debugInfo = context.getExtension('WEBGL_debug_renderer_info')
  const rendererName =
    debugInfo === null
      ? context.getParameter(context.VERSION)
      : context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(sampleCount * 3), 3))
  geometry.setAttribute('aSample', new Float32BufferAttribute(samples, 3))
  geometry.setAttribute('aIndex', new Float32BufferAttribute(indices, 1))

  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: PARITY_VERTEX_SHADER,
    fragmentShader: PARITY_FRAGMENT_SHADER,
    uniforms: {
      uCount: { value: sampleCount },
      uQuantity: { value: 0 },
      ...waveUniforms(field),
    },
  })

  const points = new Points(geometry, material)
  points.frustumCulled = false

  const scene = new Scene()
  scene.add(points)
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)

  const target = new WebGLRenderTarget(sampleCount, 1, {
    format: RGBAFormat,
    type: FloatType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
  })

  const readback = new Float32Array(sampleCount * 4)
  const gpuDisplacement = new Float32Array(sampleCount * 4)
  const gpuNormal = new Float32Array(sampleCount * 4)
  const gpuPassthrough = new Float32Array(sampleCount * 4)

  for (const [quantity, destination] of [
    [0, gpuDisplacement],
    [1, gpuNormal],
    [2, gpuPassthrough],
  ] as const) {
    material.uniforms.uQuantity.value = quantity
    renderer.setRenderTarget(target)
    renderer.clear()
    renderer.render(scene, camera)
    renderer.readRenderTargetPixels(target, 0, 0, sampleCount, 1, readback)
    destination.set(readback)
  }

  renderer.setRenderTarget(null)

  // Noise floor: what the pipeline costs before any wave maths happens.
  let passthroughDelta = 0
  for (let i = 0; i < sampleCount; i++) {
    for (let axis = 0; axis < 3; axis++) {
      passthroughDelta = Math.max(
        passthroughDelta,
        Math.abs(samples[i * 3 + axis] - gpuPassthrough[i * 4 + axis]),
      )
    }
  }

  const failures: ParityFailure[] = []
  const displacementByAxis: [number, number, number] = [0, 0, 0]
  const normalByAxis: [number, number, number] = [0, 0, 0]
  let worst: ParityFailure | null = null
  let maxDisplacementDelta = 0
  let maxNormalDelta = 0

  for (let i = 0; i < sampleCount; i++) {
    const x = samples[i * 3 + 0]
    const z = samples[i * 3 + 1]
    const t = samples[i * 3 + 2]

    const cpuDisplacement = sampleDisplacement(field, x, z, t)
    const cpuNormal = sampleNormal(field, x, z, t)

    for (const [quantity, cpu, gpu, byAxis] of [
      ['displacement', cpuDisplacement, gpuDisplacement, displacementByAxis],
      ['normal', cpuNormal, gpuNormal, normalByAxis],
    ] as const) {
      for (let axis = 0; axis < 3; axis++) {
        const gpuValue = gpu[i * 4 + axis]
        const delta = Math.abs(cpu[axis] - gpuValue)
        byAxis[axis] = Math.max(byAxis[axis], delta)

        if (quantity === 'displacement') maxDisplacementDelta = Math.max(maxDisplacementDelta, delta)
        else maxNormalDelta = Math.max(maxNormalDelta, delta)

        const failure: ParityFailure = {
          index: i,
          x,
          z,
          t,
          quantity,
          axis,
          cpu: cpu[axis],
          gpu: gpuValue,
          delta,
        }
        if (worst === null || delta > worst.delta) worst = failure
        if (delta > tolerance && failures.length < 20) failures.push(failure)
      }
    }
  }

  target.dispose()
  geometry.dispose()
  material.dispose()
  renderer.dispose()

  return {
    passed: failures.length === 0 && maxDisplacementDelta <= tolerance && maxNormalDelta <= tolerance,
    tolerance,
    sampleCount,
    seed,
    maxDisplacementDelta,
    maxNormalDelta,
    passthroughDelta,
    displacementByAxis,
    normalByAxis,
    worst,
    failures,
    renderer: String(rendererName),
    durationMs: performance.now() - started,
  }
}
