import { CreateWebWorkerMLCEngine } from '@mlc-ai/web-llm'
import type { CityMap } from '../domain/types'
import { districtNamingContext, parseNameProposals } from './district-names'
import type { NameProposal } from './district-names'

export const NAMING_MODEL = 'Qwen3-0.6B-q4f32_1-MLC'
export async function proposeDistrictNames(map: CityMap, signal: AbortSignal, onProgress: (text: string) => void): Promise<NameProposal[]> {
  if (!('gpu' in navigator)) throw new Error('このブラウザではWebGPUが使えません。WebGPU対応ブラウザで開いてください。')
  signal.throwIfAborted()
  const worker = new Worker(new URL('./naming.worker.ts', import.meta.url), { type: 'module' })
  let stop: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => { stop = () => { worker.terminate(); reject(new DOMException('命名を中止しました。', 'AbortError')) }; signal.addEventListener('abort', stop, { once: true }) })
  try {
    const engine = await Promise.race([CreateWebWorkerMLCEngine(worker, NAMING_MODEL, { initProgressCallback: report => onProgress(`モデルを準備中 · ${Math.round(report.progress * 100)}%`) }, { context_window_size: 2048 }), aborted])
    const proposals: NameProposal[] = []
    for (let start = 0; start < map.districts.length; start += 4) {
      signal.throwIfAborted()
      const batch = map.districts.slice(start, start + 4)
      onProgress(`地名を提案中 · ${start + 1}〜${start + batch.length} / ${map.districts.length}`)
      const reply = await Promise.race([engine.chat.completions.create({
        messages: [
          { role: 'system', content: 'あなたは架空の日本の地名を命名する。与えられた地形・施設・時代の記録だけを手がかりに、自然な日本語の町名を提案する。kind=wardだけ区で終える。記録にない事件・人物・年代は作らない。由来は史実ではなく命名理由を書く。回答はJSONのみ: {"names":[{"id":"指定ID","name":"地名","reason":"短い命名理由"}]}。IDを変更しない。各区域に1件。' },
          { role: 'user', content: JSON.stringify({ city: map.config.name, year: map.year, usedNames: proposals.map(p => p.name), districts: batch.map(d => districtNamingContext(map, d)) }) + '\n/no_think' },
        ], temperature: .55, max_tokens: 650, stream: false,
        extra_body: { enable_thinking: false },
      }), aborted])
      proposals.push(...parseNameProposals(reply.choices[0]?.message.content ?? '', batch, proposals.map(p => p.name)))
    }
    return proposals
  } finally { signal.removeEventListener('abort', stop); worker.terminate() }
}
