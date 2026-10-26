import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { Point } from './types'
import type { PolygonRegion } from './geometry'
import { boundsOf, corridorPolygon, polygonOverlapsRegion, rectangle, seededRandom } from './geometry'
import { indexedPolygonOverlap } from './indexed-polygon-overlap'

const strip = (x: number, y: number, length: number, angle: number, width: number) => corridorPolygon({ x, y }, { x: x + Math.cos(angle) * length, y: y + Math.sin(angle) * length }, width / 2)
const same = (region: PolygonRegion, polygons: Point[][]) => {
  const before = JSON.stringify(region), query = indexedPolygonOverlap(region)
  for (const polygon of polygons) expect(query(polygon)).toBe(polygonOverlapsRegion(polygon, region))
  expect(JSON.stringify(region)).toBe(before)
}

describe('static polygon overlap index', () => {
  it('retains strict vertex, proper crossing, containment and boundary-touch arithmetic', () => {
    const region = { polygon: rectangle(0, 0, 200, 200) }, query = indexedPolygonOverlap(region)
    const cases = [rectangle(10, 10, 20, 20), rectangle(-50, -50, 300, 300), rectangle(-20, 80, 240, 10), rectangle(200, 20, 20, 20), rectangle(200, 200, 20, 20), rectangle(-20, 20, 20, 20), rectangle(220, 20, 10, 10), strip(0, 0, 120, Math.PI / 4, 0)]
    same(region, cases)
    expect(query(cases[0]!)).toBe(true)
    expect(query(cases[3]!)).toBe(false)
    expect(query(cases[4]!)).toBe(true)
    expect(query(cases[6]!)).toBe(false)
  })

  it('preserves individual-hole exclusion and concave crossings without substituting hole-union semantics', () => {
    const concaveHole = [{ x: -400, y: -400 }, { x: 400, y: -400 }, { x: 400, y: 400 }, { x: 140, y: 400 }, { x: 140, y: -120 }, { x: -140, y: -120 }, { x: -140, y: 400 }, { x: -400, y: 400 }]
    const region = { polygon: rectangle(-800, -800, 1600, 1600), holes: [concaveHole] }, crossesNotch = rectangle(-300, 0, 600, 100), insideHole = rectangle(-350, -350, 40, 40)
    same(region, [crossesNotch, insideHole, rectangle(-400, -300, 20, 20), rectangle(-100, -100, 200, 100)])
    expect(indexedPolygonOverlap(region)(crossesNotch)).toBe(true)
    expect(indexedPolygonOverlap(region)(insideHole)).toBe(false)
    const overlappingHoles = { polygon: rectangle(0, 0, 600, 400), holes: [rectangle(100, 100, 200, 200), rectangle(200, 100, 200, 200)] }, spanning = rectangle(150, 150, 200, 50)
    expect(polygonOverlapsRegion(spanning, overlappingHoles)).toBe(true)
    expect(indexedPolygonOverlap(overlappingHoles)(spanning)).toBe(true)
  })

  it('matches reversed/negative/degenerate rings and keeps large diagonal edges in the query', () => {
    const random = seededRandom('indexed-overlap-winding'), ring = rectangle(-300, -200, 600, 400), hole = rectangle(-100, -80, 200, 160)
    const polygons = Array.from({ length: 1500 }, () => strip(random() * 1000 - 500, random() * 800 - 400, random() * 500, random() * Math.PI * 2, random() < .2 ? 0 : 2.5))
    same({ polygon: ring, holes: [hole] }, polygons)
    same({ polygon: [...ring].reverse(), holes: [[...hole].reverse()] }, polygons.map(p => [...p].reverse()))
    same({ polygon: [{ x: 1, y: 2 }, { x: 5, y: 8 }], holes: [[]] }, [rectangle(0, 0, 10, 10), [{ x: 2, y: 4 }]])
    same({ polygon: [{ x: 0, y: 0 }, { x: 12000, y: 12000 }, { x: 0, y: 12000 }] }, [rectangle(5990, 5990, 20, 20), rectangle(100, 9000, 10, 10), rectangle(9000, 100, 10, 10)])
    expect(() => indexedPolygonOverlap({ polygon: ring }, 0)).toThrow(RangeError)
  })

  it('matches a long coast with islands over thousands of small strips', () => {
    const polygon = [...Array.from({ length: 6000 }, (_, i) => ({ x: i * 2, y: 1600 + Math.sin(i / 117) * 220 + Math.sin(i / 19) * 18 })), { x: 11998, y: 9000 }, { x: 0, y: 9000 }], random = seededRandom('indexed-long-coast')
    same({ polygon, holes: [rectangle(2800, 2500, 450, 500)] }, Array.from({ length: 1200 }, () => strip(random() * 12000, 1100 + random() * 2200, random() * 700, random() * Math.PI * 2, 2.5)))
  })

  it('matches saved native water on random strips and exact/near boundary contacts without mutation', () => {
    const regions = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/indexed-polygon-overlap-native-water.json.gz', import.meta.url))).toString()) as PolygonRegion[]
    expect(regions).toHaveLength(14)
    const before = JSON.stringify(regions), random = seededRandom('indexed-native-water')
    for (const region of regions) {
      const query = indexedPolygonOverlap(region), b = boundsOf(region.polygon)
      for (let i = 0; i < 600; i++) {
        const polygon = strip(b.minX - 80 + random() * (b.maxX - b.minX + 160), b.minY - 80 + random() * (b.maxY - b.minY + 160), .001 + random() * 700, random() * Math.PI * 2, [0, 1e-12, .2, 2.5, 14][i % 5]!)
        expect(query(polygon)).toBe(polygonOverlapsRegion(polygon, region))
      }
      for (let i = 0; i < 100; i++) {
        const n = Math.floor(random() * region.polygon.length), a = region.polygon[n]!, b = region.polygon[(n + 1) % region.polygon.length]!, polygon = strip(a.x + [0, 1e-12, -1e-12][i % 3]!, a.y, .1 + random() * 180, Math.atan2(b.y - a.y, b.x - a.x), [0, 1e-12, 2.5][i % 3]!)
        expect(query(polygon)).toBe(polygonOverlapsRegion(polygon, region))
      }
    }
    expect(JSON.stringify(regions)).toBe(before)
  })
})
