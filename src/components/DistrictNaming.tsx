import { useEffect, useRef, useState } from 'react'
import type { CityMap } from '../domain/types'
import type { NameProposal } from '../ai/district-names'

export function DistrictNaming({ map, disabled, onApply }: { map: CityMap; disabled: boolean; onApply: (proposals: NameProposal[]) => boolean }) {
  const [activeMap, setActiveMap] = useState<CityMap | null>(null), [progress, setProgress] = useState('')
  const [failure, setFailure] = useState<{ map: CityMap; message: string } | null>(null)
  const [batch, setBatch] = useState<{ map: CityMap; items: NameProposal[] } | null>(null)
  const busy = activeMap === map, error = failure?.map === map ? failure.message : '', proposals = batch?.map === map ? batch.items : []
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    if (disabled) controller.current?.abort()
    return () => controller.current?.abort()
  }, [map, disabled])
  async function propose() {
    controller.current?.abort()
    const request = new AbortController(); controller.current = request
    setActiveMap(map); setFailure(null); setBatch(null); setProgress('小型モデルを読み込み中…')
    try {
      const { proposeDistrictNames } = await import('../ai/local-naming')
      const result = await proposeDistrictNames(map, request.signal, setProgress)
      if (!request.signal.aborted) setBatch({ map, items: result })
    } catch (err) { if (!request.signal.aborted) setFailure({ map, message: err instanceof Error ? err.message : '命名できませんでした。' }) }
    finally { if (controller.current === request) { controller.current = null; setActiveMap(null) } }
  }
  return <section className="district-naming"><details><summary>地名の提案</summary><p className="muted">区域の特徴に合う地名を、ブラウザ内の小型LLMで提案します。</p>
    <p className="panel-footnote">初回に約1GBをダウンロードします。WebGPUが必要です。</p>
    {busy ? <><p role="status">{progress}</p><button className="secondary full" onClick={() => controller.current?.abort()}>命名を中止</button></> : <button className="secondary full" disabled={disabled || !map.districts.length} onClick={() => { void propose() }}>小型LLMで地名を提案</button>}
    {error && <p role="alert">{error}</p>}
    {!!proposals.length && <><p className="muted">区域の特徴と地名案を確認してから、表示中の年代の地図に反映できます。架空の命名です。</p><div className="name-proposals">{proposals.map(proposal => <label key={proposal.id}><input aria-label={`${proposal.id}の地名案`} maxLength={16} value={proposal.name} onChange={event => setBatch(old => old?.map === map ? { map, items: old.items.map(p => p.id === proposal.id ? { ...p, name: event.target.value, source: 'edited', reason: p.reason.replace('架空の候補から小型LLMが選びました。', '架空の候補をもとに利用者が編集しました。') } : p) } : old)} /><small>{proposal.reason}</small></label>)}</div><button className="primary full" disabled={disabled} onClick={() => { if (onApply(proposals)) setBatch(null) }}>地図に反映</button></>}
  </details></section>
}
