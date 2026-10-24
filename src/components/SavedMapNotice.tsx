import type { CityMap } from '../domain/types'

/** A restored world's geometry is kept intact; an app update cannot add DEM/history. */
export function SavedMapNotice({ map, onOpenSettings }: { map: CityMap | null; onOpenSettings: () => void }) {
  if (!map || map.previewPhase) return null
  const missing = [!map.terrainSurface && '標高データ', !map.timeline && '年代別の履歴'].filter(Boolean)
  if (!missing.length) return null
  return <div className="saved-map-notice" role="note">
    <span>保存地図 {map.generatorVersion ?? '版情報なし'} を表示しています。{missing.join('・')}はありません。現行の地形・街路は、新しく生成すると反映されます。</span>
    <button className="secondary" onClick={onOpenSettings}>生成設定</button>
  </div>
}
