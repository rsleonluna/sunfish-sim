import { describe, expect, it } from 'vitest'
import {
  dynamicPressure,
  liftSlope,
  smoothstep,
  surfaceCoefficients,
  type SurfaceConfig,
} from '../lifting-surface.ts'

const TWO_PI = Math.PI * 2

function config(overrides: Partial<SurfaceConfig> = {}): SurfaceConfig {
  return {
    aspectRatio: 3,
    spanEfficiency: 0.9,
    stallAngle: 0.3,
    stallWidth: 0.2,
    plateLift: 1.1,
    baseDrag: 0.02,
    formDrag: 1.3,
    ...overrides,
  }
}

describe('liftSlope', () => {
  it('never reaches the infinite-span value', () => {
    for (const aspectRatio of [0.5, 2, 5, 20]) {
      expect(liftSlope(aspectRatio, 1)).toBeLessThan(TWO_PI)
    }
  })

  it('approaches 2*pi as the span grows', () => {
    expect(liftSlope(10000, 1)).toBeCloseTo(TWO_PI, 2)
    expect(liftSlope(1, 1)).toBeLessThan(liftSlope(10, 1))
    expect(liftSlope(10, 1)).toBeLessThan(liftSlope(100, 1))
  })

  it('costs a low-aspect rig most of its lift slope', () => {
    // A Sunfish sail at 2.2 gets barely half of thin-airfoil theory.
    const sunfish = liftSlope(2.21, 0.8)
    expect(sunfish / TWO_PI).toBeGreaterThan(0.4)
    expect(sunfish / TWO_PI).toBeLessThan(0.55)
  })

  it('rejects nonsense geometry', () => {
    expect(() => liftSlope(0, 1)).toThrow(/aspectRatio/)
    expect(() => liftSlope(-2, 1)).toThrow(/aspectRatio/)
    expect(() => liftSlope(3, 0)).toThrow(/spanEfficiency/)
    expect(() => liftSlope(3, 1.4)).toThrow(/spanEfficiency/)
  })
})

describe('smoothstep', () => {
  it('clamps outside its edges', () => {
    expect(smoothstep(1, 2, 0)).toBe(0)
    expect(smoothstep(1, 2, 3)).toBe(1)
  })

  it('is a half at the midpoint and flat at both ends', () => {
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 12)
    expect(smoothstep(0, 1, 0.001)).toBeLessThan(0.001)
    expect(smoothstep(0, 1, 0.999)).toBeGreaterThan(0.999)
  })

  it('degenerates to a step for a zero-width ramp', () => {
    expect(smoothstep(1, 1, 0.9)).toBe(0)
    expect(smoothstep(1, 1, 1.1)).toBe(1)
  })
})

describe('surfaceCoefficients', () => {
  it('makes no lift at the zero-lift angle', () => {
    expect(surfaceCoefficients(0, config()).lift).toBeCloseTo(0, 12)
    expect(surfaceCoefficients(0.2, config(), 0.2).lift).toBeCloseTo(0, 12)
  })

  it('follows the lift slope while flow stays attached', () => {
    const surface = config()
    const slope = liftSlope(surface.aspectRatio, surface.spanEfficiency)
    for (const alpha of [0.02, 0.05, 0.1]) {
      expect(surfaceCoefficients(alpha, surface).lift).toBeCloseTo(slope * alpha, 9)
    }
  })

  it('is odd in angle when there is no camber', () => {
    for (const alpha of [0.1, 0.4, 0.9, 1.4]) {
      const up = surfaceCoefficients(alpha, config())
      const down = surfaceCoefficients(-alpha, config())
      expect(down.lift).toBeCloseTo(-up.lift, 12)
      expect(down.drag).toBeCloseTo(up.drag, 12)
    }
  })

  it('behaves like a flat plate broadside on', () => {
    const broadside = surfaceCoefficients(Math.PI / 2, config())
    // No lift, and drag at its maximum.
    expect(broadside.lift).toBeCloseTo(0, 6)
    expect(broadside.stalled).toBe(true)
    expect(broadside.drag).toBeGreaterThan(config().formDrag)
    for (const alpha of [0.2, 0.6, 1.0, 1.3]) {
      expect(surfaceCoefficients(alpha, config()).drag).toBeLessThan(broadside.drag)
    }
  })

  it('peaks somewhere near the stall angle, not at forty-five degrees', () => {
    const surface = config()
    let bestAlpha = 0
    let bestLift = 0
    for (let alpha = 0; alpha < 1.5; alpha += 0.005) {
      const lift = surfaceCoefficients(alpha, surface).lift
      if (lift > bestLift) {
        bestLift = lift
        bestAlpha = alpha
      }
    }
    expect(bestAlpha).toBeGreaterThan(surface.stallAngle * 0.8)
    expect(bestAlpha).toBeLessThan(surface.stallAngle + surface.stallWidth * 1.5)
  })

  it('crosses the stall blend without a step', () => {
    // A jump here would arrive in the rigid body as a bang.
    const surface = config()
    let previous = surfaceCoefficients(0, surface)
    for (let alpha = 0.001; alpha <= Math.PI; alpha += 0.001) {
      const current = surfaceCoefficients(alpha, surface)
      expect(Math.abs(current.lift - previous.lift), `lift jumped at ${alpha}`).toBeLessThan(0.01)
      expect(Math.abs(current.drag - previous.drag), `drag jumped at ${alpha}`).toBeLessThan(0.01)
      previous = current
    }
  })

  it('never drags less than its profile drag', () => {
    for (let alpha = -Math.PI; alpha <= Math.PI; alpha += 0.01) {
      expect(surfaceCoefficients(alpha, config()).drag).toBeGreaterThanOrEqual(config().baseDrag)
    }
  })

  it('charges induced drag for lift, and more of it at low aspect ratio', () => {
    const alpha = 0.15
    const stubby = surfaceCoefficients(alpha, config({ aspectRatio: 1 }))
    const slender = surfaceCoefficients(alpha, config({ aspectRatio: 12 }))

    // The slender surface makes more lift for less drag: that is the whole
    // point of a high-aspect rig.
    expect(slender.lift).toBeGreaterThan(stubby.lift)
    expect(slender.drag - config().baseDrag).toBeLessThan(stubby.drag - config().baseDrag)
  })

  it('reports separation as a fraction and a flag that agree', () => {
    const surface = config()
    expect(surfaceCoefficients(0.1, surface).separation).toBe(0)
    expect(surfaceCoefficients(0.1, surface).stalled).toBe(false)
    expect(surfaceCoefficients(1.2, surface).separation).toBe(1)
    expect(surfaceCoefficients(1.2, surface).stalled).toBe(true)

    for (let alpha = 0; alpha < 1.5; alpha += 0.01) {
      const result = surfaceCoefficients(alpha, surface)
      expect(result.stalled).toBe(result.separation > 0.5)
    }
  })

  it('separates on geometric angle, not on where camber put the zero-lift point', () => {
    // A well-set cambered sail must not read as stalled just for being cambered.
    const surface = config()
    const cambered = surfaceCoefficients(0.2, surface, -0.2)
    const plain = surfaceCoefficients(0.2, surface)
    expect(cambered.separation).toBe(plain.separation)
    expect(cambered.lift).toBeGreaterThan(plain.lift)
  })

  it('is deterministic', () => {
    const first = surfaceCoefficients(0.37, config(), -0.1)
    for (let i = 0; i < 32; i++) {
      expect(surfaceCoefficients(0.37, config(), -0.1)).toStrictEqual(first)
    }
  })
})

describe('dynamicPressure', () => {
  it('is half rho v squared', () => {
    expect(dynamicPressure(1.225, 10)).toBeCloseTo(0.5 * 1.225 * 100, 12)
    expect(dynamicPressure(1000, 2)).toBeCloseTo(2000, 12)
  })

  it('quadruples when speed doubles', () => {
    expect(dynamicPressure(1.225, 8) / dynamicPressure(1.225, 4)).toBeCloseTo(4, 12)
  })
})
