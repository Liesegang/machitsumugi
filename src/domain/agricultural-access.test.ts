import { describe, expect, it } from 'vitest'
import { agriculturalAccessSurvey } from './agricultural-access'
import { rectangle } from './geometry'
import type { Point, Road } from './types'

const road = (id: string, x: number): Road => ({ id, points: [{ x, y: 0 }, { x, y: 400 }], kind: 'local', width: 4, role: 'farm', builtYear: 1650 })
const terrain = { elevation: () => 2, slope: () => 0, waterAt: () => false }
const field = { polygon: rectangle(100, 100, 40, 60) }

describe('physical farm access after urban acquisition', () => {
  it('requires a dry traversable entrance instead of distance across a river or railway', () => {
    const water = { polygon: rectangle(50, -50, 15, 500) }
    expect(agriculturalAccessSurvey([road('west', 0)], terrain, [])(field)).toBe(true)
    expect(agriculturalAccessSurvey([road('west', 0)], terrain, [water])(field)).toBe(false)
    expect(agriculturalAccessSurvey([road('west', 0)], { ...terrain, waterAt: (p: Point) => p.x >= 50 && p.x <= 65 }, [])(field)).toBe(false)
    const rail = { polygon: rectangle(50, -50, 17, 500) }
    expect(agriculturalAccessSurvey([road('west', 0)], terrain, [rail])(field)).toBe(false)
    // A current road on the field's own bank remains a valid entrance; the
    // algorithm is not restricted to the inaccessible nearest historic road.
    expect(agriculturalAccessSurvey([road('west', 0), { ...road('east-new', 185), builtYear: 1970 }], terrain, [water, rail])(field)).toBe(true)
  })

  it('does not route a field entrance through acquired houses, a cliff or controlled access', () => {
    const acquired = { polygon: rectangle(50, -50, 20, 500) }
    expect(agriculturalAccessSurvey([road('west', 0)], terrain, [acquired])(field)).toBe(false)
    expect(agriculturalAccessSurvey([road('west', 0)], { ...terrain, slope: (p: Point) => p.x > 50 && p.x < 65 ? .4 : 0 }, [])(field)).toBe(false)
    expect(agriculturalAccessSurvey([road('west', 0)], { ...terrain, elevation: (p: Point) => p.x < 60 ? 25 : 2 }, [])(field)).toBe(false)
    expect(agriculturalAccessSurvey([{ ...road('motorway', 80), controlledAccess: true }], terrain, [])(field)).toBe(false)
  })

  it('checks each surviving piece, including land stranded by a later acquisition', () => {
    const acquired = { polygon: rectangle(60, -50, 15, 500) }
    const survey = agriculturalAccessSurvey([road('west', 0)], terrain, [acquired])
    expect(survey({ polygon: rectangle(15, 100, 40, 60) })).toBe(true)
    expect(survey(field)).toBe(false)
    // A clearing/hole is usable land; its surrounding exclusion does not
    // flatten the hole back into an obstacle.
    expect(agriculturalAccessSurvey([road('inside-clearing', 80)], terrain, [{ polygon: rectangle(0, 0, 300, 300), holes: [rectangle(70, 70, 100, 130)] }])(field)).toBe(true)
  })
})
