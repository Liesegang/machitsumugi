import {describe,it,expect} from 'vitest'
import {planContinuousCityDemand} from './continuous-city-demand'
import type {CityConfig,Road} from './types'
import {pointInRegion,rectangle} from './geometry'
const config:CityConfig={name:'試験市',seed:'continuous',type:'castle',terrain:'plain',density:100,forest:0,railway:false,stations:1,arterial:true,facilities:[],settlement:'metropolis'}
const flat={cityOrigin:{x:1000,y:750},areas:[],waterAt:()=>false,slope:()=>0,elevation:()=>10}
describe('continuous urban demand',()=>{
  it('has continuous support between the centre and distant lowland, with no independent neighbourhood discs',()=>{
    const field=planContinuousCityDemand({config,width:2000,height:1500,terrain:flat})
    expect(field.metrics.selectedUrbanArea).toBeGreaterThan(2_500_000)
    for(let x=250;x<1750;x+=25)expect(field.at({x,y:field.center.y})).toBeGreaterThan(0)
    expect(field.at(field.center)).toBeGreaterThan(.95)
  })
  it('changes the developed footprint for a small settlement rather than randomly dropping central houses',()=>{
    const city=planContinuousCityDemand({config,width:2000,height:1500,terrain:flat})
    const village=planContinuousCityDemand({config:{...config,settlement:'village'},width:2000,height:1500,terrain:flat})
    expect(village.metrics.selectedUrbanArea).toBeLessThan(city.metrics.selectedUrbanArea*.1)
    expect(village.at(village.center)).toBeGreaterThan(.95)
  })
  it('lets demand cross an identified narrow river without conferring any physical crossing permission',()=>{
    const polygon=[{x:980,y:0},{x:1020,y:0},{x:1020,y:1500},{x:980,y:1500}]
    const terrain={...flat,areas:[{id:'river',kind:'water' as const,polygon}],waterAt:(p:{x:number})=>p.x>=980&&p.x<=1020,channelAt:(p:{x:number;y:number})=>({point:{x:1000,y:p.y},tangent:{x:0,y:1},bankDistance:0,width:40,surfaceElevation:5,riverId:'river'})}
    const field=planContinuousCityDemand({config,width:2000,height:1500,terrain})
    expect(field.at({x:700,y:750})).toBeGreaterThan(0);expect(field.at({x:1300,y:750})).toBeGreaterThan(0)
    expect(field.at({x:1000,y:750})).toBe(0)
  })
  it('cannot transmit development through sea or a lake',()=>{
    const polygon=[{x:800,y:0},{x:1200,y:0},{x:1200,y:1500},{x:800,y:1500}]
    const terrain={...flat,areas:[{id:'sea',kind:'water' as const,polygon}],waterAt:(p:{x:number})=>p.x>=800&&p.x<=1200}
    const field=planContinuousCityDemand({config,width:2000,height:1500,terrain})
    const other=field.center.x<1000?{x:1500,y:750}:{x:500,y:750}
    expect(field.costAt(other)).toBe(Infinity);expect(field.at(other)).toBe(0)
  })
  it('rejects a4m full-height sea strip between a40m link centre and midpoint, including interpolation on both banks',()=>{
    // Centres980/1020 and midpoint1000 are all dry. The exact edge crosses
    // water1008..1012, which no centre/midpoint-only survey can discover.
    const sea={id:'sea',kind:'water' as const,polygon:rectangle(1008,0,4,1600)}
    const terrain={...flat,areas:[sea],waterAt:(p:{x:number;y:number})=>pointInRegion(p,sea)}
    const field=planContinuousCityDemand({config,width:2000,height:1600,terrain})
    expect(field.metrics.cellSize).toBe(40)
    const left=field.center.x<1008,reachable={x:left?1007.5:1012.5,y:field.center.y},unreachable={x:left?1012.5:1007.5,y:field.center.y}
    expect(Number.isFinite(field.costAt(reachable))).toBe(true)
    expect(field.at(reachable)).toBeGreaterThan(0)
    expect(field.costAt(unreachable)).toBe(Infinity)
    expect(field.at(unreachable)).toBe(0)
    expect(field.costAt({x:left?1020:980,y:field.center.y})).toBe(Infinity)
    expect(field.costAt({x:1010,y:field.center.y})).toBe(Infinity)
    expect(field.at({x:1010,y:field.center.y})).toBe(0)
  })
  it('respects lake-hole shorelines and permits travel within the dry island',()=>{
    const lake={id:'lake',kind:'water' as const,polygon:rectangle(400,0,1200,1600),holes:[rectangle(650,350,700,900)]}
    const terrain={...flat,cityOrigin:{x:1000,y:800},areas:[lake],waterAt:(p:{x:number;y:number})=>pointInRegion(p,lake)}
    const field=planContinuousCityDemand({config,width:2000,height:1600,terrain})
    expect(pointInRegion(field.center,{polygon:lake.holes[0]!})).toBe(true)
    expect(Number.isFinite(field.costAt({x:750,y:800}))).toBe(true)
    expect(Number.isFinite(field.costAt({x:1250,y:800}))).toBe(true)
    expect(field.at({x:1000,y:800})).toBeGreaterThan(0)
    expect(field.costAt({x:200,y:800})).toBe(Infinity)
    expect(field.costAt({x:1800,y:800})).toBe(Infinity)
    expect(field.at({x:500,y:800})).toBe(0)
  })
  it('extends development along an actual acquired corridor while preserving its land budget',()=>{
    const options={config:{...config,settlement:'regional-city' as const,density:55},width:4000,height:3000,terrain:{...flat,cityOrigin:{x:2000,y:1500}}}
    const preliminary=planContinuousCityDemand(options),center=preliminary.center
    // A real through road may store only its outside-crop portal endpoints.
    const roads:Road[]=[{id:'east-corridor',kind:'arterial',width:10,boundaryContinuation:true,points:[{x:-200,y:center.y},{x:4200,y:center.y}],builtYear:1900}]
    const before=JSON.stringify(roads),field=planContinuousCityDemand({...options,access:{roads}})
    const east={x:center.x+1550,y:center.y},north={x:center.x,y:center.y-1050}
    expect(field.costAt(east)).toBeLessThan(field.costAt(north)*.65)
    expect(field.at(east)).toBeGreaterThan(field.at(north)+.1)
    expect(field.at(east)).toBeGreaterThan(preliminary.at(east))
    expect(field.metrics.targetUrbanArea).toBe(preliminary.metrics.targetUrbanArea)
    expect(field.metrics.selectedUrbanArea).toBeLessThan(4000*3000*.46)
    expect(JSON.stringify(roads)).toBe(before)
    const repeated=planContinuousCityDemand({...options,access:{roads}})
    expect(repeated.regions).toEqual(field.regions)
    for(const p of [east,north,center])expect(repeated.costAt(p)).toBe(field.costAt(p))
  })
  it('uses an attached station approach but never grants a disconnected station a free secondary centre',()=>{
    const options={config:{...config,settlement:'regional-city' as const,density:55},width:4000,height:3000,terrain:{...flat,cityOrigin:{x:2000,y:1500}}}
    const center=planContinuousCityDemand(options).center,entrance={x:3700,y:center.y}
    const connected:Road={id:'east-corridor',kind:'arterial',width:10,points:[{x:center.x-200,y:center.y},entrance],builtYear:1900}
    const isolated:Road={id:'isolated-platform-walk',kind:'local',width:3,points:[{x:350,y:200},{x:550,y:200}],builtYear:1900}
    const base=planContinuousCityDemand({...options,access:{roads:[connected,isolated]}})
    const disconnected=planContinuousCityDemand({...options,access:{roads:[connected,isolated],stations:[{id:'isolated',point:{x:450,y:200},entrance:{x:450,y:200},builtYear:1900}]}})
    for(let y=200;y<2800;y+=250)for(let x=200;x<3800;x+=250)expect(disconnected.costAt({x,y})).toBe(base.costAt({x,y}))
    const attached=planContinuousCityDemand({...options,access:{roads:[connected,isolated],stations:[{id:'attached',point:entrance,entrance,builtYear:1900}]}})
    expect(attached.costAt(entrance)).toBeLessThan(base.costAt(entrance))
    expect(attached.at(attached.center)).toBeGreaterThan(.95)
  })
  it('does not transmit road or station pressure across a4m exact sea barrier',()=>{
    const sea={id:'sea',kind:'water' as const,polygon:rectangle(1008,0,4,1600)},terrain={...flat,areas:[sea],waterAt:(p:{x:number;y:number})=>pointInRegion(p,sea)}
    const options={config,width:2000,height:1600,terrain},preliminary=planContinuousCityDemand(options)
    const opposite={x:preliminary.center.x<1008?1500:500,y:preliminary.center.y}
    const roads:Road[]=[{id:'uncertified-water-line',kind:'arterial',width:10,bridge:true,points:[{x:100,y:preliminary.center.y},{x:1900,y:preliminary.center.y}],builtYear:1900}]
    const field=planContinuousCityDemand({...options,access:{roads,stations:[{id:'opposite',point:opposite,entrance:opposite,builtYear:1900}]}})
    expect(field.costAt(opposite)).toBe(Infinity)
    expect(field.at(opposite)).toBe(0)
    expect(field.at(field.center)).toBeGreaterThan(.95)
  })
  it('tapers built intensity to zero through an outer fringe instead of jumping from twelve percent',()=>{
    const field=planContinuousCityDemand({config:{...config,settlement:'regional-city',density:50},width:4000,height:3000,terrain:{...flat,cityOrigin:{x:2000,y:1500}}})
    const values:number[]=[]
    for(let x=0;x<4000;x+=2)values.push(field.at({x,y:field.center.y}))
    expect(values.some(value=>value>0&&value<.04)).toBe(true)
    expect(values.some(value=>value>=.04&&value<.12)).toBe(true)
    expect(values.some(value=>value>=.12&&value<.3)).toBe(true)
    expect(Math.max(...values)).toBeGreaterThan(.95)
    expect(values.some(value=>value===0)).toBe(true)
  })
})
