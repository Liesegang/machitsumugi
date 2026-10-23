import { describe, expect, it } from 'vitest'
import { clipWaterRegion } from './terrain-water'
describe('one physical water polygon shared by cropped and continued maps', () => {
  it('preserves an island when its surrounding sea is clipped to the viewport', () => {
    const polygon = [{ x: -100, y: -100 }, { x: 1100, y: -100 }, { x: 1100, y: 1100 }, { x: -100, y: 1100 }]
    const island = [{ x: 300, y: 300 }, { x: 700, y: 300 }, { x: 700, y: 700 }, { x: 300, y: 700 }]
    const parts = clipWaterRegion({ polygon, holes: [island] }, 1000, 1000)
    expect(parts).toHaveLength(1)
    expect(parts[0]!.holes).toHaveLength(1)
    expect(parts[0]!.polygon.every(p => p.x >= 0 && p.x <= 1000 && p.y >= 0 && p.y <= 1000)).toBe(true)
  })
  it('keeps separated in-viewport waters instead of joining them along the crop edge', () => {
    const polygon = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 1100 }, { x: 700, y: 1100 }, { x: 700, y: 100 }, { x: 900, y: 100 }, { x: 900, y: 1300 }, { x: 100, y: 1300 }]
    expect(clipWaterRegion({ polygon }, 1000, 1000)).toHaveLength(2)
  })
  it('returns exact crop-edge bounds when intersection rounding retains an exterior source coordinate', () => {
    const polygon = [{ x: 3900, y: -10 }, { x: 4000.0000000000005, y: -10 }, { x: 4000.0000000000005, y: 3010 }, { x: 3900, y: 3010 }]
    const parts = clipWaterRegion({ polygon }, 4000, 3000)
    expect(parts).toHaveLength(1)
    expect(parts[0]!.polygon).toEqual([{ x: 3900, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 3900, y: 3000 }])
  })
})
