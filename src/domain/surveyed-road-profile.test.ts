import { describe, expect, it } from 'vitest'
import { surveyedRoadElevation, surveyedRoadGradeAllowed } from './surveyed-road-profile'

const points = Array.from({ length: 23 }, (_, i) => ({ x: i * 10 - 10, y: 0 }))
const route = { points, surveyedBridgeSpans: [{ bankA: { x: 0, y: 0 }, bankB: { x: 200, y: 0 } }] }

describe('surveyed bridge deck longitudinal grades', () => {
  it('keeps a level bank-to-bank deck above a deep river bed without exempting unbridged terrain', () => {
    const elevation = (p: { x: number }) => p.x > 20 && p.x < 180 ? 0 : 100
    expect(surveyedRoadGradeAllowed({ points }, .10, elevation)).toBe(false)
    expect(surveyedRoadGradeAllowed(route, .10, elevation)).toBe(true)
    expect(surveyedRoadElevation({ x: 100, y: 0 }, route, elevation)).toBe(100)
    expect(surveyedRoadElevation({ x: 100, y: 1 }, route, elevation)).toBe(0)
  })
  it('retains the grade limit on sloping decks and every dry approach outside the surveyed span', () => {
    const steepBridge = (p: { x: number }) => p.x <= 0 ? 100 : p.x >= 200 ? 140 : 0
    expect(surveyedRoadGradeAllowed(route, .10, steepBridge)).toBe(false)
    const steepApproach = (p: { x: number }) => p.x < 0 ? 70 : p.x > 20 && p.x < 180 ? 0 : 100
    expect(surveyedRoadGradeAllowed(route, .10, steepApproach)).toBe(false)
  })
})
