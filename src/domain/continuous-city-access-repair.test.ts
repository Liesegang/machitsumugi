import { describe, expect, it } from 'vitest'
import { datedExternalPublicRoadIds, repairContinuousCityAccess } from './continuous-city-access-repair'
import { surveyContinuousCityAccess } from './continuous-city-roads'
import { certifyLayoutAccess } from './layout-first-access'
import { pointInPolygon, polygonOverlapsRegion, rectangle } from './geometry'
import type { ContinuousCityRoadInput } from './continuous-city-types'
import type { Road } from './types'

function fixture():ContinuousCityRoadInput {
  const water={id:'uncrossable',kind:'water' as const,polygon:rectangle(-10,215,520,20)},config={name:'接道復旧市',seed:'dated-access-repair',type:'post' as const,terrain:'plain' as const,density:65,forest:0,railway:false,stations:1,arterial:true,facilities:[]}
  const roads:Road[]=[{id:'near-old-root',points:[{x:-40,y:200},{x:260,y:200},{x:540,y:200}],width:8,kind:'arterial',role:'collector',builtYear:1650,boundaryContinuation:true},{id:'far-old-root',points:[{x:-40,y:380},{x:260,y:380},{x:540,y:380}],width:8,kind:'arterial',role:'collector',builtYear:1650,boundaryContinuation:true},{id:'isolated-door',points:[{x:230,y:250},{x:260,y:250},{x:290,y:250}],width:5,kind:'local',role:'access',builtYear:1875}]
  return {config,center:{x:250,y:300},initialRoads:roads,reservedRegions:[],railways:[],accessTargets:[{id:'school',point:{x:260,y:250},builtYear:1875}],environment:{width:500,height:400,core:null,areas:[water],bridgeSites:[],terrain:{elevation:()=>10,slope:()=>0,waterAt:p=>pointInPolygon(p,water.polygon),bridgeSites:[],bridgeCandidates:[]}},demand:{center:{x:250,y:300},regions:[{polygon:rectangle(0,0,500,400)}],at:()=>.65,costAt:()=>1,openingAt:()=>1955,metrics:{cellSize:25,reachableLandArea:200000,targetUrbanArea:130000,selectedUrbanArea:130000}}}
}

describe('automatic continuous city opening-date access repair',()=>{
  it('ignores the isolated door street and retries a real farther same-era external road when the nearest route is blocked',()=>{
    const input=fixture(),original=JSON.stringify(input.initialRoads)
    expect(datedExternalPublicRoadIds({width:500,height:400,roads:input.initialRoads!},1875)).toEqual(new Set(['near-old-root','far-old-root']))
    const result=repairContinuousCityAccess(input,surveyContinuousCityAccess)
    expect(result.diagnostics.initiallyUnserved).toEqual(['school'])
    expect(result.diagnostics.repaired).toEqual(['school'])
    expect(result.diagnostics.routeAttempts).toBeGreaterThan(1)
    expect(result.diagnostics.remaining).toEqual([])
    expect(result.access.unserved).toEqual([])
    expect(result.roads.some(road=>road.role==='access'&&road.id!=='isolated-door'&&road.builtYear===1875)).toBe(true)
    expect(JSON.stringify(input.initialRoads)).toBe(original)
    for(const road of result.roads.filter(road=>!input.initialRoads!.some(old=>old.id===road.id)))expect(road.points.every(point=>!input.environment.terrain!.waterAt(point))).toBe(true)
  })

  it('does not borrow a future external road or invent a crossing through the blocking water',()=>{
    const input=fixture();input.initialRoads=input.initialRoads!.map(road=>road.id==='far-old-root'?{...road,builtYear:1995}:road)
    const result=repairContinuousCityAccess(input,surveyContinuousCityAccess)
    expect(result.access.unserved).toEqual(['school'])
    expect(result.roads.find(road=>road.id==='far-old-root')!.builtYear).toBe(1995)
    expect(result.diagnostics.addedRoads).toBe(0)
    expect(result.diagnostics.remaining).toEqual([{id:'school',reason:'physical-route-not-found'}])
  })

  it('keeps future-only and controlled external components unavailable at the facility opening',()=>{
    for(const blocked of ['future','controlled'] as const){
      const input=fixture();input.initialRoads=input.initialRoads!.map(road=>road.boundaryContinuation?blocked==='future'?{...road,builtYear:1995}:{...road,controlledAccess:true}:road)
      const result=repairContinuousCityAccess(input,surveyContinuousCityAccess)
      expect(result.access.unserved).toEqual(['school'])
      expect(result.diagnostics.routeAttempts).toBe(0)
      expect(result.diagnostics.remaining).toEqual([{id:'school',reason:'no-dated-external-component'}])
    }
  })

  it.each([.1,7,15.9])('acquires a real %sm entrance below the route planner minimum without moving the door or backdating streets',gap=>{
    const input=fixture();input.environment.areas=[];input.environment.terrain={...input.environment.terrain!,waterAt:()=>false};input.initialRoads=[input.initialRoads![0]!];input.accessTargets=[{id:'short-door',point:{x:260,y:200+gap},builtYear:1875}]
    const result=repairContinuousCityAccess(input,surveyContinuousCityAccess)
    expect(result.access.unserved).toEqual([])
    const acquired=result.roads.find(road=>road.id!=='near-old-root')!
    expect(acquired.points.at(-1)).toEqual({x:260,y:200+gap})
    expect(acquired.builtYear).toBe(1875)
    expect(result.roads.find(road=>road.id==='near-old-root')!.builtYear).toBe(1650)
    expect(certifyLayoutAccess({width:500,height:400,roads:result.roads,targets:input.accessTargets!}).unserved).toEqual([])
  })

  it('does not use a short access to hide an intervening unformable grade',()=>{
    const input=fixture();input.environment.areas=[];input.initialRoads=[input.initialRoads![0]!];input.accessTargets=[{id:'steep-door',point:{x:260,y:207},builtYear:1875}]
    input.environment.terrain={...input.environment.terrain!,waterAt:()=>false,elevation:point=>point.y>203?20:10}
    const result=repairContinuousCityAccess(input,surveyContinuousCityAccess)
    expect(result.access.unserved).toEqual(['steep-door'])
    expect(result.diagnostics.addedRoads).toBe(0)
  })

  it('does not make a short entrance through protected railway land or a water shoulder',()=>{
    for(const kind of ['rail','water'] as const){
      const input=fixture(),barrier={polygon:rectangle(-10,202.8,520,1)}
      input.initialRoads=[input.initialRoads![0]!];input.accessTargets=[{id:'short-door',point:{x:260,y:207},builtYear:1920}]
      input.environment.areas=kind==='water'?[{...barrier,id:'thin-canal',kind:'water'}]:[]
      input.environment.terrain={...input.environment.terrain!,waterAt:p=>kind==='water'&&pointInPolygon(p,barrier.polygon)}
      input.reservedRegions=kind==='rail'?[barrier]:[]
      input.railways=kind==='rail'?[{id:'reserved-rail',name:'本線',points:[{x:-10,y:203.3},{x:510,y:203.3}],builtYear:1900}]:[]
      const result=repairContinuousCityAccess(input,surveyContinuousCityAccess)
      expect(result.access.unserved).toEqual(['short-door'])
      expect(result.diagnostics.addedRoads).toBe(0)
      expect(result.roads.every(road=>road.points.every(point=>!polygonOverlapsRegion(rectangle(point.x-.05,point.y-.05,.1,.1),barrier)))).toBe(true)
    }
  })
})
