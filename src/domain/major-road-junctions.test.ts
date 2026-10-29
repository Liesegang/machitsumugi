import { describe, expect, it } from 'vitest'
import { majorRoadJunctionsAllowed } from './major-road-junctions'
import { PlanarRoadGraph } from './road-graph'

describe('usable urban major-road junctions',()=>{
  const graph=()=>{const graph=new PlanarRoadGraph();graph.add([{x:0,y:0},{x:1000,y:0}],{id:'trunk',kind:'arterial',role:'highway',width:12,builtYear:1650,phase:'test',reason:'through road',constructionCost:1},false);return graph}
  it('rejects shallow crossing and return legs which form needle-like triangular loops',()=>{
    const network=graph(),query=network.crossings.bind(network)
    expect(majorRoadJunctionsAllowed([{x:100,y:-10},{x:500,y:0},{x:900,y:10}],query)).toBe(false)
    expect(majorRoadJunctionsAllowed([{x:1000,y:0},{x:500,y:20}],query)).toBe(false)
  })
  it('permits perpendicular T junctions, useful diagonals and genuine end continuations',()=>{
    const network=graph(),query=network.crossings.bind(network),before=JSON.stringify(network.roads)
    for(const points of [[{x:500,y:200},{x:500,y:0}],[{x:400,y:-100},{x:600,y:100}],[{x:1000,y:0},{x:1200,y:10}]])expect(majorRoadJunctionsAllowed(points,query,p=>network.openEndHeading(p)!==undefined)).toBe(true)
    expect(JSON.stringify(network.roads)).toBe(before)
  })
  it('does not mistake an existing multi-arm junction for a free road end',()=>{
    const network=graph()
    network.add([{x:1000,y:0},{x:1100,y:200}],{id:'district',kind:'arterial',role:'collector',width:10,builtYear:1955,phase:'test',reason:'existing district street',constructionCost:1},true)
    const path=[{x:1000,y:0},{x:1200,y:10}],query=network.crossings.bind(network)
    expect(majorRoadJunctionsAllowed(path,query,()=>true)).toBe(true)
    expect(network.openEndHeading(path[0]!)).toBeUndefined()
    expect(majorRoadJunctionsAllowed(path,query,p=>network.openEndHeading(p)!==undefined)).toBe(false)
  })
  it('checks shared endpoint pavement even when the floating crossing test reports no intersection',()=>{
    const network=graph(),path=[{x:500,y:0},{x:900,y:15}]
    expect(majorRoadJunctionsAllowed(path,()=>[])).toBe(true)
    expect(majorRoadJunctionsAllowed(path,()=>[],p=>network.openEndHeading(p)!==undefined,p=>network.contacts(p))).toBe(false)
  })
  it('does not apply a major-road intersection rule to a lane or a separated elevated crossing',()=>{
    for(const update of [{width:5},{level:1}]){
      const network=graph();Object.assign(network.roads[0]!,update)
      expect(majorRoadJunctionsAllowed([{x:100,y:-10},{x:900,y:10}],network.crossings.bind(network))).toBe(true)
    }
  })
})
