import type { CityConfig, Point } from './types'
import type { TerrainModel } from './terrain'
import type { ContinuousCityDemand } from './continuous-city-types'
import { distance, seededRandom } from './geometry'
import type { PolygonRegion } from './geometry'
import { MinHeap } from './road-graph'
import { regionQuery } from './region-query'
import { contourLand } from './land-use'

type DemandTerrain = Pick<TerrainModel, 'cityOrigin' | 'areas' | 'waterAt' | 'slope' | 'elevation'> & Partial<Pick<TerrainModel, 'channelAt' | 'standingWaterAt'>>
export interface ContinuousDemandInput { config: CityConfig; width: number; height: number; terrain: DemandTerrain }

/** Indexed exact shoreline crossings. Sampling an edge's midpoint misses a
 * channel narrower than a demand cell. Holes belong to their parent water body,
 * so a dry island is traversable internally without acquiring a route ashore. */
function standingWaterBarrier(regions: readonly PolygonRegion[], contains: (p: Point) => boolean, cellSize: number) {
  type Edge = { a: Point; b: Point }
  const bins = new Map<string, Edge[]>(), size = Math.max(80, cellSize * 2)
  for (const region of regions) for (const ring of [region.polygon, ...(region.holes ?? [])]) for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!, edge = { a, b }
    for (let x = Math.floor(Math.min(a.x, b.x) / size); x <= Math.floor(Math.max(a.x, b.x) / size); x++) for (let y = Math.floor(Math.min(a.y, b.y) / size); y <= Math.floor(Math.max(a.y, b.y) / size); y++) {
      const key = `${x}:${y}`, entries = bins.get(key) ?? []; entries.push(edge); bins.set(key, entries)
    }
  }
  return (a: Point, b: Point) => {
    const edges = new Set<Edge>()
    for (let x = Math.floor(Math.min(a.x, b.x) / size); x <= Math.floor(Math.max(a.x, b.x) / size); x++) for (let y = Math.floor(Math.min(a.y, b.y) / size); y <= Math.floor(Math.max(a.y, b.y) / size); y++) for (const edge of bins.get(`${x}:${y}`) ?? []) edges.add(edge)
    if (!edges.size) return false
    const dx = b.x - a.x, dy = b.y - a.y, square = dx * dx + dy * dy, cuts = [0, 1]
    if (square < 1e-16) return false
    for (const edge of edges) {
      const ex = edge.b.x - edge.a.x, ey = edge.b.y - edge.a.y, ox = edge.a.x - a.x, oy = edge.a.y - a.y, determinant = dx * ey - dy * ex
      if (Math.abs(determinant) < 1e-10) {
        if (Math.abs(ox * dy - oy * dx) > 1e-8) continue
        const t0 = (ox * dx + oy * dy) / square, t1 = ((edge.b.x - a.x) * dx + (edge.b.y - a.y) * dy) / square
        if (Math.max(t0, t1) < 0 || Math.min(t0, t1) > 1) continue
        cuts.push(Math.max(0, Math.min(1, t0)), Math.max(0, Math.min(1, t1)))
      } else {
        const t = (ox * ey - oy * ex) / determinant, u = (ox * dy - oy * dx) / determinant
        if (t >= -1e-10 && t <= 1 + 1e-10 && u >= -1e-10 && u <= 1 + 1e-10) cuts.push(Math.max(0, Math.min(1, t)))
      }
    }
    if (cuts.length === 2) return false
    cuts.sort((x, y) => x - y)
    for (let i = 1; i < cuts.length; i++) {
      if (cuts[i]! - cuts[i - 1]! < 1e-12) continue
      const t = (cuts[i]! + cuts[i - 1]!) / 2
      if (contains({ x: a.x + dx * t, y: a.y + dy * t })) return true
    }
    return false
  }
}

/** One least-cost land market, rather than a collection of isolated town discs.
 * Rivers may carry development pressure to the opposite bank, but sea, lakes
 * and steep terrain do not. This is demand ONLY, never a bridge certificate.
 * Density changes the developed footprint, not random missing houses per lot. */
export function planContinuousCityDemand({config,width,height,terrain}: ContinuousDemandInput): ContinuousCityDemand {
  const cellSize = Math.max(40, Math.min(80, Math.min(width,height)/60))
  const columns = Math.ceil(width/cellSize), rows = Math.ceil(height/cellSize), count = columns*rows
  const sx=width/columns, sy=height/rows, area=sx*sy
  const point=(id:number):Point=>({x:(id%columns+.5)*sx,y:(Math.floor(id/columns)+.5)*sy})
  const standingRegions=terrain.areas.filter(a=>a.kind==='water'&&!a.id.startsWith('river'))
  const standing=regionQuery(standingRegions), crossesStanding=standingWaterBarrier(standingRegions,standing,cellSize)
  const rivers=regionQuery(terrain.areas.filter(a=>a.kind==='water'&&a.id.startsWith('river')))
  const riverIds=new Set(terrain.areas.filter(a=>a.kind==='water'&&a.id.startsWith('river')).map(a=>a.id))
  const grades=new Float32Array(count), resistance=new Float32Array(count), dry=new Uint8Array(count)
  const passable=(p:Point)=>{
    if(p.x<0||p.y<0||p.x>width||p.y>height||terrain.slope(p)>.24)return false
    if(standing(p))return false
    if(!terrain.waterAt(p))return true
    const hit=terrain.channelAt?.(p)
    // Exact bank vertices may be excluded by the polygon's half-open ray rule.
    // Accept that boundary only with the same identified, bounded channel.
    const onBank=hit&&riverIds.has(hit.riverId)&&distance(p,hit.point)<=hit.width/2+.02
    return !!hit&&hit.width<=260&&(rivers(p)||!!onBank)
  }
  const candidates:number[]=[]
  for(let id=0;id<count;id++){
    const p=point(id),grade=terrain.slope(p)
    grades[id]=grade
    if(!passable(p)){resistance[id]=Infinity;continue}
    const water=terrain.waterAt(p)
    dry[id]=water?0:1
    resistance[id]=water?3.2:1+Math.max(0,grade-.015)*18
    if(!water&&grade<.10)candidates.push(id)
  }
  if(!candidates.length)throw new Error('連続した市街地を設計できる陸地がありません。')
  let cx=0,cy=0,weight=0
  for(const id of candidates){const p=point(id),w=Math.exp(-grades[id]!*12);cx+=p.x*w;cy+=p.y*w;weight+=w}
  const landCenter={x:cx/weight,y:cy/weight}, random=seededRandom(config.seed+':continuous-origin')
  const broadDry=(id:number)=>{
    const p=point(id);let score=0
    for(const dx of [-2,0,2])for(const dy of [-2,0,2]){const x=Math.floor(p.x/sx)+dx,y=Math.floor(p.y/sy)+dy;if(x>=0&&y>=0&&x<columns&&y<rows)score+=dry[y*columns+x]!*(1-Math.min(.9,grades[y*columns+x]!*6))}
    return score/9
  }
  const shortlist=candidates.filter((_,i)=>i%Math.max(1,Math.floor(candidates.length/700))===0)
  let origin=shortlist[0]!,best=-Infinity
  for(const id of shortlist){const p=point(id),score=broadDry(id)*2-distance(p,landCenter)/Math.min(width,height)*1.3-distance(p,terrain.cityOrigin)/Math.hypot(width,height)*.18+random()*.015;if(score>best){best=score;origin=id}}
  const center=point(origin), costs=new Float64Array(count).fill(Infinity), queue=new MinHeap<number>()
  costs[origin]=0;queue.push(origin,0)
  const neighbors=[[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]] as const
  while(queue.size){
    const current=queue.pop()!;if(current.priority>costs[current.value]!+1e-7)continue
    const id=current.value,x=id%columns,y=Math.floor(id/columns),a=point(id)
    for(const [dx,dy]of neighbors){
      const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=columns||ny>=rows)continue
      const next=ny*columns+nx;if(!Number.isFinite(resistance[next]))continue
      const b=point(next),mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2}
      if(!passable(mid)||crossesStanding(a,b))continue
      const cost=costs[id]!+Math.hypot(dx*sx,dy*sy)*(resistance[id]!+resistance[next]!)/2
      if(cost<costs[next]!){costs[next]=cost;queue.push(next,cost)}
    }
  }
  const reachable=candidates.filter(id=>Number.isFinite(costs[id])).sort((a,b)=>costs[a]!-costs[b]!)
  const density=Math.max(0,Math.min(1,config.density/100))
  const fraction=({village:.025,'rural-town':.16,'regional-city':.56,metropolis:.9}[config.settlement??'regional-city'])*(.32+.68*density)
  const target=Math.max(1,Math.floor(reachable.length*fraction)),threshold=costs[reachable[Math.min(target-1,reachable.length-1)]!]!+cellSize*.55
  const costAt=(p:Point)=>{
    if(p.x<0||p.y<0||p.x>width||p.y>height||standing(p))return Infinity
    const x=Math.max(0,Math.min(columns-1,p.x/sx-.5)),y=Math.max(0,Math.min(rows-1,p.y/sy-.5)),ix=Math.floor(x),iy=Math.floor(y),u=x-ix,v=y-iy
    const corners=[[ix,iy,(1-u)*(1-v)],[Math.min(columns-1,ix+1),iy,u*(1-v)],[ix,Math.min(rows-1,iy+1),(1-u)*v],[Math.min(columns-1,ix+1),Math.min(rows-1,iy+1),u*v]] as const
    let total=0,mass=0
    for(const [x0,y0,w]of corners){const value=costs[y0*columns+x0]!;if(w>0&&Number.isFinite(value)&&!crossesStanding(p,point(y0*columns+x0))){total+=value*w;mass+=w}}
    return mass>.05?total/mass:Infinity
  }
  const at=(p:Point)=>{
    const cost=costAt(p)
    if(cost>threshold||terrain.waterAt(p)||terrain.slope(p)>.19)return 0
    return .12+.88*Math.pow(Math.max(0,1-cost/threshold),.65)
  }
  const openingAt=(p:Point)=>{const ratio=costAt(p)/Math.max(1,threshold);return ratio<.08?1650:ratio<.25?1900:ratio<.52?1955:ratio<.75?1975:1995}
  const regions=contourLand(width,height,p=>at(p)>0?threshold-costAt(p):-cellSize,cellSize)
  return {center,regions,at,costAt,openingAt,metrics:{cellSize,reachableLandArea:reachable.length*area,targetUrbanArea:target*area,selectedUrbanArea:reachable.filter(id=>costs[id]!<=threshold).length*area}}
}
