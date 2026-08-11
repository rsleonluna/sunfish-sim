import { describe, expect, it } from 'vitest'
import {
  buildShore,
  groundHeight,
  lighthousePosition,
  mulberry32,
  scatterTrees,
  shoreDistance,
} from '../environment/terrain.ts'

const degrees = (value: number): number => (value * Math.PI) / 180

describe('the bay outline', () => {
  it('wraps without a seam', () => {
    // A discontinuity at +/-180 would show as a crack in the coast.
    expect(shoreDistance(degrees(179.9))).toBeCloseTo(shoreDistance(degrees(-179.9)), 0)
    expect(shoreDistance(degrees(180))).toBeCloseTo(shoreDistance(degrees(-180)), 6)
  })

  it('is continuous all the way round', () => {
    let previous = shoreDistance(degrees(-180))
    for (let bearing = -180; bearing <= 180; bearing += 0.5) {
      const distance = shoreDistance(degrees(bearing))
      // No step bigger than a boat length per half degree.
      expect(Math.abs(distance - previous), `jump at ${bearing}`).toBeLessThan(60)
      previous = distance
    }
  })

  it('encloses the sailing area on three sides and opens to the lake', () => {
    // Land to the west, south and south-east.
    for (const bearing of [180, 150, 120, 90, 60]) {
      expect(shoreDistance(degrees(bearing)), `bearing ${bearing}`).toBeLessThan(1000)
    }
    // Open water to the east and north-east, running off to the horizon.
    for (const bearing of [0, -30]) {
      expect(shoreDistance(degrees(bearing)), `bearing ${bearing}`).toBeGreaterThan(2000)
    }
  })

  it('leaves room to sail: the shore is never close aboard the start', () => {
    for (let bearing = -180; bearing <= 180; bearing += 1) {
      expect(shoreDistance(degrees(bearing))).toBeGreaterThan(200)
    }
  })
})

describe('the cross-shore profile', () => {
  it('comes out of the water rather than off a cliff', () => {
    // Tawas Point is sand. Nothing in the bay is steep.
    let previous = groundHeight(-14)
    for (let inland = -14; inland < 600; inland += 2) {
      const height = groundHeight(inland)
      expect(height).toBeGreaterThanOrEqual(previous - 1e-9)
      // Two metres of rise per two metres inland would be a cliff.
      expect(height - previous, `slope at ${inland} m`).toBeLessThan(0.6)
      previous = height
    }
  })

  it('starts below the waterline and reaches the treeline above it', () => {
    expect(groundHeight(-14)).toBeLessThan(0)
    expect(groundHeight(0)).toBeGreaterThan(0)
    expect(groundHeight(0)).toBeLessThan(0.5)
    expect(groundHeight(190)).toBeGreaterThan(5)
  })
})

describe('the shore mesh', () => {
  const mesh = buildShore(64)

  it('produces a well-formed indexed mesh', () => {
    expect(mesh.positions.length % 3).toBe(0)
    expect(mesh.colours.length).toBe(mesh.positions.length)
    expect(mesh.indices.length % 3).toBe(0)

    const vertexCount = mesh.positions.length / 3
    for (const index of mesh.indices) {
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(vertexCount)
    }
  })

  it('has no degenerate triangles', () => {
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const [a, b, c] = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]]
      expect(a === b || b === c || a === c, `degenerate at ${i}`).toBe(false)
    }
  })

  it('is finite everywhere', () => {
    for (const value of mesh.positions) expect(Number.isFinite(value)).toBe(true)
  })

  it('is identical on every build, so the coast does not reshuffle', () => {
    const again = buildShore(64)
    expect(again.positions).toStrictEqual(mesh.positions)
    expect(again.indices).toStrictEqual(mesh.indices)
  })
})

describe('the treeline', () => {
  const trees = scatterTrees(600)

  it('plants nothing in the water', () => {
    for (const tree of trees) {
      expect(tree.position[1], 'a tree is below the waterline').toBeGreaterThan(0)
    }
  })

  it('keeps off the beach', () => {
    // Every tree must be at least as far back as the dune, which means it can
    // never be nearer the water than the shore curve at its own bearing.
    for (const tree of trees) {
      const bearing = Math.atan2(tree.position[2], tree.position[0])
      const range = Math.hypot(tree.position[0], tree.position[2])
      expect(range).toBeGreaterThan(shoreDistance(bearing) + 20)
    }
  })

  it('is a treeline, not a hedge: denser inland than at the sand', () => {
    const near = trees.filter((tree) => tree.position[1] < 3).length
    const far = trees.filter((tree) => tree.position[1] >= 3).length
    expect(far).toBeGreaterThan(near)
  })

  it('mixes a few paler trees into the dune and none out the back', () => {
    const deciduous = trees.filter((tree) => tree.deciduous === 1)
    expect(deciduous.length).toBeGreaterThan(0)
    expect(deciduous.length).toBeLessThan(trees.length / 2)
    // The birches sit low, near the sand.
    for (const tree of deciduous) expect(tree.position[1]).toBeLessThan(6)
  })

  it('gives every tree a sane size', () => {
    for (const tree of trees) {
      expect(tree.height).toBeGreaterThan(3)
      expect(tree.height).toBeLessThan(25)
      expect(tree.radius).toBeGreaterThan(0.5)
    }
  })

  it('is identical on every scatter', () => {
    expect(scatterTrees(600)).toStrictEqual(trees)
  })
})

describe('the lighthouse', () => {
  const light = lighthousePosition()

  it('stands on the point, out of the water', () => {
    expect(light.position[1]).toBeGreaterThan(0)
    const bearing = Math.atan2(light.position[2], light.position[0])
    const range = Math.hypot(light.position[0], light.position[2])
    // Inland of the waterline, but only just: it is a point light, on a spit.
    expect(range).toBeGreaterThan(shoreDistance(bearing))
    expect(range - shoreDistance(bearing)).toBeLessThan(60)
  })

  it('is close enough to read as a landmark', () => {
    // A 24 m tower needs to subtend more than a degree to be recognisable.
    const range = Math.hypot(light.position[0], light.position[2])
    expect(range).toBeLessThan(700)
    expect((Math.atan(24 / range) * 180) / Math.PI).toBeGreaterThan(1.5)
  })

  it('sits on the sheltering side, not out in the open lake', () => {
    expect(light.bearing).toBeGreaterThan(0)
    expect(light.bearing).toBeLessThan(90)
  })
})

describe('mulberry32', () => {
  it('is deterministic and stays in range', () => {
    const a = mulberry32(1234)
    const b = mulberry32(1234)
    for (let i = 0; i < 200; i++) {
      const value = a()
      expect(value).toBe(b())
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('gives different streams for different seeds', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    expect(a()).not.toBe(b())
  })
})
