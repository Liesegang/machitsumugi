import {beforeAll,describe,expect,it} from 'vitest'
import {appendFileSync,writeFileSync} from 'node:fs'
import type {CityConfig,CityMap,Point} from './types'
import type {TerrainModel,TerrainModelInput} from './terrain'
import {generateContinuousCity,continuousCityGenerationReport} from './continuous-city-generator'
import {CONTINUOUS_GENERATOR_VERSION} from './continuous-city-types'
import {sliceCityAtYear} from './timeline'
import {parseProject} from './project'
import {polygonArea,polygonOverlapsRegion,rectangle} from './geometry'
import {certifyLayoutAccess} from './layout-first-access'
import {materializeRoadJunctions} from './road-graph'

function plain(input:TerrainModelInput):TerrainModel{
  const elevation=()=>20,slope=()=>0,waterAt=()=>false
  const rawDEM=new Float32Array(100).fill(20)
  const hydrology={extent:9000,columns:10,rows:10,resolution:1000,rawDEM,erosion:{iterations:0,elapsedYears:0,terrainBalanceError:0},sediment:{erodedSourceVolume:0,storedVolume:0,exportedVolume:0,massBalanceError:0},frame:{worldAnchor:{x:0,y:0},localAnchor:{x:0,y:0},angle:0,mirrored:false}} as unknown as TerrainModel['hydrology']
  return {areas:[],elevation,slope,waterAt,cityOrigin:{x:input.width/2,y:input.height/2},bridgeSites:[],bridgeCandidates:[],rivers:[],channelAt:()=>null,wetness:()=>.05,terrainCost:()=>1,cultivable:()=>true,bankDistance:()=>Infinity,landform:()=> 'terrace',hydrology,continuationTerrain:{bounds:{minX:-500,minY:-500,maxX:input.width+500,maxY:input.height+500},contains:(p:Point)=>p.x>=-500&&p.y>=-500&&p.x<=input.width+500&&p.y<=input.height+500,elevation,slope,waterAt,seaAt:waterAt}}
}
const config:CityConfig={name:'連続市',seed:'continuous-plain-integration',type:'newtown',terrain:'plain',density:100,forest:0,railway:false,stations:1,arterial:true,facilities:[],settlement:'metropolis',targetYear:2025,mapSize:'small',cityEngine:'continuous'}
let map:CityMap,calls=0
beforeAll(()=>{
  const file=process.env.CONTINUOUS_TIMING_FILE
  const progress=(phase:string)=>{if(file)appendFileSync(file,JSON.stringify({time:Date.now(),phase})+'\n')}
  const capture=process.env.CONTINUOUS_COVER_CAPTURE
  let captured=false
  map=generateContinuousCity(config,progress,undefined,input=>{calls++;return plain(input)},{coverGeometry:(stage,parts)=>{if(capture&&stage==='urban'&&!captured){writeFileSync(capture,JSON.stringify(parts));captured=true}}})
  if(file)appendFileSync(file,JSON.stringify({time:Date.now(),phase:'complete',timings:continuousCityGenerationReport(map)?.phases})+'\n')
},60000)
describe('continuous city production composition',()=>{
  it('constructs the whole city from a single terrain checkout without inheriting an old city',()=>{
    expect(calls).toBe(1);expect(map.config.cityEngine).toBe('continuous');expect(map.generatorVersion).toBe(CONTINUOUS_GENERATOR_VERSION)
    expect(continuousCityGenerationReport(map)).toMatchObject({input:'configuration-and-terrain-only',inheritedRoads:0,inheritedParcels:0,inheritedBuildings:0})
    expect(map.buildings.length).toBeGreaterThan(3000)
  })
  it('develops a broad continuous lowland, rather than a few isolated neighbourhood islands',()=>{
    const acquired=(map.parcels??[]).reduce((n,p)=>n+polygonArea(p.polygon),0)
    expect(acquired).toBeGreaterThan(map.width*map.height*.30)
    const tested=rectangle(1000,900,2000,1200)
    expect(map.buildings.filter(b=>polygonOverlapsRegion(b.polygon,{polygon:tested})).length).toBeGreaterThan(1000)
    const selected=(map.parcels??[]).filter((_,i)=>i%Math.max(1,Math.floor(map.parcels!.length/30))===0)
    const targets=selected.map(p=>({id:p.id,point:p.access?.[0]??p.entrance,builtYear:p.createdYear}))
    expect(targets.length).toBeGreaterThan(20)
    // Split the saved pavement at the actual private access contacts; a title
    // may attach in the middle of a public segment, not only at a junction.
    const auditAccess=selected.map(p=>({id:'audit-'+p.id,points:p.access!,kind:'local' as const,width:2.5,role:'access' as const,builtYear:p.createdYear}))
    const auditedRoads=materializeRoadJunctions([...map.roads,...auditAccess])
    expect(certifyLayoutAccess({width:map.width,height:map.height,roads:auditedRoads,targets}).unserved).toEqual([])
  })
  it('preserves dated physical geometry on portable round-trip and timeline selection',()=>{
    const project={version:2,config:map.config,annotations:[],layers:{buildings:true,roads:true,railway:true,labels:true,facilities:true,terrain:true,grid:false,districts:false},style:'standard',snapshot:map}
    const restored=parseProject(JSON.stringify(project)).snapshot!
    for(const year of [1850,1900,2025]){
      const a=sliceCityAtYear(map,year),b=sliceCityAtYear(restored,year)
      expect(b.roads).toEqual(a.roads);expect(b.buildings).toEqual(a.buildings);expect(b.parcels).toEqual(a.parcels)
    }
  })
})
