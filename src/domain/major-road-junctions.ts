import type { Point, Road } from './types'
import { distance, distanceToSegment } from './geometry'

/** Ground-level major streets need usable junction angles. A shallow crossing
 * makes long triangular gores/return loops instead of an urban intersection.
 * An actual end-to-end continuation is a two-arm road, not such a junction. */
export function majorRoadJunctionsAllowed(points: readonly Point[], crossings: (a: Point, b: Point) => {point:Point;road:Road}[], isOpenEnd: (point:Point)=>boolean = ()=>false, contacts: (point:Point)=>{point:Point;road:Road}[] = ()=>[]): boolean {
  for(let i=1;i<points.length;i++){
    const a=points[i-1]!,b=points[i]!,span=distance(a,b)
    if(span<1e-7)continue
    // Exact shared endpoints can be missed by a floating t/u intersection
    // test. Survey incident pavement as well as strict segment crossings.
    for(const {point,road}of [...crossings(a,b),...contacts(a),...contacts(b)]){
      if(road.width<8||road.controlledAccess||(road.level??0)!==0||road.role==='ramp'||road.role==='expressway')continue
      for(let j=1;j<road.points.length;j++){
        const c=road.points[j-1]!,d=road.points[j]!,run=distance(c,d)
        if(run<1e-7||distanceToSegment(point,c,d)>.05)continue
        const sine=Math.abs((b.x-a.x)*(d.y-c.y)-(b.y-a.y)*(d.x-c.x))/(span*run)
        if(sine>=.5-1e-7)continue
        const newAway=distance(point,points[0]!)<.05?b:distance(point,points.at(-1)!)<.05?a:null
        const oldAway=distance(point,road.points[0]!)<.05?d:distance(point,road.points.at(-1)!)<.05?c:null
        if(newAway&&oldAway&&isOpenEnd(point)){
          const dot=((newAway.x-point.x)*(oldAway.x-point.x)+(newAway.y-point.y)*(oldAway.y-point.y))/(distance(point,newAway)*distance(point,oldAway))
          if(dot<-Math.cos(Math.PI/6))continue
        }
        return false
      }
    }
  }
  return true
}
