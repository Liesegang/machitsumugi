import type { CityMap } from '../domain/types'
import { GENERATOR_VERSION } from '../domain/land-development'

/** A restored world's geometry is kept intact; an app update cannot add DEM/history. */
export function SavedMapNotice({ map, onOpenSettings }: { map: CityMap | null; onOpenSettings: () => void }) {
  if (!map || map.previewPhase) return null
  const missing = [!map.terrainSurface && '標高データ', !map.timeline && '年代別の履歴'].filter(Boolean)
  const outdated = map.generatorVersion !== GENERATOR_VERSION
  if (!missing.length && !outdated) return null
  return <div className="saved-map-notice" role="note">
    <span>{outdated ? '以前に生成した地図を表示しています。更新された生成ルールは、新しく生成すると反映されます。' : '保存していた地図を表示しています。'}{missing.length > 0 && `${missing.join('・')}は保存されていません。`}</span>
    <button className="secondary" onClick={onOpenSettings}>生成設定</button>
  </div>
}
