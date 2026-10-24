/** Shared by the map canvas (including PNG export) and SVG export. */
export const subwayInk = (style: 'standard' | 'mono' | 'night') => style === 'mono' ? '#555555' : style === 'night' ? '#d4b4ef' : '#9463a8'
export const SUBWAY_LINE_WIDTH = 2.6
export const SUBWAY_DASH = [7, 4] as const
