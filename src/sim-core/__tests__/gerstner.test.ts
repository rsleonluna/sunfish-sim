import { describe, expect, it } from 'vitest'
import { GRAVITY } from '../constants.ts'
import {
  angularFrequency,
  compileWaveField,
  directionFromHeading,
  flatWaterField,
  phaseSpeed,
  sampleDisplacement,
  sampleHeight,
  sampleHeightAt,
  sampleNormal,
  sampleNormalAt,
  sampleParameterAt,
  sampleVelocity,
  sampleVelocityAt,
  tawasPreset,
  totalSteepness,
  waveNumber,
  wavePeriod,
  type WaveComponent,
  type WaveField,
} from '../gerstner.ts'
import type { Vec3 } from '../vec.ts'

const TWO_PI = Math.PI * 2

/** A single wave running along +x, for cases with a closed-form answer. */
function singleWave(overrides: Partial<WaveComponent> = {}): WaveComponent {
  return {
    dir: [1, 0],
    amplitude: 0.12,
    wavelength: 5,
    steepness: 0.25,
    phase: 0,
    ...overrides,
  }
}

/** A spread of sample points and times used by the sweeping tests. */
const SAMPLES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [1.5, -2.25, 0.37],
  [-8.125, 4.5, 1.9],
  [37.75, 19.5, 12.125],
  [-100.5, -60.25, 44.75],
  [0.001, -0.002, 100.5],
]

function surfacePoint(field: WaveField, x: number, z: number, t: number): Vec3 {
  const d = sampleDisplacement(field, x, z, t)
  return [x + d[0], d[1], z + d[2]]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2])
  return [v[0] / length, v[1] / length, v[2] / length]
}

describe('dispersion relation', () => {
  it('converts wavelength to wavenumber', () => {
    expect(waveNumber(TWO_PI)).toBeCloseTo(1, 12)
    expect(waveNumber(5)).toBeCloseTo(TWO_PI / 5, 12)
  })

  it('reduces to the deep-water limit when depth is infinite', () => {
    for (const wavelength of [3, 4.6, 8, 25]) {
      const k = waveNumber(wavelength)
      expect(angularFrequency(k, Infinity)).toBeCloseTo(Math.sqrt(GRAVITY * k), 12)
      // T = sqrt(2*pi*L/g)
      expect(wavePeriod(wavelength, Infinity)).toBeCloseTo(
        Math.sqrt((TWO_PI * wavelength) / GRAVITY),
        12,
      )
    }
  })

  it('approaches c = sqrt(g*h) in the shallow-water limit', () => {
    const depth = 0.5
    // k*h << 1, so tanh(k*h) ~= k*h and the speed stops depending on wavelength.
    expect(phaseSpeed(100, depth)).toBeCloseTo(Math.sqrt(GRAVITY * depth), 2)
    expect(phaseSpeed(200, depth)).toBeCloseTo(Math.sqrt(GRAVITY * depth), 2)
  })

  it('slows waves as the water shoals', () => {
    const deep = phaseSpeed(8, Infinity)
    expect(phaseSpeed(8, 8)).toBeLessThanOrEqual(deep)
    expect(phaseSpeed(8, 4)).toBeLessThan(phaseSpeed(8, 8))
    expect(phaseSpeed(8, 2)).toBeLessThan(phaseSpeed(8, 4))
  })

  it('gives the surface the period the dispersion relation predicts', () => {
    for (const depth of [Infinity, 6, 2]) {
      for (const wavelength of [3, 5, 8]) {
        const field = compileWaveField([singleWave({ wavelength })], { depth })
        const period = wavePeriod(wavelength, depth)

        for (const [x, z, t] of SAMPLES) {
          expect(sampleHeight(field, x, z, t + period)).toBeCloseTo(
            sampleHeight(field, x, z, t),
            10,
          )
        }
        // Half a period later the surface is on the other side of still water.
        expect(sampleHeight(field, 0, 0, period / 2)).toBeCloseTo(-sampleHeight(field, 0, 0, 0), 10)
      }
    }
  })

  it('moves crests at the phase speed, along the wave direction', () => {
    const wavelength = 6
    const depth = 4
    const field = compileWaveField([singleWave({ wavelength, dir: [0, 1] })], { depth })
    const c = phaseSpeed(wavelength, depth)

    for (const dt of [0.1, 1.25, -0.7]) {
      // Following the crest reproduces the same height.
      expect(sampleHeight(field, 0, 3 + c * dt, 2 + dt)).toBeCloseTo(sampleHeight(field, 0, 3, 2), 10)
    }
  })

  it('rejects nonsense inputs', () => {
    expect(() => waveNumber(0)).toThrow(/positive/)
    expect(() => waveNumber(-4)).toThrow(/positive/)
    expect(() => waveNumber(Number.NaN)).toThrow(/finite/)
    expect(() => angularFrequency(1, 0)).toThrow(/depth/)
    expect(() => angularFrequency(1, -3)).toThrow(/depth/)
  })
})

describe('flat water', () => {
  it('is flat when there are no components at all', () => {
    const field = flatWaterField()
    for (const [x, z, t] of SAMPLES) {
      expect(sampleDisplacement(field, x, z, t)).toEqual([0, 0, 0])
      expect(sampleHeight(field, x, z, t)).toBe(0)
      expect(sampleNormal(field, x, z, t)).toEqual([0, 1, 0])
    }
  })

  it('is flat when every amplitude is zero', () => {
    const field = compileWaveField(tawasPreset({ amplitudeScale: 0 }))
    expect(field.waves).toHaveLength(5)
    for (const [x, z, t] of SAMPLES) {
      expect(sampleDisplacement(field, x, z, t)).toEqual([0, 0, 0])
      expect(sampleHeight(field, x, z, t)).toBe(0)
      expect(sampleNormal(field, x, z, t)).toEqual([0, 1, 0])
    }
  })

  it('has zero height everywhere for a zero-amplitude component', () => {
    const field = compileWaveField([singleWave({ amplitude: 0, steepness: 0 })])
    for (const [x, z, t] of SAMPLES) {
      expect(sampleHeight(field, x, z, t)).toBe(0)
      expect(sampleDisplacement(field, x, z, t)).toEqual([0, 0, 0])
    }
  })
})

describe('surface geometry', () => {
  const field = compileWaveField(tawasPreset({ heading: 0.6 }), { depth: 4 })

  it('returns unit normals everywhere', () => {
    for (let x = -12; x <= 12; x += 3.25) {
      for (let z = -12; z <= 12; z += 3.25) {
        for (const t of [0, 0.37, 4.5, 91.125]) {
          const n = sampleNormal(field, x, z, t)
          expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 12)
        }
      }
    }
  })

  it('keeps normals pointing up out of the water', () => {
    for (let x = -12; x <= 12; x += 1.75) {
      for (let z = -12; z <= 12; z += 1.75) {
        const n = sampleNormal(field, x, z, 3.25)
        expect(n[1], `normal flipped at (${x}, ${z})`).toBeGreaterThan(0)
      }
    }
  })

  it('matches a central-difference normal of the parametric surface', () => {
    const h = 1e-4
    for (const [x, z, t] of SAMPLES) {
      const px0 = surfacePoint(field, x - h, z, t)
      const px1 = surfacePoint(field, x + h, z, t)
      const pz0 = surfacePoint(field, x, z - h, t)
      const pz1 = surfacePoint(field, x, z + h, t)

      const tx: Vec3 = [(px1[0] - px0[0]) / (2 * h), (px1[1] - px0[1]) / (2 * h), (px1[2] - px0[2]) / (2 * h)]
      const tz: Vec3 = [(pz1[0] - pz0[0]) / (2 * h), (pz1[1] - pz0[1]) / (2 * h), (pz1[2] - pz0[2]) / (2 * h)]

      const numeric = normalize(cross(tz, tx))
      const analytic = sampleNormal(field, x, z, t)
      for (let i = 0; i < 3; i++) {
        expect(analytic[i], `axis ${i} at (${x}, ${z}, ${t})`).toBeCloseTo(numeric[i], 6)
      }
    }
  })

  it('is invariant along the crest line of a single wave', () => {
    // Direction +x means the surface cannot vary with z.
    const single = compileWaveField([singleWave({ dir: [1, 0] })])
    for (const z of [-20, -3.5, 0, 7.25, 61]) {
      expect(sampleHeight(single, 2.5, z, 1.75)).toBeCloseTo(sampleHeight(single, 2.5, 0, 1.75), 12)
    }
  })

  it('bunches the surface toward crests but never folds it', () => {
    // dP.x/dx must stay positive, otherwise the surface has turned back on itself.
    const h = 1e-5
    for (let x = -8; x <= 8; x += 0.5) {
      const back = surfacePoint(field, x - h, 0, 2.5)
      const forward = surfacePoint(field, x + h, 0, 2.5)
      expect(forward[0] - back[0], `surface folded at x=${x}`).toBeGreaterThan(0)
    }
  })

  it('keeps the surface within the summed amplitude', () => {
    const bound = tawasPreset({ heading: 0.6 }).reduce((sum, w) => sum + w.amplitude, 0)
    for (let x = -20; x <= 20; x += 1.25) {
      for (let z = -20; z <= 20; z += 1.25) {
        expect(Math.abs(sampleHeight(field, x, z, 8.5))).toBeLessThanOrEqual(bound + 1e-12)
      }
    }
  })
})

describe('determinism', () => {
  const components = tawasPreset({ heading: 1.1 })

  it('gives bit-identical output for repeated calls', () => {
    const field = compileWaveField(components, { depth: 4 })
    for (const [x, z, t] of SAMPLES) {
      const first = sampleDisplacement(field, x, z, t)
      const firstNormal = sampleNormal(field, x, z, t)
      for (let i = 0; i < 64; i++) {
        expect(sampleDisplacement(field, x, z, t)).toStrictEqual(first)
        expect(sampleHeight(field, x, z, t)).toBe(first[1])
        expect(sampleNormal(field, x, z, t)).toStrictEqual(firstNormal)
      }
    }
  })

  it('gives bit-identical output across independently compiled fields', () => {
    const a = compileWaveField(tawasPreset({ heading: 1.1 }), { depth: 4 })
    const b = compileWaveField(tawasPreset({ heading: 1.1 }), { depth: 4 })
    for (const [x, z, t] of SAMPLES) {
      expect(sampleDisplacement(a, x, z, t)).toStrictEqual(sampleDisplacement(b, x, z, t))
      expect(sampleNormal(a, x, z, t)).toStrictEqual(sampleNormal(b, x, z, t))
    }
  })

  it('does not depend on the order samples are requested in', () => {
    const field = compileWaveField(components, { depth: 4 })
    const forward = SAMPLES.map(([x, z, t]) => sampleHeight(field, x, z, t))
    const backward = [...SAMPLES].reverse().map(([x, z, t]) => sampleHeight(field, x, z, t))
    expect(backward.reverse()).toStrictEqual(forward)
  })

  it('agrees with a hand-derived vector, so a port can be checked against it', () => {
    // A = 0.12 m, L = 5 m, steepness 0.25, phase 0, depth 4 m, running along +x.
    // k = 2*pi/5, omega = sqrt(g*k*tanh(4k)), theta = k*x - omega*t.
    // Displacement is ( -(steepness/k)*sin(theta), A*cos(theta), 0 ).
    // Worked out independently of this module; a silent drift here is a bug.
    const field = compileWaveField([singleWave()], { depth: 4 })
    const d = sampleDisplacement(field, 1.25, -0.75, 2.5)
    expect(d[0]).toBeCloseTo(0.1586785102505359, 15)
    expect(d[1]).toBeCloseTo(0.07238158535094147, 15)
    expect(d[2]).toBe(0)
    // The same numbers again, but reached through the public dispersion helpers.
    const theta = waveNumber(5) * 1.25 - (TWO_PI / wavePeriod(5, 4)) * 2.5
    expect(d[0]).toBeCloseTo(-(0.25 / waveNumber(5)) * Math.sin(theta), 12)
    expect(d[1]).toBeCloseTo(0.12 * Math.cos(theta), 12)
  })
})

describe('compileWaveField', () => {
  it('precomputes the derived terms', () => {
    const field = compileWaveField([singleWave({ wavelength: 5, steepness: 0.25 })], { depth: 4 })
    const wave = field.waves[0]
    expect(wave.wavenumber).toBeCloseTo(TWO_PI / 5, 12)
    expect(wave.angularFrequency).toBeCloseTo(angularFrequency(TWO_PI / 5, 4), 12)
    expect(wave.horizontalAmplitude).toBeCloseTo(0.25 / (TWO_PI / 5), 12)
    expect(field.depth).toBe(4)
    expect(field.gravity).toBe(GRAVITY)
  })

  it('rejects a direction that is not unit length', () => {
    expect(() => compileWaveField([singleWave({ dir: [2, 0] })])).toThrow(/unit length/)
    expect(() => compileWaveField([singleWave({ dir: [0, 0] })])).toThrow(/unit length/)
    expect(() => compileWaveField([singleWave({ dir: [0.6, 0.8] })])).not.toThrow()
  })

  it('rejects out-of-range parameters', () => {
    expect(() => compileWaveField([singleWave({ amplitude: -0.1 })])).toThrow(/amplitude/)
    expect(() => compileWaveField([singleWave({ steepness: 1 })])).toThrow(/steepness/)
    expect(() => compileWaveField([singleWave({ steepness: -0.1 })])).toThrow(/steepness/)
    expect(() => compileWaveField([singleWave({ phase: Number.NaN })])).toThrow(/phase/)
    expect(() => compileWaveField([singleWave()], { depth: 0 })).toThrow(/depth/)
    expect(() => compileWaveField([singleWave()], { gravity: 0 })).toThrow(/gravity/)
  })

  it('refuses a field whose summed steepness would cusp', () => {
    const four = Array.from({ length: 4 }, () => singleWave({ steepness: 0.3 }))
    expect(totalSteepness(four)).toBeCloseTo(1.2, 12)
    expect(() => compileWaveField(four)).toThrow(/cusp/)

    const three = Array.from({ length: 3 }, () => singleWave({ steepness: 0.3 }))
    expect(() => compileWaveField(three)).not.toThrow()
  })
})

describe('tawasPreset', () => {
  const components = tawasPreset()

  it('returns five components', () => {
    expect(components).toHaveLength(5)
  })

  it('keeps every wavelength in the 3-8 m band the brief asks for', () => {
    for (const wave of components) {
      expect(wave.wavelength).toBeGreaterThanOrEqual(3)
      expect(wave.wavelength).toBeLessThanOrEqual(8)
    }
  })

  it('lands the periods in the wind-chop band, not the swell band', () => {
    // The build plan guessed 2-4 s, but the dispersion relation puts 3-8 m
    // waves at 1.39-2.36 s. A 4 s period would need a 25 m wavelength.
    for (const depth of [Infinity, 4, 2]) {
      for (const wave of components) {
        const period = wavePeriod(wave.wavelength, depth)
        expect(period).toBeGreaterThan(1.3)
        expect(period).toBeLessThan(2.4)
      }
    }
  })

  it('stays well below cusping', () => {
    expect(totalSteepness(components)).toBeGreaterThan(0)
    expect(totalSteepness(components)).toBeLessThan(0.5)
    expect(() => compileWaveField(components, { depth: 4 })).not.toThrow()
  })

  it('gives every component a unit direction', () => {
    for (const wave of components) {
      expect(Math.hypot(wave.dir[0], wave.dir[1])).toBeCloseTo(1, 12)
    }
  })

  it('spreads directions around the requested heading', () => {
    const heading = 0.9
    const spread = tawasPreset({ heading })
    const offsets = spread.map((wave) => Math.atan2(wave.dir[1], wave.dir[0]) - heading)

    // The dominant train sits on the wind axis.
    expect(offsets[0]).toBeCloseTo(0, 12)
    // The rest fan out to either side, inside a realistic wind-sea spread.
    expect(offsets.some((o) => o > 0.1)).toBe(true)
    expect(offsets.some((o) => o < -0.1)).toBe(true)
    for (const offset of offsets) {
      expect(Math.abs(offset)).toBeLessThan(Math.PI / 4)
    }
  })

  it('rotates rigidly with the heading', () => {
    const base = tawasPreset({ heading: 0 })
    const turned = tawasPreset({ heading: Math.PI / 2 })
    for (let i = 0; i < base.length; i++) {
      // Rotating by +90 degrees maps (x, z) to (-z, x).
      expect(turned[i].dir[0]).toBeCloseTo(-base[i].dir[1], 12)
      expect(turned[i].dir[1]).toBeCloseTo(base[i].dir[0], 12)
      expect(turned[i].wavelength).toBe(base[i].wavelength)
      expect(turned[i].steepness).toBeCloseTo(base[i].steepness, 12)
    }
  })

  it('collapses the spread to one direction when asked', () => {
    const collimated = tawasPreset({ heading: 0.4, spreadScale: 0 })
    for (const wave of collimated) {
      expect(wave.dir[0]).toBeCloseTo(Math.cos(0.4), 12)
      expect(wave.dir[1]).toBeCloseTo(Math.sin(0.4), 12)
    }
  })

  it('scales amplitude and steepness together, so the shape holds', () => {
    const half = tawasPreset({ amplitudeScale: 0.5 })
    for (let i = 0; i < components.length; i++) {
      expect(half[i].amplitude).toBeCloseTo(components[i].amplitude / 2, 12)
      expect(half[i].steepness).toBeCloseTo(components[i].steepness / 2, 12)
    }
  })

  it('flattens particle orbits as sharpness drops', () => {
    const soft = tawasPreset({ sharpness: 0.2 })
    for (let i = 0; i < components.length; i++) {
      expect(soft[i].amplitude).toBeCloseTo(components[i].amplitude, 12)
      expect(soft[i].steepness).toBeLessThan(components[i].steepness)
    }
    expect(totalSteepness(tawasPreset({ sharpness: 0 }))).toBe(0)
  })

  it('is a pure function of its options', () => {
    expect(tawasPreset({ heading: 2.2, amplitudeScale: 1.4 })).toStrictEqual(
      tawasPreset({ heading: 2.2, amplitudeScale: 1.4 }),
    )
  })

  it('rejects nonsense options', () => {
    expect(() => tawasPreset({ heading: Number.NaN })).toThrow(/heading/)
    expect(() => tawasPreset({ amplitudeScale: -1 })).toThrow(/amplitudeScale/)
    expect(() => tawasPreset({ sharpness: 1.5 })).toThrow(/sharpness/)
  })

  it('builds a field that actually moves', () => {
    const field = compileWaveField(components, { depth: 4 })
    const still = sampleHeight(field, 0, 0, 0)
    const later = sampleHeight(field, 0, 0, 0.5)
    expect(Math.abs(later - still)).toBeGreaterThan(1e-3)
  })
})

describe('directionFromHeading', () => {
  it('points along +x at heading zero and +z at a quarter turn', () => {
    expect(directionFromHeading(0)[0]).toBeCloseTo(1, 12)
    expect(directionFromHeading(0)[1]).toBeCloseTo(0, 12)
    expect(directionFromHeading(Math.PI / 2)[0]).toBeCloseTo(0, 12)
    expect(directionFromHeading(Math.PI / 2)[1]).toBeCloseTo(1, 12)
  })

  it('always returns a unit vector', () => {
    for (let heading = -7; heading < 7; heading += 0.37) {
      const d = directionFromHeading(heading)
      expect(Math.hypot(d[0], d[1])).toBeCloseTo(1, 12)
    }
  })
})

describe('orbital velocity', () => {
  const field = compileWaveField(tawasPreset({ heading: 0.4 }), { depth: 4 })

  it('matches a central difference of the displacement in time', () => {
    const h = 1e-5
    for (const [x, z, t] of SAMPLES) {
      const before = sampleDisplacement(field, x, z, t - h)
      const after = sampleDisplacement(field, x, z, t + h)
      const numeric: Vec3 = [
        (after[0] - before[0]) / (2 * h),
        (after[1] - before[1]) / (2 * h),
        (after[2] - before[2]) / (2 * h),
      ]
      const analytic = sampleVelocity(field, x, z, t)
      for (let i = 0; i < 3; i++) {
        expect(analytic[i], `axis ${i} at (${x}, ${z}, ${t})`).toBeCloseTo(numeric[i], 6)
      }
    }
  })

  it('is zero on still water', () => {
    expect(sampleVelocity(flatWaterField(), 3, -4, 5)).toEqual([0, 0, 0])
  })

  it('scales with amplitude', () => {
    const half = compileWaveField(tawasPreset({ heading: 0.4, amplitudeScale: 0.5 }), { depth: 4 })
    const full = sampleVelocity(field, 2.5, -1.5, 3.25)
    const softer = sampleVelocity(half, 2.5, -1.5, 3.25)
    for (let i = 0; i < 3; i++) expect(softer[i]).toBeCloseTo(full[i] / 2, 12)
  })

  it('stays well below the phase speed, so the wave does not break', () => {
    const slowest = Math.min(...tawasPreset().map((w) => phaseSpeed(w.wavelength, 4)))
    for (let x = -10; x <= 10; x += 1.25) {
      for (let z = -10; z <= 10; z += 1.25) {
        const v = sampleVelocity(field, x, z, 6.5)
        expect(Math.hypot(v[0], v[1], v[2])).toBeLessThan(slowest)
      }
    }
  })
})

describe('world-space sampling', () => {
  const field = compileWaveField(tawasPreset({ heading: 0.9 }), { depth: 4 })

  it('finds the parameter whose surface point stands over the world column', () => {
    // Worst residual at the default iteration count, swept rather than spot
    // checked: a single lucky sample would hide a slow corner of the field.
    let worst = 0
    for (let worldX = -20; worldX <= 20; worldX += 1.1) {
      for (let worldZ = -20; worldZ <= 20; worldZ += 1.3) {
        const [x, z] = sampleParameterAt(field, worldX, worldZ, 3.75)
        const d = sampleDisplacement(field, x, z, 3.75)
        worst = Math.max(worst, Math.hypot(x + d[0] - worldX, z + d[2] - worldZ))
      }
    }
    // Ten microns, against a hull that floats at about a tenth of a metre.
    expect(worst).toBeLessThan(1e-5)
  })

  it('converges geometrically, at roughly the steepness per pass', () => {
    const residualAt = (iterations: number): number => {
      let worst = 0
      for (let worldX = -20; worldX <= 20; worldX += 2.2) {
        for (let worldZ = -20; worldZ <= 20; worldZ += 2.6) {
          const [x, z] = sampleParameterAt(field, worldX, worldZ, 3.75, iterations)
          const d = sampleDisplacement(field, x, z, 3.75)
          worst = Math.max(worst, Math.hypot(x + d[0] - worldX, z + d[2] - worldZ))
        }
      }
      return worst
    }

    for (const iterations of [2, 3, 4, 5]) {
      const factor = residualAt(iterations) / residualAt(iterations - 1)
      expect(factor, `pass ${iterations}`).toBeLessThan(0.35)
    }
  })

  it('converges further with each iteration', () => {
    const worldX = 4.25
    const worldZ = -6.5
    const t = 3.75
    let previous = Infinity

    for (const iterations of [0, 1, 2, 3, 4, 6]) {
      const [x, z] = sampleParameterAt(field, worldX, worldZ, t, iterations)
      const d = sampleDisplacement(field, x, z, t)
      const residual = Math.hypot(x + d[0] - worldX, z + d[2] - worldZ)
      expect(residual, `at ${iterations} iterations`).toBeLessThanOrEqual(previous)
      previous = residual
    }
    expect(previous).toBeLessThan(1e-5)
  })

  it('is the identity on still water', () => {
    const flat = flatWaterField()
    expect(sampleParameterAt(flat, 7.5, -2.25, 9)).toEqual([7.5, -2.25])
    expect(sampleHeightAt(flat, 7.5, -2.25, 9)).toBe(0)
    expect(sampleNormalAt(flat, 7.5, -2.25, 9)).toEqual([0, 1, 0])
    expect(sampleVelocityAt(flat, 7.5, -2.25, 9)).toEqual([0, 0, 0])
  })

  it('differs from the parametric height, which is the whole reason it exists', () => {
    // If these agreed, the inversion would be pointless. They must not.
    let maxGap = 0
    for (const [x, z, t] of SAMPLES) {
      maxGap = Math.max(maxGap, Math.abs(sampleHeightAt(field, x, z, t) - sampleHeight(field, x, z, t)))
    }
    expect(maxGap).toBeGreaterThan(1e-3)
  })

  it('agrees with the parametric sampler when steepness is zero', () => {
    // No horizontal displacement means the surface is a plain heightfield.
    const sine = compileWaveField(tawasPreset({ heading: 0.9, sharpness: 0 }), { depth: 4 })
    for (const [x, z, t] of SAMPLES) {
      expect(sampleHeightAt(sine, x, z, t)).toBeCloseTo(sampleHeight(sine, x, z, t), 12)
    }
  })

  it('is single-valued: nearby columns give nearby heights', () => {
    // A folded surface would make this jump. Steepness below 1 forbids that.
    const t = 5.5
    for (let x = -6; x <= 6; x += 0.5) {
      const here = sampleHeightAt(field, x, 1.5, t)
      const next = sampleHeightAt(field, x + 0.01, 1.5, t)
      expect(Math.abs(next - here)).toBeLessThan(0.05)
    }
  })

  it('is deterministic', () => {
    const first = sampleHeightAt(field, 3.25, -7.75, 2.5)
    for (let i = 0; i < 32; i++) {
      expect(sampleHeightAt(field, 3.25, -7.75, 2.5)).toBe(first)
    }
  })
})
