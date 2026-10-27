import type { Road } from './types'
import type { ContinuousCityRoadInput } from './continuous-city-types'
import { controlledRoad, materializeRoadJunctions } from './road-graph'
import { certifyLayoutAccess } from './layout-first-access'

/** The first vertex of a continuous, already-open road witnesses its whole
 * dated component. A nearby private/farm spur or future road is no witness. */
export function datedExternalPublicRoadIds(input: { width: number; height: number; roads: readonly Road[] }, year: number): Set<string> {
  const roads=input.roads.filter(road=>!controlledRoad(road)&&road.role!=='farm'&&(road.level??0)===0)
  const candidates=roads.filter(road=>(road.builtYear??1650)<=year&&road.points.length>1)
  const certification=certifyLayoutAccess({...input,roads,targets:candidates.map(road=>({id:road.id,point:road.points[0]!,builtYear:year}))})
  const unserved=new Set(certification.unserved)
  return new Set(candidates.filter(road=>!unserved.has(road.id)).map(road=>road.id))
}

interface AccessSurveyResult {
  roads: Road[]
  diagnostics: { accessAttempts: { id: string; found: boolean }[]; unservedAccessIds: string[]; accessConnections?: {id:string;roadId:string}[] }
}
export interface ContinuousAccessRepairDiagnostics {
  initiallyUnserved: string[]
  repaired: string[]
  remaining: { id: string; reason: 'no-dated-external-component' | 'physical-route-not-found' }[]
  routeAttempts: number
  addedRoads: number
  connections: {id:string;roadId:string}[]
}

/** One bounded engineering retry before any household ground is allocated.
 * The supplied production survey retains its width/water/rail/grade checks;
 * neither this coordinator nor a repair can backdate an existing street. */
export function repairContinuousCityAccess(input: ContinuousCityRoadInput, survey: (input: ContinuousCityRoadInput, recovery?: boolean) => AccessSurveyResult) {
  let roads=materializeRoadJunctions(input.initialRoads??[])
  const targets=input.accessTargets??[],before=certifyLayoutAccess({width:input.environment.width,height:input.environment.height,roads,targets})
  const diagnostics:ContinuousAccessRepairDiagnostics={initiallyUnserved:before.unserved,repaired:[],remaining:[],routeAttempts:0,addedRoads:0,connections:[]}
  if(before.unserved.length){
    const failed=new Set(before.unserved),oldIds=new Set(roads.map(road=>road.id))
    const result=survey({...input,initialRoads:roads,accessTargets:targets.filter(target=>failed.has(target.id)).slice().sort((a,b)=>a.builtYear-b.builtYear||a.id.localeCompare(b.id))},true)
    roads=materializeRoadJunctions(result.roads)
    diagnostics.routeAttempts=result.diagnostics.accessAttempts.length
    diagnostics.connections=result.diagnostics.accessConnections??[]
    diagnostics.addedRoads=roads.filter(road=>!oldIds.has(road.id)).length
  }
  const access=certifyLayoutAccess({width:input.environment.width,height:input.environment.height,roads,targets}),failed=new Set(access.unserved)
  diagnostics.repaired=before.unserved.filter(id=>!failed.has(id))
  diagnostics.remaining=targets.filter(target=>failed.has(target.id)).map(target=>({id:target.id,reason:datedExternalPublicRoadIds({width:input.environment.width,height:input.environment.height,roads},target.builtYear).size?'physical-route-not-found':'no-dated-external-component'}))
  return {roads,access,diagnostics}
}
