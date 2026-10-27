import { describe, expect, it } from 'vitest'
import { shoppingStreetHistory } from './commercial-history'
import { rectangle } from './geometry'
import type { Building, Road, TimelineVersion } from './types'

const surveyedStreet = (locations: number[], road: Road) => shoppingStreetHistory({
  buildings:locations.map((x,i)=>({from:1975,value:{id:`shop-${i}`,parcelId:`p-${i}`,builtYear:1975,polygon:rectangle(x-6,20,12,18),kind:'commercial',height:2}})),
  parcels:locations.map((x,i)=>({from:1975,value:{id:`p-${i}`,roadId:road.id,createdYear:1975,polygon:rectangle(x-9,15,18,30),entrance:{x,y:50},use:'commercial'}})),
  roads:[{from:1975,value:road}],name:'商店街',throughYear:2025,
})
const longSurveyedRoad:Road={id:'long-main',points:[{x:0,y:50},{x:400,y:50},{x:500,y:50},{x:1000,y:50}],width:8,kind:'arterial',role:'collector',bridge:true,surveyedBridgeSpans:[{bankA:{x:400,y:50},bankB:{x:500,y:50}}]}

describe('historical shopping street', () => {
  it('appears only after three real frontages open and disappears when one is acquired', () => {
    const buildings: TimelineVersion<Building>[] = [1700, 1750, 1800].map((from, i) => ({ from, ...(i === 0 ? { to: 1955 } : {}), value: { id: `shop-${i}`, parcelId: `p-${i}`, builtYear: from, polygon: rectangle(100 + i * 30, 20, 20, 20), kind: 'commercial', height: 2 } }))
    const history = shoppingStreetHistory({ buildings,
      parcels: [0, 1, 2].map(i => ({ from: 1700, value: { id: `p-${i}`, roadId: 'street', createdYear: 1700, polygon: rectangle(100 + i * 30, 10, 25, 35), entrance: { x: 100 + i * 30, y: 50 }, use: 'commercial' } })),
      roads: [{ from: 1700, value: { id: 'street', points: [{ x: 0, y: 50 }, { x: 500, y: 50 }], width: 6, kind: 'local' } }], name: '商店街', throughYear: 2025,
    })
    expect(history).toHaveLength(1)
    expect(history[0]!.from).toBe(1800)
    expect(history[0]!.to).toBe(1955)
  })

  it('retains three dry shop frontages and a dry label on the approach of a long road containing a surveyed bridge', () => {
    const history=surveyedStreet([80,110,145],longSurveyedRoad)
    expect(history).toHaveLength(1)
    expect(history[0]!.value.point.y).toBe(50)
    expect(history[0]!.value.point.x).toBeLessThan(400)
    expect(history[0]!.from).toBe(1975)
    expect(history[0]!.to).toBeUndefined()
  })

  it('does not count frontage on a surveyed span even when three buildings are present', () => {
    expect(surveyedStreet([410,450,490],longSurveyedRoad)).toEqual([])
    // Two dry shops cannot use a third shop on the deck to meet the threshold.
    expect(surveyedStreet([330,360,410],longSurveyedRoad)).toEqual([])
  })

  it('still excludes short unsurveyed bridges and bridge surveys which do not identify a valid part of the road', () => {
    expect(surveyedStreet([30,60,90],{...longSurveyedRoad,points:[{x:0,y:50},{x:150,y:50}],surveyedBridgeSpans:undefined})).toEqual([])
    expect(surveyedStreet([80,110,145],{...longSurveyedRoad,surveyedBridgeSpans:[{bankA:{x:400,y:150},bankB:{x:500,y:150}}]})).toEqual([])
  })

  it.each(['ramp','expressway','farm'] as const)('does not convert dry %s approaches into a shopping street', role => {
    expect(surveyedStreet([80,110,145],{...longSurveyedRoad,role})).toEqual([])
  })

  it('keeps controlled access excluded on the dry approach of a surveyed bridge', () => {
    expect(surveyedStreet([80,110,145],{...longSurveyedRoad,controlledAccess:true})).toEqual([])
  })
})
