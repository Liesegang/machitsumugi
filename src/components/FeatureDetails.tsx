import { MapPin, X } from 'lucide-react'
import type { CityMap, Point } from '../domain/types'
import { featureHistory, featureSummary, featureTitle } from '../map/inspect'
import type { MapFeature } from '../map/inspect'

export function FeatureDetails({ map, feature, point, onClose, onPin }: { map: CityMap; feature: MapFeature; point: Point; onClose: () => void; onPin: (point: Point) => void }) {
  const history = featureHistory(map, feature)
  return <section className="feature-popover" aria-label="この場所の履歴">
    <button className="icon-button popover-close" aria-label="建物情報を閉じる" onClick={onClose}><X size={16} /></button>
    <span className="field-caption">この場所について</span><h3>{featureTitle(feature)}</h3><p>{featureSummary(feature)}</p>
    {feature.type === 'district' && feature.item.nameOrigin && <p>{feature.item.namingSource === 'llm' ? 'LLMによる架空の命名理由：' : '仮称の説明：'}{feature.item.nameOrigin}</p>}
    <h4>記録された履歴</h4>
    {history.length ? <ol className="feature-history">{history.map(event => <li key={event.id}><time>{event.year}年</time><span>{event.reason}</span></li>)}</ol> : <p>この場所の成立や変化は未記録です。</p>}
    <button className="secondary full" onClick={() => onPin(point)}><MapPin size={15} />ここにピンを追加</button>
  </section>
}
