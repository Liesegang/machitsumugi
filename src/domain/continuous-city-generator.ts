import type { Area, Building, CityConfig, CityMap, FacilityKind, Road, TimelineVersion } from './types'
import type { LayoutFirstZone } from './layout-first-types'
import { boundsOf, corridorPolygon, distance } from './geometry'
import type { PolygonRegion } from './geometry'
import { createTerrainModel } from './terrain'
import type { GenerationTerrainSource } from './generation-terrain-cache'
import { resolveGenerationConfig } from './generation-config'
import { terrainGenerationPreview } from './generator'
import { CONTINUOUS_GENERATOR_VERSION } from './continuous-city-types'
import { planContinuousCityDemand } from './continuous-city-demand'
import { surveyContinuousCityTrunks, buildContinuousCityRoads } from './continuous-city-roads'
import { developContinuousCityLand } from './continuous-city-land'
import { buildContinuousCityLandDomains } from './continuous-city-land-domains'
import { buildContinuousCityCover } from './continuous-city-cover'
import { buildContinuousCoverHistory, continuousRoadAcquisitions } from './continuous-city-cover-history'
import { planContinuousCityRuralAccess } from './continuous-city-rural'
// Engineering components remain shared. They do not design the urban fabric.
import { reserveLayoutFirstCivics } from './layout-first-civic'
import { surveyLayoutFirstRail } from './layout-first-rail'
import { certifyLayoutAccess } from './layout-first-access'
import { buildLayoutFirstDistricts } from './layout-first-districts'
import { materializeRoadJunctions, projectOnRoadSegment } from './road-graph'
import { createCityTimeline, sliceCityAtYear } from './timeline'
import { buildingServiceYears } from './building-lifecycle'
import { shoppingStreetHistory } from './commercial-history'
import { regionQuery } from './region-query'
import { planSubway } from './subway'

const reports=new WeakMap<CityMap,Record<string,unknown>>()
export const continuousCityGenerationReport=(map:CityMap)=>reports.get(map)
const facilityYears:Record<FacilityKind,number>={castle:1650,shrine:1650,onsen:1650,shop:1700,school:1875,police:1880,hospital:1920,port:1920,park:1955,university:1965}

/** Institutions can survive; individual ordinary buildings cannot. */
function renewCivics(buildings:Building[],seed:string):TimelineVersion<Building>[] {
  return buildings.flatMap(building=>{
    const initial=building.builtYear??1650
    if(building.id.startsWith('castle-'))return [{from:initial,value:building}]
    const versions:TimelineVersion<Building>[]=[]
    for(let from=initial,generation=0;from<=2025;generation++){
      const value={...building,id:generation?`${building.id}-frame-${from}`:building.id,builtYear:from,height:from<1900?Math.min(2,building.height):building.height}
      const next=from+buildingServiceYears(seed,value)
      versions.push({from,...(next<=2025?{to:next}:{}),value});from=next
    }
    return versions
  })
}

/** Fresh final-form algorithm: a continuous land market → shared street fabric
 * → complete block cadastre → simple, contained building footprints.
 * It never consumes a previous city's roads, parcels, buildings or zones. */
export function generateContinuousCity(input:CityConfig,onProgress?:(label:string)=>void,onPreview?:(map:CityMap)=>void,terrainSource:GenerationTerrainSource=createTerrainModel,observer?:{coverGeometry?:(stage:string,parts:readonly PolygonRegion[])=>void}):CityMap {
  const start=performance.now(),resolved=resolveGenerationConfig(input),requestedYear=resolved.year
  const phases:{phase:string;milliseconds:number}[]=[]
  let lastPhase='地形の読込',lastStarted=start
  const phase=(label:string)=>{const now=performance.now();phases.push({phase:lastPhase,milliseconds:now-lastStarted});lastPhase=label;lastStarted=now;onProgress?.(label)}
  const config:CityConfig={...resolved.config,cityEngine:'continuous',targetYear:2025}
  const {width,height}=resolved
  const terrain=terrainSource({...resolved.terrainInput,onTerrainPreview:terrainGenerationPreview(config,onProgress,onPreview)})
  const world=terrain.hydrology,cellSize=25,columns=width/cellSize+1,rows=height/cellSize+1,elevations:number[]=[]
  for(let y=0;y<rows;y++)for(let x=0;x<columns;x++)elevations.push(Math.round(terrain.elevation({x:x*cellSize,y:y*cellSize})*100)/100)
  const terrainSurface={cellSize,columns,rows,elevations}
  const stride=3,regionalElevations:number[]=[]
  for(let y=0;y<world.rows;y+=stride)for(let x=0;x<world.columns;x+=stride)regionalElevations.push(world.rawDEM[y*world.columns+x]!)
  const {worldAnchor,localAnchor,angle,mirrored}=world.frame,c=Math.cos(angle),s=Math.sin(angle),mirror=mirrored?-1:1
  const crop=[{x:0,y:0},{x:width,y:0},{x:width,y:height},{x:0,y:height}].map(p=>{const dx=(p.x-localAnchor.x)*mirror,dy=p.y-localAnchor.y;return {x:worldAnchor.x+c*dx-s*dy,y:worldAnchor.y+s*dx+c*dy}})
  const regionalContext={surface:{columns:Math.floor((world.columns-1)/stride)+1,rows:Math.floor((world.rows-1)/stride)+1,cellSize:world.resolution*stride,elevations:regionalElevations},extent:world.extent,crop}
  const natural=terrain.areas.map(area=>({...area,...(area.id==='river'?{name:config.name.replace(/[市町村]$/,'')+'川'}:{})}))
  const frame=(partial:Partial<CityMap>,previewPhase:CityMap['previewPhase']):CityMap=>({width,height,config,generatorVersion:CONTINUOUS_GENERATOR_VERSION,year:2025,terrainSurface,regionalContext,roads:[],buildings:[],areas:natural,railways:[],stations:[],facilities:[],districts:[],description:'連続した市街地から設計',...partial,previewPhase})
  onPreview?.(frame({},'hydrology'))
  phase('平地の連続性と、市街地・農村の範囲を設計中…')
  const demand=planContinuousCityDemand({config,width,height,terrain})
  // Compatibility briefs are solely site-search input for the shared campus
  // and rail engineers. No radius or polygon here generates streets or titles.
  const zones:LayoutFirstZone[]=demand.regions.map((region,i)=>{const b=boundsOf(region.polygon);return {...region,id:`continuous-site-context-${i}`,center:demand.center,radius:Math.hypot(b.maxX-b.minX,b.maxY-b.minY)/2,kind:'historic',builtYear:1650,density:1,maximumFloors:8}})
  phase('公共施設の敷地と入口を確保中…')
  const civic=reserveLayoutFirstCivics({config,width,height,terrain,center:demand.center,zones})
  const planningAreas=[...natural.filter(a=>a.kind==='water'),...civic.areas]
  const reservedAt=regionQuery(civic.reserves)
  const roadInput={config,center:demand.center,demand,reservedRegions:civic.reserves,railways:[],environment:{width,height,core:null,areas:planningAreas,terrain,bridgeSites:terrain.bridgeSites,exactLandCost:true,landCost:(p:{x:number;y:number})=>reservedAt(p)?Infinity:0},onProgress:phase}
  phase('外へ続く主要道路を、距離と大きな線形から設計中…')
  const trunks=surveyContinuousCityTrunks(roadInput)
  onPreview?.(frame({roads:trunks.roads,areas:[...natural,...civic.areas],buildings:civic.buildings,facilities:civic.facilities,previewPlanning:{reservedGrounds:civic.reserves}},'roads'))
  phase('主要道路と交差位置を調整し、鉄道と駅を配置中…')
  const rail=surveyLayoutFirstRail({config,width,height,terrain,center:demand.center,zones,reserves:civic.reserves,roads:trunks.roads})
  if(config.railway&&(!rail.railways.length||rail.stations.length<config.stations))throw new Error('指定した本線と駅の敷地を確保できませんでした。',{cause:rail.diagnostics})
  const reserves=[...civic.reserves,...rail.stationGrounds]
  const reserveQuery=regionQuery(reserves)
  const environment={...roadInput.environment,areas:[...planningAreas,...rail.stationGrounds],landCost:(p:{x:number;y:number})=>reserveQuery(p)?Infinity:0}
  const targets=[...civic.accessTargets,...rail.accessTargets]
  phase('連続した街路網を作り、街区の奥まで生活道路を通しています…')
  const transport=buildContinuousCityRoads({...roadInput,environment,reservedRegions:reserves,railways:rail.railways,initialRoads:[...trunks.roads,...civic.roads,...rail.stationPaths],accessTargets:targets})
  let roads=materializeRoadJunctions(transport.roads)
  phase('市街地の外に続く農道を、既存の道路から整備中…')
  const rural=planContinuousCityRuralAccess({config,width,height,terrain,demand,roads,railways:rail.railways,reserves})
  if(rural.roads.length)roads=materializeRoadJunctions([...roads,...rural.roads])
  const access=certifyLayoutAccess({width,height,roads,targets})
  if(access.unserved.length)throw new Error('施設・駅の入口を、開設時の外部道路へ接続できませんでした。',{cause:{access,transport:transport.diagnostics}})
  onPreview?.(frame({roads,railways:rail.railways,stations:rail.stations,areas:[...natural,...civic.areas,...rail.stationGrounds],buildings:civic.buildings,facilities:civic.facilities,previewPlanning:{reservedGrounds:reserves}},'roads'))
  const railMasks=rail.railways.filter(line=>line.mode!=='subway').flatMap(line=>line.points.slice(1).flatMap((b,i)=>distance(line.points[i]!,b)>.01?[{polygon:corridorPolygon(line.points[i]!,b,7)}]:[]))
  const centreGateId=({castle:'facility-access-castle',temple:'facility-access-shrine',onsen:'facility-access-onsen',port:'facility-access-port',post:'',newtown:''} as const)[config.type]
  const centreGate=civic.accessTargets.find(target=>target.id===centreGateId&&target.builtYear<=1850)
  // The old centre's approach is intentionally on an acquired public road.
  // It does not assert a pedestrian shortcut from an inaccessible castle core.
  const oldApproach=trunks.roads.filter(road=>(road.builtYear??1650)<=1850&&!road.controlledAccess).flatMap(road=>road.points.slice(1).map((b,i)=>({point:projectOnRoadSegment(demand.center,road.points[i]!,b).point,builtYear:road.builtYear??1650}))).sort((a,b)=>distance(a.point,demand.center)-distance(b.point,demand.center))[0]
  const centerAccess=centreGate?{point:centreGate.point,builtYear:centreGate.builtYear}:oldApproach
  phase('街区全体を接道する敷地へ分け、建物と中庭を配置中…')
  // Closed street faces describe the public network. Acquisition can also
  // follow a real road on its unclosed outer side; this ownership complement
  // creates no street or frontage along the demand boundary.
  const landDomains=buildContinuousCityLandDomains({demandRegions:demand.regions,streetBlocks:transport.blocks})
  const land=developContinuousCityLand({config,width,height,roads,blocks:landDomains.domains,demand,stations:rail.stations,centerAccess,reserves:[...reserves,...railMasks],terrain})
  roads=materializeRoadJunctions([...roads,...land.accessRoads])
  phase('まとまった農地・林・公園を割り当て中…')
  const coverTerrain={...terrain,areas:natural}
  const cover=buildContinuousCityCover({config,width,height,terrain:coverTerrain,demand,roads,parcels:land.parcels,reserves:[...reserves,...railMasks,...land.openSpaces],urbanBlocks:transport.blocks,onProgress:phase,onGeometry:observer?.coverGeometry})
  phase('建物の更新履歴と商店街を記録中…')
  const civicHistory=renewCivics(civic.buildings,config.seed)
  const buildings=[...land.buildings,...civicHistory.filter(v=>v.to===undefined).map(v=>v.value)]
  const roadHistory:TimelineVersion<Road>[]=roads.map(value=>({from:value.builtYear??1955,value}))
  const shopHistory=config.facilities.includes('shop')?shoppingStreetHistory({buildings:land.history.buildings,parcels:land.history.parcels,roads:roadHistory,name:'中央商店街',throughYear:2025}):[]
  const facilities=[...civic.facilities,...shopHistory.filter(v=>v.to===undefined).map(v=>v.value)]
  const missing=config.facilities.filter(kind=>!facilities.some(f=>f.kind===kind))
  if(missing.length)throw new Error('指定された施設の用地と接道を確保できませんでした。',{cause:{missing,unplaced:civic.unplacedFacilities}})
  const areas:Area[]=[...cover,...land.openSpaces,...civic.areas,...rail.stationGrounds]
  phase('市街地と駅のつながりから地下鉄を検討中…')
  const subway=planSubway({config,throughYear:2025,roads:roadHistory,buildings:land.history.buildings,stations:rail.stations,terrain})
  const railways=[...rail.railways,...(subway?[subway.railway]:[])],stations=[...rail.stations,...(subway?.stations??[])]
  phase('町域と、道路・建物の年代を記録中…')
  const districts=buildLayoutFirstDistricts({config,width,height,roads,blocks:transport.blocks,parcels:land.parcels,areas,stations,facilities})
  const map:CityMap={width,height,config,generatorVersion:CONTINUOUS_GENERATOR_VERSION,year:2025,roads,buildings,parcels:land.parcels,blocks:transport.blocks,areas,railways,stations,facilities,districts,events:land.events,terrainSurface,regionalContext,description:'連続した地盤と交通から街路網を設計し、街区全体を敷地へ割り当てた地図。',terrainSimulation:{resolution:world.resolution,steps:world.erosion.iterations,elapsedYears:world.erosion.elapsedYears,bedrockErodedVolume:world.sediment.erodedSourceVolume,storedSedimentVolume:world.sediment.storedVolume,exportedSedimentVolume:world.sediment.exportedVolume,sedimentBalanceError:world.sediment.massBalanceError,groundBalanceError:world.erosion.terrainBalanceError,localExcavationVolume:world.bankSediment?.totalExcavationVolume??0,localDepositionVolume:world.bankSediment?.depositedVolume??0,localExportedVolume:world.bankSediment?.totalExportedVolume??0,localBalanceError:world.bankSediment?.totalMassBalanceError??0}}
  phase('昔の農地・森林の配置を記録中…')
  const openingOfArea=(area:Area)=>facilityYears[(Object.keys(facilityYears) as FacilityKind[]).find(kind=>area.id.includes(kind))??'park']
  const reserveDates=civic.reserves.map(region=>({region,from:openingOfArea(civic.areas.find(area=>area.polygon===region.polygon)??{id:'castle-ground',kind:'field',polygon:region.polygon})}))
  const baseCover=buildContinuousCityCover({config,width,height,terrain:coverTerrain,demand:{...demand,regions:[],at:()=>0},roads:roads.filter(road=>(road.builtYear??1650)<=1650),parcels:[],reserves:reserveDates.filter(v=>v.from<=1650).map(v=>v.region),urbanBlocks:[],onProgress:phase,onGeometry:observer?.coverGeometry})
  phase('土地の取得履歴を整理中…')
  const acquisitions=[...reserveDates,...railMasks.map(region=>({region,from:1900})),...rail.stationGrounds.map(region=>({region,from:1900})),...land.parcels.map(region=>({region,from:region.createdYear})),...land.openSpaces.map(region=>({region,from:1955})),...continuousRoadAcquisitions(roads)]
  const coverHistory=buildContinuousCoverHistory({width,height,baseCover,finalCover:cover,acquisitions})
  phase('年代別の地図を記録中…')
  map.timeline=createCityTimeline(map,{roads:roadHistory,buildings:[...land.history.buildings,...civicHistory],parcels:land.history.parcels,buildingStates:land.history.buildingStates,facilities:[...civic.facilities.map(value=>({from:facilityYears[value.kind],value})),...shopHistory],areas:[...coverHistory,...land.openSpaces.map(value=>({from:1955,value})),...civic.areas.map(value=>({from:openingOfArea(value),value})),...rail.stationGrounds.map(value=>({from:1900,value}))]})
  const result=sliceCityAtYear(map,requestedYear)
  phases.push({phase:lastPhase,milliseconds:performance.now()-lastStarted})
  reports.set(result,{input:'configuration-and-terrain-only',phases,inheritedRoads:0,inheritedParcels:0,inheritedBuildings:0,demand:{...demand.metrics,center:demand.center},centerAccess,reservedGrounds:reserves,trunks:trunks.diagnostics,transport:transport.diagnostics,rural:rural.diagnostics,landDomains:landDomains.metrics,land:land.metrics,access,rail:rail.diagnostics,milliseconds:performance.now()-start})
  onPreview?.(frame(map,'development'))
  return result
}
