import { CreateWebWorkerMLCEngine } from '@mlc-ai/web-llm'
import type { CityMap } from '../domain/types'
import { districtNameCandidates, districtNamingContext, parseNameSelection, validateGeographicNames } from './district-names'
import type { NameProposal } from './district-names'

export const NAMING_MODEL = 'Qwen3-1.7B-q4f16_1-MLC'
export async function proposeDistrictNames(map: CityMap, signal: AbortSignal, onProgress: (text: string) => void): Promise<NameProposal[]> {
  if (!('gpu' in navigator)) throw new Error('このブラウザではWebGPUが使えません。WebGPU対応ブラウザで開いてください。')
  signal.throwIfAborted()
  const gpu = navigator.gpu as { requestAdapter: () => Promise<{ features: { has: (feature: string) => boolean } } | null> }
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('地名生成に使えるWebGPUのGPUが見つかりませんでした。')
  signal.throwIfAborted()
  const model = adapter.features.has('shader-f16') ? NAMING_MODEL : 'Qwen3-1.7B-q4f32_1-MLC'
  const worker = new Worker(new URL('./naming.worker.ts', import.meta.url), { type: 'module' })
  let stop: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => { stop = () => { worker.terminate(); reject(new DOMException('命名を中止しました。', 'AbortError')) }; signal.addEventListener('abort', stop, { once: true }) })
  try {
    const engine = await Promise.race([CreateWebWorkerMLCEngine(worker, model, { initProgressCallback: report => onProgress(`モデルを準備中 · ${report.text}`) }, { context_window_size: 4096 }), aborted])
    const proposals: NameProposal[] = []
    for (let start = 0; start < map.districts.length; start++) {
      signal.throwIfAborted()
      const district = map.districts[start]!
      const context = districtNamingContext(map, district)
      const used = [map.config.name, ...map.districts.map(d => d.name), ...proposals.map(p => p.name)]
      const candidates = districtNameCandidates(map, district, used)
      if (!candidates.length) throw new Error('重複しない地名候補を用意できませんでした。')
      let correction = ''
      for (let attempt = 0; attempt < 3; attempt++) {
        onProgress(`区域に合う地名を選択中 · ${start + 1} / ${map.districts.length}`)
        const reply = await Promise.race([engine.chat.completions.create({
          messages: [
            { role: 'system', content: 'Select one fictional Japanese place name from the numbered candidates that best suits the observed district. Compare the meanings with the actual observations. Reply only with a JSON object whose key is "choice" and whose value is the selected integer candidate number. Do not create another name or explain.' },
            { role: 'user', content: JSON.stringify({ observedFeatures: context.observedFeatures, candidates: candidates.map((name, index) => ({ choice: index + 1, name })), ...(correction ? { correction } : {}) }) + '\n/no_think' },
          ], temperature: .4, max_tokens: 30, stream: false,
          extra_body: { enable_thinking: false },
        }), aborted])
        try {
          const parsed = parseNameSelection(reply.choices[0]?.message.content ?? '', district, candidates, used, `観測した区域の特徴：${context.observedFeatures}。架空の候補から小型LLMが選びました。`)
          validateGeographicNames(map, [parsed])
          proposals.push(parsed)
          break
        } catch (error) {
          if (attempt === 2) throw error
          correction = error instanceof Error ? error.message : 'Return one integer candidate number as JSON.'
          onProgress(`地名の選択結果を再確認中 · ${attempt + 1} / 2`)
        }
      }
    }
    return proposals
  } finally { signal.removeEventListener('abort', stop); worker.terminate() }
}
