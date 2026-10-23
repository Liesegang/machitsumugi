import type { Point } from './types'

export interface ChannelBedSection { points: Point[]; widths: number[]; levels: number[]; lake?: boolean }
export interface ChannelSedimentBudget { erodedVolume: number; depositedVolume: number; exportedVolume: number; massBalanceError: number; resolution: number; plugRequiredVolume: number; plugDepositedVolume: number; plugsClosed: boolean; initialExcavationVolume: number; initialExportedVolume: number; totalExcavationVolume: number; totalExportedVolume: number; totalMassBalanceError: number }
/** A subsequent local bank/point-bar stage, independent of the earlier regional
 * hillslope transport. The initial existing bed is its boundary condition.
 * Centreline proposals come from bank mobility/curvature, not a 2D flow solver.
 * Actual 10m bed-cell lowering supplies sediment; it first fills old bed outside
 * the active water, including neck plugs, and the remainder leaves downstream.
 */
export function reworkChannelBed(input: { ground: Float32Array; columns: number; rows: number; resolution: number; origin: Point; initial: ChannelBedSection[]; current: ChannelBedSection[]; abandoned: ChannelBedSection[]; exclude?: (p: Point) => boolean }) {
  const { columns, rows, resolution, origin } = input, cellArea = resolution * resolution
  type BedCell = { bed: number; level: number }
  const raster = (sections: ChannelBedSection[]) => {
    const cells = new Map<number, BedCell>()
    for (const section of sections) for (let i = 1; i < section.points.length; i++) {
      const a = section.points[i - 1]!, b = section.points[i]!, dx = b.x - a.x, dy = b.y - a.y, square = dx * dx + dy * dy
      const radius = Math.max(section.widths[i - 1]!, section.widths[i]!) / 2
      const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - radius - origin.x) / resolution)), x1 = Math.min(columns - 1, Math.ceil((Math.max(a.x, b.x) + radius - origin.x) / resolution))
      const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - radius - origin.y) / resolution)), y1 = Math.min(rows - 1, Math.ceil((Math.max(a.y, b.y) + radius - origin.y) / resolution))
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = origin.x + x * resolution, py = origin.y + y * resolution, t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (square || 1)))
        if (input.exclude?.({ x: px, y: py })) continue
        const d = Math.hypot(px - a.x - t * dx, py - a.y - t * dy), width = section.widths[i - 1]! * (1 - t) + section.widths[i]! * t
        if (d >= width / 2) continue
        const level = section.levels[i - 1]! * (1 - t) + section.levels[i]! * t, depth = (1.2 + width * .035) * (section.lake ? .6 : 1)
        const bed = level - depth * (1 - (d / (width / 2)) ** 2), index = y * columns + x, previous = cells.get(index)
        if (!previous || bed < previous.bed) cells.set(index, { bed, level })
      }
    }
    return cells
  }
  const initialWater = raster(input.initial), activeWater = raster(input.current), lakes = raster(input.abandoned)
  const initialBed = new Float32Array(input.ground)
  for (const [index, water] of initialWater) initialBed[index] = Math.min(initialBed[index]!, water.bed)
  // Sub-grid initial channel reconstruction is a distinct excavation, not
  // unrecorded valley flattening. Its sediment leaves this local boundary;
  // later bank movement has the separately reported point-bar/plug budget.
  let initialExcavationVolume = 0
  for (let i = 0; i < initialBed.length; i++) initialExcavationVolume += (input.ground[i]! - initialBed[i]!) * cellArea
  const bed = new Float32Array(initialBed), deposition = new Float32Array(bed.length), erosion = new Float32Array(bed.length)
  let erodedVolume = 0, depositedVolume = 0
  for (const water of [activeWater, lakes]) for (const [index, target] of water) {
    const old = bed[index]!, lowered = Math.fround(Math.min(old, target.bed))
    bed[index] = lowered; erosion[index] += old - lowered; erodedVolume += (old - lowered) * cellArea
  }
  const lakeEnds = input.abandoned.flatMap(section => [section.points[0]!, section.points.at(-1)!])
  const fill = [...initialWater].filter(([index]) => !activeWater.has(index) && !lakes.has(index)).map(([index, old]) => {
    const p = { x: origin.x + index % columns * resolution, y: origin.y + Math.floor(index / columns) * resolution }
    return { index, target: Math.max(bed[index]!, old.level + .15), priority: Math.min(Infinity, ...lakeEnds.map(end => Math.hypot(p.x - end.x, p.y - end.y))) }
  }).sort((a, b) => a.priority - b.priority || a.index - b.index)
  const plugRequiredVolume = fill.filter(cell => cell.priority <= resolution * 2).reduce((sum, cell) => sum + (cell.target - bed[cell.index]!) * cellArea, 0)
  let remaining = erodedVolume, plugDepositedVolume = 0
  for (const cell of fill) {
    if (remaining <= 0) break
    const old = bed[cell.index]!, capacity = (cell.target - old) * cellArea
    if (capacity <= 0) continue
    // A float32 grid is the actual state. Account its realized change rather
    // than claiming an exact volume that was lost through numeric rounding.
    let raised = Math.fround(old + Math.min(capacity, remaining) / cellArea)
    if ((raised - old) * cellArea > remaining) raised = old
    bed[cell.index] = raised; deposition[cell.index] = raised - old
    const volume = (raised - old) * cellArea
    remaining -= volume; depositedVolume += volume
    if (cell.priority <= resolution * 2) plugDepositedVolume += volume
  }
  const exportedVolume = Math.max(0, erodedVolume - depositedVolume)
  const totalExcavationVolume = initialExcavationVolume + erodedVolume, totalExportedVolume = initialExcavationVolume + exportedVolume
  const budget: ChannelSedimentBudget = { erodedVolume, depositedVolume, exportedVolume, massBalanceError: erodedVolume - depositedVolume - exportedVolume, resolution, plugRequiredVolume, plugDepositedVolume, plugsClosed: plugDepositedVolume >= plugRequiredVolume - 1, initialExcavationVolume, initialExportedVolume: initialExcavationVolume, totalExcavationVolume, totalExportedVolume, totalMassBalanceError: totalExcavationVolume - depositedVolume - totalExportedVolume }
  return { initialBed, bed, erosion, deposition, budget }
}
