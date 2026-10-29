import type { Point } from './types'
import { distanceToSegment } from './geometry'

/** Remove sample-scale zigzags within a bounded bank corridor. Confluences
 * are fixed; no periodic meander/noise is added and the valley can veto moves. */
export function fairChannelControls(path: Point[], pinned: ReadonlySet<number>, maximumShift: (p: Point) => number, allows: (before:Point, after:Point)=>boolean = ()=>true): Point[] {
  let result=path.map(p=>({...p}))
  for(let pass=0;pass<2;pass++)result=result.map((p,i)=>{
    if(!i||i+1===path.length||pinned.has(i))return p
    const a=result[i-1]!,b=result[i+1]!,origin=path[i]!,next={x:p.x*.5+(a.x+b.x)*.25,y:p.y*.5+(a.y+b.y)*.25}
    const length=Math.hypot(next.x-origin.x,next.y-origin.y),limit=Math.max(0,maximumShift(origin))
    if(length>limit){next.x=origin.x+(next.x-origin.x)*limit/length;next.y=origin.y+(next.y-origin.y)*limit/length}
    return allows(origin,next)?next:origin
  })
  return result
}

/** Flatten a C1 river centreline by geometric error, not by a fixed20m chord.
 * A narrow stream seen close up needs just as round a bend as a wide trunk.
 * Original knots (including confluences) are retained exactly. */
export function channelCurve(path: Point[], tension = .9, tolerance = .15): Point[] {
  if (path.length < 2) return path.slice()
  const tangents = path.map((p, i) => {
    const a = path[Math.max(0, i - 1)]!, b = path[Math.min(path.length - 1, i + 1)]!
    const left = Math.hypot(p.x - a.x, p.y - a.y), right = Math.hypot(b.x - p.x, b.y - p.y)
    const scale = (i ? i + 1 < path.length ? Math.min(left, right) : left : right) * tension / (Math.hypot(b.x - a.x, b.y - a.y) || 1)
    return { x: (b.x - a.x) * scale, y: (b.y - a.y) * scale }
  })
  const result = [path[0]!], mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  const flatten = (a: Point, c: Point, d: Point, b: Point, depth: number) => {
    if (depth >= 16 || Math.max(distanceToSegment(c, a, b), distanceToSegment(d, a, b)) <= tolerance) {
      // Hydraulic bank surveys still require samples on straight reaches;
      // flattening a kilometre to two endpoints would miss a narrow rock sill.
      const count=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/20))
      for(let i=1;i<=count;i++)result.push(i===count?b:{x:a.x+(b.x-a.x)*i/count,y:a.y+(b.y-a.y)*i/count})
      return
    }
    const ac = mid(a, c), cd = mid(c, d), db = mid(d, b), left = mid(ac, cd), right = mid(cd, db), centre = mid(left, right)
    flatten(a, ac, left, centre, depth + 1); flatten(centre, right, db, b, depth + 1)
  }
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!, ta = tangents[i - 1]!, tb = tangents[i]!
    flatten(a, { x: a.x + ta.x / 3, y: a.y + ta.y / 3 }, { x: b.x - tb.x / 3, y: b.y - tb.y / 3 }, b, 0)
  }
  return result
}
