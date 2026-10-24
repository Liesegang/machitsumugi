// Frozen pre-optimization replay; keep its mask order and arithmetic unchanged.
import { describe, expect, it } from 'vitest'
import { agriculturalHistory } from './agricultural-history'
import { rectangle } from './geometry'
import type { Area, TimelineVersion } from './types'
import type { PolygonRegion } from './geometry'
import { boundsOf, overlaps, regionArea, subtractRegions } from './geometry'

interface AgriculturalTitle { id: string; regions: PolygonRegion[]; landUse: 'paddy' | 'dry-field' }
interface AgriculturalAcquisition extends PolygonRegion { year: number }
function sameRing(a: PolygonRegion['polygon'], b: PolygonRegion['polygon']) {
  if (a.length !== b.length) return false
  const start = b.findIndex(p => p.x === a[0]!.x && p.y === a[0]!.y)
  return start >= 0 && [1, -1].some(direction => a.every((p, i) => { const q = b[(start + i * direction + b.length) % b.length]!; return p.x === q.x && p.y === q.y }))
}
const sameRegion = (a: PolygonRegion, b: PolygonRegion) => sameRing(a.polygon, b.polygon) && (a.holes?.length ?? 0) === (b.holes?.length ?? 0) && (a.holes ?? []).every(hole => b.holes!.some(other => sameRing(hole, other)))

/** Replay only local title acquisitions. Surveying/irrigation and urban growth
 * have already run once; unchanged titles share one geometry version. */
function referenceAgriculturalHistory(titles: AgriculturalTitle[], acquisitions: AgriculturalAcquisition[], throughYear: number,
  suitableAt: (year: number) => (region: PolygonRegion, originalArea: number) => boolean): TimelineVersion<Area>[] {
  const states = titles.map(title => ({ title, regions: title.regions, bounds: boundsOf(title.regions.flatMap(region => region.polygon)), area: title.regions.reduce((sum, region) => sum + regionArea(region), 0), live: [] as TimelineVersion<Area>[] }))
  const buckets = new Map<string, Set<typeof states[number]>>()
  for (const state of states) for (let y = Math.floor(state.bounds.minY / 200); y <= Math.floor(state.bounds.maxY / 200); y++) for (let x = Math.floor(state.bounds.minX / 200); x <= Math.floor(state.bounds.maxX / 200); x++) { const key = `${x}:${y}`, group = buckets.get(key) ?? new Set(); group.add(state); buckets.set(key, group) }
  const history: TimelineVersion<Area>[] = []
  const years = new Map<number, AgriculturalAcquisition[]>()
  for (const acquisition of acquisitions) if (acquisition.year <= throughYear) { const year = Math.max(1650, acquisition.year), list = years.get(year) ?? []; list.push(acquisition); years.set(year, list) }
  const emit = (state: typeof states[number], year: number, eligible: ReturnType<typeof suitableAt>) => {
    const visible = state.regions.filter(region => eligible(region, state.area))
    // Changes in feasibility also retire a disconnected/narrow remainder.
    const identical = visible.length === state.live.length && visible.every((region, i) => sameRegion(region, state.live[i]!.value))
    if (identical) return
    for (const version of state.live) version.to = year
    state.live = visible.map((region, part) => ({ from: year, value: { id: `cultivation-${state.title.id}-${part}`, kind: 'field', landUse: state.title.landUse, ...region } }))
    history.push(...state.live)
  }
  const initial = suitableAt(1650)
  const initialMasks = years.get(1650) ?? []
  for (const state of states) { state.regions = state.regions.flatMap(region => subtractRegions(region, initialMasks.filter(mask => overlaps(boundsOf(mask.polygon), state.bounds)))); emit(state, 1650, initial) }
  for (const [year, masks] of [...years].sort(([a], [b]) => a - b)) {
    if (year === 1650) continue
    const affected = new Map<typeof states[number], AgriculturalAcquisition[]>()
    for (const mask of masks) {
      const bounds = boundsOf(mask.polygon), found = new Set<typeof states[number]>()
      for (let y = Math.floor(bounds.minY / 200); y <= Math.floor(bounds.maxY / 200); y++) for (let x = Math.floor(bounds.minX / 200); x <= Math.floor(bounds.maxX / 200); x++) for (const state of buckets.get(`${x}:${y}`) ?? []) if (overlaps(bounds, state.bounds)) found.add(state)
      for (const state of found) { const list = affected.get(state) ?? []; list.push(mask); affected.set(state, list) }
    }
    if (!affected.size) continue
    const eligible = suitableAt(year)
    for (const [state, local] of affected) {
      state.regions = state.regions.flatMap(region => subtractRegions(region, local))
      emit(state, year, eligible)
    }
  }
  return history.filter(version => version.to === undefined || version.to > version.from)
}

describe('exact initial agricultural-mask bounds caching', () => {
  it('preserves titles, holes, dated versions and suitability-call order for overlapping and touching acquisitions', () => {
    const titles: AgriculturalTitle[] = [
      { id: 'island-title', regions: [{ polygon: rectangle(0, 0, 180, 140), holes: [rectangle(60, 50, 30, 25)] }], landUse: 'paddy' },
      { id: 'two-pieces', regions: [{ polygon: rectangle(220, 0, 90, 100) }, { polygon: rectangle(330, 0, 100, 100) }], landUse: 'dry-field' },
      { id: 'remote', regions: [{ polygon: rectangle(1000, 1000, 50, 70) }], landUse: 'dry-field' },
    ]
    const acquisitions = [
      { year: 1600, polygon: rectangle(-10, 15, 65, 15) },
      { year: 1650, polygon: rectangle(25, -10, 20, 130) },
      { year: 1650, polygon: rectangle(180, 0, 40, 20) },
      { year: 1650, polygon: rectangle(260, 10, 100, 15) },
      { year: 1900, polygon: rectangle(85, -5, 16, 150) },
      { year: 1920, polygon: rectangle(210, 50, 240, 10) },
      { year: 1970, polygon: rectangle(1000, 1000, 50, 70) },
      { year: 2030, polygon: rectangle(-10, -10, 1000, 1000) },
    ]
    for (const masks of [acquisitions, [...acquisitions].reverse()]) {
      const expectedCalls: unknown[] = [], actualCalls: unknown[] = []
      const eligibility = (calls: unknown[]) => (year: number) => (region: PolygonRegion, originalArea: number) => {
        calls.push([year, region, originalArea]); return regionArea(region) > 200
      }
      const expected = referenceAgriculturalHistory(titles, masks, 2025, eligibility(expectedCalls))
      expect(agriculturalHistory(titles, masks, 2025, eligibility(actualCalls))).toEqual(expected)
      expect(actualCalls).toEqual(expectedCalls)
      expect(expected.some(version => version.to !== undefined)).toBe(true)
    }
  })
})
