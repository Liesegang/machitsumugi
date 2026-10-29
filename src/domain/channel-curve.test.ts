import { describe, expect, it } from 'vitest'
import { channelCurve, fairChannelControls } from './channel-curve'
import { distanceToSegment } from './geometry'

describe('adaptive river centreline curves', () => {
  it('reduces a short grid kink within the bank corridor without moving confluences or climbing a resistant valley',()=>{
    const path=[{x:0,y:0},{x:80,y:0},{x:100,y:14},{x:120,y:0},{x:200,y:0}],before=structuredClone(path)
    const fair=fairChannelControls(path,new Set([1]),()=>6)
    expect(fair[1]).toEqual(path[1]);expect(fair[0]).toEqual(path[0]);expect(fair.at(-1)).toEqual(path.at(-1))
    expect(fair[2]!.y).toBeLessThan(path[2]!.y)
    for(let i=0;i<path.length;i++)expect(Math.hypot(fair[i]!.x-path[i]!.x,fair[i]!.y-path[i]!.y)).toBeLessThanOrEqual(6.000001)
    expect(fairChannelControls(path,new Set(),()=>6,()=>false)).toEqual(path)
    expect(path).toEqual(before)
  })
  it('retains confluence knots while resolving a short Z bend to sub-metre error', () => {
    const knots = [{x:0,y:0},{x:100,y:0},{x:115,y:20},{x:150,y:20},{x:250,y:50}], before = structuredClone(knots)
    const actual = channelCurve(knots), reference = channelCurve(knots, .9, .001)
    for (const knot of knots) expect(actual).toContainEqual(knot)
    for (const point of reference) expect(Math.min(...actual.slice(1).map((b,i)=>distanceToSegment(point,actual[i]!,b)))).toBeLessThanOrEqual(.151)
    expect(actual.length).toBeGreaterThan(knots.length * 2)
    expect(knots).toEqual(before)
  })
  it('keeps a straight stream straight without inflating its sampling cost', () => {
    const knots = [{x:0,y:0},{x:1000,y:0},{x:2000,y:0}]
    const result=channelCurve(knots)
    expect(result).toHaveLength(101)
    for(const knot of knots)expect(result).toContainEqual(knot)
    for(let i=1;i<result.length;i++){expect(result[i]!.y).toBe(0);expect(result[i]!.x-result[i-1]!.x).toBeLessThanOrEqual(20)}
    expect(channelCurve([])).toEqual([])
  })
})
