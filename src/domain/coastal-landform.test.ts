import { describe, expect, it } from 'vitest'
import { coastalBedProfile, coastalLandform, coastalSeaLevel, ellipseDistance } from './coastal-landform'
import { initialLandscape } from './initial-landscape'
import { terrainNoise, terrainSeed } from './regional-terrain'
import type { CityConfig, Point } from './types'

const seeds = ['tdsvn3cw', 'minato-2026', 'trpg-42', 'sakura-19', 'another-valley', 'outline-57'] as const
const modes = ['bay', 'ria', 'delta', 'peninsula'] as const
const extent = 24_000

describe('relative coastal base-level history', () => {
  it.each([['ria', -40], ['peninsula', -80]] as const)('%s drowns the evolved margin during the final sixteen geological updates', (kind, lowstand) => {
    const levels = Array.from({ length: 257 }, (_, i) => coastalSeaLevel(kind, i, 256))
    expect(levels.slice(0, 241).every(level => level === lowstand)).toBe(true)
    expect(levels[248]).toBe(lowstand / 2)
    expect(levels[256]).toBeCloseTo(0, 10)
    for (let i = 1; i < levels.length; i++) {
      expect(Number.isFinite(levels[i])).toBe(true)
      expect(levels[i]!).toBeGreaterThanOrEqual(levels[i - 1]!)
      expect(levels[i]!).toBeLessThanOrEqual(0)
    }
  })
  it.each(['bay', 'delta', undefined] as const)('%s retains its existing constant reference level', kind => {
    for (let i = 0; i <= 256; i++) expect(coastalSeaLevel(kind, i, 256)).toBe(0)
  })
})

/** Four-neighbour connectivity deliberately excludes diagonal corner contact:
 * a peninsula needs a resolved land neck, and its surrounding sea an outlet. */
function components(elevation: Float32Array, columns: number, land: boolean) {
  const labels = new Int32Array(elevation.length), sizes: number[] = [], queue = new Int32Array(elevation.length)
  for (let start = 0; start < elevation.length; start++) {
    if (labels[start] || (elevation[start]! > 0) !== land) continue
    const label = sizes.length + 1
    let head = 0, tail = 1
    queue[0] = start; labels[start] = label
    while (head < tail) {
      const i = queue[head++]!, x = i % columns, y = Math.floor(i / columns)
      for (const j of [x ? i - 1 : -1, x + 1 < columns ? i + 1 : -1, y ? i - columns : -1, y + 1 < columns ? i + columns : -1]) {
        if (j >= 0 && !labels[j] && (elevation[j]! > 0) === land) { labels[j] = label; queue[tail++] = j }
      }
    }
    sizes.push(tail)
  }
  return { labels, sizes }
}

function seededLandscape(name: string, coastType: NonNullable<CityConfig['coastType']>, resolution: number) {
  const seed = terrainSeed(`${name}:uplift-v1`), columns = extent / resolution + 1
  const input = { extent, columns, resolution, seed, noise: terrainNoise, coastType }
  return { ...input, ...initialLandscape(input), landform: coastalLandform(input) }
}

function cellAt(point: Point, columns: number, resolution: number) {
  const x = Math.round(point.x / resolution), y = Math.round(point.y / resolution)
  expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(columns)
  expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(columns)
  return y * columns + x
}

describe('metric ellipse distance before the coastal noise warp', () => {
  const shapes = [
    { name: 'wide ellipse', rx: 6000, ry: 2000, centre: { x: 12_031.5, y: -1876.25 }, angle: 0 },
    { name: 'rotated wide ellipse', rx: 6000, ry: 2000, centre: { x: 7200, y: 15_400 }, angle: .37 },
    { name: 'rotated tall ellipse', rx: 2000, ry: 6000, centre: { x: -3050.25, y: 8700.5 }, angle: -.91 },
    { name: 'rotated regional ellipse', rx: 26_400, ry: 13_920, centre: { x: 12_000, y: -6480 }, angle: .53 },
    { name: 'circle', rx: 1800, ry: 1800, centre: { x: 875.5, y: -950.25 }, angle: 1.13 },
  ]
  for (const shape of shapes) {
    const world = (p: Point): Point => ({ x: shape.centre.x + p.x * Math.cos(shape.angle) - p.y * Math.sin(shape.angle), y: shape.centre.y + p.x * Math.sin(shape.angle) + p.y * Math.cos(shape.angle) })
    const distance = (p: Point) => ellipseDistance(world(p), shape.centre, shape.rx, shape.ry, shape.angle)
    // Two nearest-point solves each have at most half a final angular bracket
    // of positional error. The regional ellipse allows about 1.24 mm, not a
    // terrain-cell-sized tolerance that could conceal a centre singularity.
    const tolerance = Math.max(shape.rx, shape.ry) * Math.PI / 2 ** 26 + 1e-7

    it(`${shape.name}: has the minor-radius centre distance and continuous medial axes`, () => {
      const centreDistance = Math.min(shape.rx, shape.ry)
      expect(ellipseDistance(shape.centre, shape.centre, shape.rx, shape.ry, shape.angle)).toBeCloseTo(centreDistance, 8)
      for (const epsilon of [1e-7, 1e-4, .1, 1, 25]) {
        for (const direction of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }, { x: Math.SQRT1_2, y: Math.SQRT1_2 }]) {
          const nearby = distance({ x: direction.x * epsilon, y: direction.y * epsilon })
          expect(Number.isFinite(nearby)).toBe(true)
          expect(Math.abs(nearby - centreDistance)).toBeLessThanOrEqual(epsilon + tolerance)
        }
      }
      const majorIsX = shape.rx >= shape.ry, major = Math.max(shape.rx, shape.ry), minor = Math.min(shape.rx, shape.ry)
      const medialEnd = (major * major - minor * minor) / major
      for (const along of [-medialEnd, -medialEnd / 2, 0, medialEnd / 2, medialEnd]) {
        const axis = majorIsX ? { x: along, y: 0 } : { x: 0, y: along }
        for (const epsilon of [1e-4, .1]) {
          const above = majorIsX ? { x: along, y: epsilon } : { x: epsilon, y: along }
          const below = majorIsX ? { x: along, y: -epsilon } : { x: -epsilon, y: along }
          expect(Math.abs(distance(above) - distance(axis))).toBeLessThanOrEqual(epsilon + tolerance)
          expect(Math.abs(distance(below) - distance(axis))).toBeLessThanOrEqual(epsilon + tolerance)
          expect(Math.abs(distance(above) - distance(below))).toBeLessThanOrEqual(tolerance)
        }
      }
    })

    it(`${shape.name}: is signed and 1-Lipschitz across the centre, axes and shore`, () => {
      const points: Point[] = [{ x: 0, y: 0 }, { x: shape.rx * .55, y: shape.ry * .4 }, { x: -shape.rx * 1.2, y: shape.ry * 1.2 }]
      for (const sign of [-1, 1]) for (const epsilon of [-50, -.01, 0, .01, 50]) {
        points.push({ x: sign * epsilon, y: 0 }, { x: 0, y: sign * epsilon }, { x: sign * (shape.rx + epsilon), y: 0 }, { x: 0, y: sign * (shape.ry + epsilon) })
      }
      const samples = points.map(point => ({ point: world(point), value: distance(point) }))
      for (const sample of samples) expect(Number.isFinite(sample.value)).toBe(true)
      for (let i = 0; i < samples.length; i++) for (let j = i + 1; j < samples.length; j++) {
        const a = samples[i]!, b = samples[j]!, separation = Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y)
        expect(Math.abs(a.value - b.value)).toBeLessThanOrEqual(separation + tolerance)
      }
      for (const sign of [-1, 1]) {
        expect(distance({ x: sign * (shape.rx - 50), y: 0 })).toBeGreaterThan(0)
        expect(distance({ x: sign * (shape.rx + 50), y: 0 })).toBeLessThan(0)
        expect(distance({ x: 0, y: sign * (shape.ry - 50) })).toBeGreaterThan(0)
        expect(distance({ x: 0, y: sign * (shape.ry + 50) })).toBeLessThan(0)
      }
    })

    it(`${shape.name}: has no spikes on neighbouring 50 m samples`, () => {
      const major = Math.max(shape.rx, shape.ry), minor = Math.min(shape.rx, shape.ry), medialEnd = (major * major - minor * minor) / major
      const medial = shape.rx >= shape.ry ? { x: medialEnd, y: 0 } : { x: 0, y: medialEnd }
      const windows = [{ x: 0, y: 0 }, medial, { x: -medial.x, y: -medial.y }, { x: shape.rx, y: 0 }, { x: 0, y: shape.ry }]
      let finite = true, steepest = 0
      for (const centre of windows) {
        const columns = 21, samples = new Float64Array(columns * columns)
        for (let y = 0; y < columns; y++) for (let x = 0; x < columns; x++) {
          const value = distance({ x: centre.x + (x - 10) * 50, y: centre.y + (y - 10) * 50 })
          finite &&= Number.isFinite(value)
          samples[y * columns + x] = value
          if (x) steepest = Math.max(steepest, Math.abs(value - samples[y * columns + x - 1]!))
          if (y) steepest = Math.max(steepest, Math.abs(value - samples[(y - 1) * columns + x]!))
        }
      }
      expect(finite).toBe(true)
      expect(steepest).toBeLessThanOrEqual(50 + tolerance)
    })
  }
})

describe('inherited two-dimensional coastal landforms', () => {
  it.each(seeds)('%s has an attached peninsula with exterior sea on three sides', (name) => {
    const resolution = seeds.indexOf(name) % 2 ? 200 : 250
    const world = seededLandscape(name, 'peninsula', resolution)
    const land = components(world.elevation, world.columns, true), water = components(world.elevation, world.columns, false)
    const spine = world.landform.peninsula
    expect(spine.length).toBeGreaterThanOrEqual(3)
    const root = spine[0]!, previous = spine[spine.length - 2]!, tip = spine[spine.length - 1]!
    const rootLabel = land.labels[cellAt(root.point, world.columns, resolution)]!
    expect(rootLabel).toBeGreaterThan(0)
    // Every intervening neck must belong to the mainland, not a detached island.
    for (const part of spine) expect(land.labels[cellAt(part.point, world.columns, resolution)]).toBe(rootLabel)
    const northernLand = new Set<number>()
    for (let x = 0; x < world.columns; x++) if (land.labels[x]) northernLand.add(land.labels[x]!)
    expect(northernLand.has(rootLabel)).toBe(true)

    const dx = tip.point.x - previous.point.x, dy = tip.point.y - previous.point.y, length = Math.hypot(dx, dy)
    const forward = { x: dx / length, y: dy / length }, side = { x: -forward.y, y: forward.x }
    const exterior = new Set<number>()
    for (let i = 0; i < world.elevation.length; i++) {
      const x = i % world.columns, y = Math.floor(i / world.columns)
      if ((!x || !y || x === world.columns - 1 || y === world.columns - 1) && water.labels[i]) exterior.add(water.labels[i]!)
    }
    for (const direction of [forward, side, { x: -side.x, y: -side.y }]) {
      const point = { x: tip.point.x + direction.x * tip.radius * 2.5, y: tip.point.y + direction.y * tip.radius * 2.5 }
      const label = water.labels[cellAt(point, world.columns, resolution)]!
      expect(label).toBeGreaterThan(0)
      expect(exterior.has(label)).toBe(true)
    }

    // A one-valued shore y=f(x) permits only one transition per vertical column.
    // A land-water-land-water column proves that the cape actually turns back.
    let reentrantColumns = 0
    for (let x = 0; x < world.columns; x++) {
      let transitions = 0, previousLand = world.elevation[x]! > 0
      for (let y = 1; y < world.columns; y++) {
        const currentLand = world.elevation[y * world.columns + x]! > 0
        if (currentLand !== previousLand) transitions++
        previousLand = currentLand
      }
      if (transitions >= 3) reentrantColumns++
    }
    expect(reentrantColumns).toBeGreaterThanOrEqual(2)
  })

  for (const coastType of modes) it.each(seeds)(`${coastType}: %s retains finite land and a connected receiving ocean`, (name) => {
    const world = seededLandscape(name, coastType, 250)
    expect(world.elevation.every(Number.isFinite)).toBe(true)
    expect(world.uplift.every(value => Number.isFinite(value) && value >= 0)).toBe(true)
    expect(world.erodibility.every(value => Number.isFinite(value) && value > 0)).toBe(true)
    const landCells = world.elevation.reduce((total, z) => total + Number(z > 0), 0)
    expect(landCells / world.elevation.length).toBeGreaterThan(.1)
    expect(landCells / world.elevation.length).toBeLessThan(.9)
    const water = components(world.elevation, world.columns, false)
    const southStart = world.columns * (world.columns - 1), ocean = water.labels[southStart]!
    expect(ocean).toBeGreaterThan(0)
    let deepestSouth = 0, receivingColumns = 0
    for (let x = 0; x < world.columns; x++) {
      expect(water.labels[southStart + x]).toBe(ocean)
      const elevation = world.elevation[southStart + x]!
      expect(elevation).toBeLessThan(0)
      deepestSouth = Math.min(deepestSouth, elevation)
      receivingColumns += Number(elevation < -50)
    }
    // A tilted headland can leave shallow water beside one corner. The open
    // boundary still needs a broad receiving sea and a resolved outer slope.
    expect(deepestSouth).toBeLessThan(-200)
    expect(receivingColumns / world.columns).toBeGreaterThan(.5)
    // Land is a regional inherited block, not a scattering of noise islands.
    const land = components(world.elevation, world.columns, true)
    expect(Math.max(...land.sizes) / landCells).toBeGreaterThan(.99)
    expect(water.sizes[ocean - 1]! / (world.elevation.length - landCells)).toBeGreaterThan(.99)
  })
})

describe('coastal bed profile measured from the actual coast', () => {
  it.each(modes)('%s resolves a continuous shoreface, shelf and steeper outer receiving slope', (kind) => {
    const profile = (offshore: number) => coastalBedProfile(-offshore, kind)
    const shelfWidth = profile(0).shelfWidth
    expect(profile(0).elevation).toBeCloseTo(0, 10)
    expect(coastalBedProfile(500, kind).elevation).toBeGreaterThan(0)
    expect(profile(200).elevation).toBeLessThan(0)
    expect(profile(200).elevation).toBeGreaterThan(-10)
    let previous = profile(0).elevation
    for (let distance = 25; distance <= shelfWidth + 2500; distance += 25) {
      const next = profile(distance).elevation
      expect(Number.isFinite(next)).toBe(true)
      expect(next).toBeLessThan(previous)
      previous = next
    }
    const grade = (a: number, b: number) => (profile(a).elevation - profile(b).elevation) / (b - a)
    expect(grade(shelfWidth + 600, shelfWidth + 1600)).toBeGreaterThan(grade(900, shelfWidth - 400) * 3)
    // The profile and its first derivative join, rather than stepping at shore,
    // shoreface/shelf or shelf/outer-slope transitions.
    for (const join of [0, 600, shelfWidth]) {
      const epsilon = .1
      const left = grade(join - epsilon, join), right = grade(join, join + epsilon)
      expect(Math.abs(left - right)).toBeLessThan(.0001)
    }
    expect(profile(1600).upliftWeight).toBe(0)
    expect(profile(1600).landWeight).toBe(0)
    expect(profile(1600).detailWeight).toBe(0)
    const high = coastalBedProfile(-shelfWidth - 1600, kind, 'mountains')
    expect(high.elevation).toBeLessThan(profile(shelfWidth + 1600).elevation)
  })

  it('retains broader shallow delta geology and the narrower ria shelf', () => {
    const ria = coastalBedProfile(-3500, 'ria'), bay = coastalBedProfile(-3500, 'bay'), delta = coastalBedProfile(-3500, 'delta')
    expect(ria.shelfWidth).toBeLessThan(bay.shelfWidth)
    expect(bay.shelfWidth).toBeLessThan(delta.shelfWidth)
    expect(ria.elevation).toBeLessThan(bay.elevation)
    expect(bay.elevation).toBeLessThan(delta.elevation)
    expect(coastalBedProfile(3000, 'delta').elevation).toBeLessThan(coastalBedProfile(3000, 'ria').elevation)
  })
  it('provides deep bay accommodation beside the rocky peninsula while retaining a resolved shallow shoreface', () => {
    expect(coastalBedProfile(-2000, 'peninsula').elevation).toBeLessThan(-140)
    expect(coastalBedProfile(-2600, 'peninsula').elevation).toBeLessThan(-210)
    const shallow = [50, 100, 150, 200].map(distance => coastalBedProfile(-distance, 'peninsula').elevation)
    expect(shallow.every(z => z < 0 && z > -10)).toBe(true)
  })
})
