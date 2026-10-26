import {describe,it,expect} from 'vitest'
import {planContinuousCityDemand} from './continuous-city-demand'
import type {CityConfig} from './types'
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
})
