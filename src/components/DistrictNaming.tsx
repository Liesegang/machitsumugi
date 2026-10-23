import { useEffect, useRef, useState } from 'react'
import type { CityMap } from '../domain/types'
import type { NameProposal } from '../ai/district-names'

export function DistrictNaming({ map, disabled, onApply }: { map: CityMap; disabled: boolean; onApply: (proposals: NameProposal[]) => void }) {
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(''), [error, setError] = useState(''), [proposals, setProposals] = useState<NameProposal[]>([])
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => { controller.current?.abort() }, [])
  async function propose() {
    const request = new AbortController(); controller.current = request
    setBusy(true); setError(''); setProposals([]); setProgress('小型モデルを読み込み中…')
    try {
      const { proposeDistrictNames } = await import('../ai/local-naming')
      const result = await proposeDistrictNames(map, request.signal, setProgress)
      if (!request.signal.aborted) setProposals(result)
    } catch (err) { if (!request.signal.aborted) setError(err instanceof Error ? err.message : '命名できませんでした。') }
    finally { if (controller.current === request) { controller.current = null; setBusy(false) } }
  }
  return <section className="district-naming"><h2>区域と地名</h2><p className="muted">道路と集落から区域を分けます。小型LLMが地形と履歴をもとに地名を提案します。</p>
    <p className="panel-footnote">Qwen3 0.6Bをブラウザ内で実行します。初回は数百MBのモデルを取得します。WebGPUと約2GBのGPUメモリが必要です。</p>
    {busy ? <><p role="status">{progress}</p><button className="secondary full" onClick={() => controller.current?.abort()}>命名を中止</button></> : <button className="secondary full" disabled={disabled || !map.districts.length} onClick={() => { void propose() }}>小型LLMで地名を提案</button>}
    {error && <p role="alert">{error}</p>}
    {!!proposals.length && <><p className="muted">提案を確認してから反映できます。由来は架空の命名理由です。</p><div className="name-proposals">{proposals.map(proposal => <label key={proposal.id}><input aria-label={`${proposal.id}の地名案`} maxLength={16} value={proposal.name} onChange={event => setProposals(old => old.map(p => p.id === proposal.id ? { ...p, name: event.target.value } : p))} /><small>{proposal.reason}</small></label>)}</div><button className="primary full" disabled={disabled} onClick={() => { onApply(proposals); setProposals([]) }}>地図に反映</button></>}
  </section>
}
