import type { CityMap } from '../domain/types'

export function previewStockLabel(map: CityMap) {
  if (map.previewPhase === 'landscape' || map.previewPhase === 'erosion') return '広域地形の生成途中'
  if (map.previewPhase === 'hydrology') return '地形・水系の生成途中'
  if (map.previewPhase === 'roads' || map.previewPhase === 'railway') return '道路計画中 · 建物は後で配置'
  return `建物 ${map.buildings.length.toLocaleString()}棟 · 生成途中`
}
