export const EPOCH_YEAR = { historic: 1800, railway: 1930, present: 2025 } as const

/** An explicit year overrides the three legacy era presets. */
export function simulationEndYear(input: { era?: keyof typeof EPOCH_YEAR; targetYear?: number }): number {
  const supplied = input.targetYear
  return typeof supplied === 'number' && Number.isFinite(supplied) ? Math.max(1650, Math.min(2025, Math.round(supplied))) : EPOCH_YEAR[input.era ?? 'present']
}

export const isConstructionYear = (year: number) => year === 1650 || year >= 1700 && year % 5 === 0

/** The founding settlement is present in1650. Investment/construction rounds
 * retain their existing1700-based five-year sequence. An arbitrary selected end
 * updates demand/occupancy between those rounds, never inventing an extra
 * project that would disappear when simulating a later year. */
export function simulationYears(end: number): number[] {
  const years = [1650]
  for (let year = 1700; year <= end; year += 5) years.push(year)
  if (end > 1650 && years.at(-1) !== end) years.push(end)
  return years
}
