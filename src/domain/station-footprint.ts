import { distance, rectangle } from './geometry'
import type { CityConfig, Point } from './types'

/** A platform follows the actual engineered alignment rather than a straight
 * decorative bar whose ends can leave the railway or cross another property. */
export function stationFootprint(input: { points: Point[]; chain: number[]; along: number; side: number; config: CityConfig; main: boolean }) {
  const settlement = input.config.settlement ?? 'regional-city'
  const dimensions = settlement === 'metropolis' ? input.main ? [220, 84, 24, 112, 68] : [160, 42, 15, 76, 48]
    : settlement === 'regional-city' ? input.main ? [160, 52, 18, 86, 56] : [120, 30, 11, 58, 40]
      : settlement === 'rural-town' ? input.main ? [110, 30, 12, 56, 40] : [80, 20, 9, 44, 32]
        : input.main ? [80, 22, 10, 46, 34] : [60, 15, 8, 36, 28]
  const [length, buildingLength, depth, courtLength, courtDepth] = dimensions as [number, number, number, number, number]
  if (input.along - length / 2 < 8 || input.along + length / 2 > input.chain.at(-1)! - 8) return
  const at = (along: number) => {
    let i = 1
    while (i + 1 < input.chain.length && input.chain[i]! < along) i++
    const a = input.points[i - 1]!, b = input.points[i]!, span = distance(a, b), t = (along - input.chain[i - 1]!) / span
    return { point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, tangent: { x: (b.x - a.x) / span, y: (b.y - a.y) / span } }
  }
  const center = at(input.along), point = center.point, tangent = center.tangent
  const count = Math.ceil(length / 8) + 1
  const rows = Array.from({ length: count }, (_, i) => at(input.along - length / 2 + length * i / (count - 1)))
  const offset = (row: ReturnType<typeof at>, y: number) => ({ x: row.point.x - row.tangent.y * y, y: row.point.y + row.tangent.x * y })
  const strip = (inner: number, outer: number) => [...rows.map(row => offset(row, inner)), ...[...rows].reverse().map(row => offset(row, outer))]
  const platforms = [strip(4, 8), strip(-8, -4)], trackGround = strip(-8.5, 8.5)
  const transform = (x: number, y: number) => ({ x: point.x + tangent.x * x - tangent.y * y * input.side, y: point.y + tangent.y * x + tangent.x * y * input.side })
  const setback = Math.max(10, ...trackGround.filter(p => Math.abs((p.x - point.x) * tangent.x + (p.y - point.y) * tangent.y) < courtLength / 2 + 8).map(p => (-(p.x - point.x) * tangent.y + (p.y - point.y) * tangent.x) * input.side + 2))
  const building = rectangle(-buildingLength / 2, setback + 1, buildingLength, depth).map(p => transform(p.x, p.y))
  const forecourt = rectangle(-courtLength / 2, setback, courtLength, courtDepth).map(p => transform(p.x, p.y))
  const gateDistance = setback + courtDepth + 5
  return { point, tangent, platforms, trackGround, building, forecourt, gateDistance, gate: transform(0, gateDistance), entrance: transform(0, setback + depth + 4), publicGatePad: rectangle(-4, gateDistance - 4, 8, 8).map(p => transform(p.x, p.y)) }
}
