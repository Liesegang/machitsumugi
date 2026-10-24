import { describe, expect, it } from 'vitest'
import { surveyResidentialEstate } from './residential-estate'
import { corridorPolygon, pointInPolygon, polygonsOverlap, rectangle } from './geometry'

const base = () => ({ frontage: { x: 130, y: 100 }, along: { x: 1, y: 0 }, roadWidth: 6, frontTitles: [rectangle(100, 106, 30, 30), rectangle(131, 106, 30, 30)], terrain: { elevation: () => 5, slope: () => 0 }, canPlace: () => true, occupied: () => false, affordable: () => true })

describe('new residential estate acquisitions', () => {
  it('surveys actual rear land with a recorded clear private approach rather than stretching an existing house title', () => {
    const input = base(), original = structuredClone(input.frontTitles), estate = surveyResidentialEstate(input)!
    expect(estate?.depth).toBe(90)
    expect(estate.area).toBeGreaterThan(5000)
    expect(estate.footprint.every(point => pointInPolygon(point, estate.polygon))).toBe(true)
    expect(estate.formation.viable).toBe(true)
    expect(estate.access[0]).toEqual(input.frontage)
    for (let i = 2; i < estate.access.length; i++) {
      expect(pointInPolygon(estate.access[i]!, estate.polygon)).toBe(true)
      expect(polygonsOverlap(corridorPolygon(estate.access[i - 1]!, estate.access[i]!, 1.5), estate.footprint)).toBe(false)
    }
    expect(input.frontTitles).toEqual(original)
  })

  it('backs off to70m when a real road or watercourse occupies the deeper options', () => {
    const crossing = rectangle(80, 184, 110, 25)
    const estate = surveyResidentialEstate({ ...base(), canPlace: polygon => !polygonsOverlap(polygon, crossing) })!
    expect(estate?.depth).toBe(70)
    expect(polygonsOverlap(estate.polygon, crossing)).toBe(false)
  })

  it('never takes a separately acquired rear holding even when no building stands on it', () => {
    const oldTitle = rectangle(120, 150, 20, 20)
    expect(surveyResidentialEstate({ ...base(), occupied: polygon => polygonsOverlap(polygon, oldTitle) })).toBeNull()
  })

  it('rejects expensive formation and steep land instead of assuming an unlimited estate subsidy', () => {
    expect(surveyResidentialEstate({ ...base(), affordable: () => false })).toBeNull()
    expect(surveyResidentialEstate({ ...base(), terrain: { elevation: p => p.y * .25, slope: () => .25 } })).toBeNull()
  })
})
