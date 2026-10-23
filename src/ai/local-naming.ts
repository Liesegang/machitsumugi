import { CreateWebWorkerMLCEngine } from '@mlc-ai/web-llm'
import type { CityMap } from '../domain/types'
import { districtNamingContext, parseNameProposals, validateGeographicNames } from './district-names'
import type { NameProposal } from './district-names'

export const NAMING_MODEL = 'Qwen3-0.6B-q4f32_1-MLC'
export async function proposeDistrictNames(map: CityMap, signal: AbortSignal, onProgress: (text: string) => void): Promise<NameProposal[]> {
  if (!('gpu' in navigator)) throw new Error('このブラウザではWebGPUが使えません。WebGPU対応ブラウザで開いてください。')
  signal.throwIfAborted()
  const worker = new Worker(new URL('./naming.worker.ts', import.meta.url), { type: 'module' })
  let stop: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => { stop = () => { worker.terminate(); reject(new DOMException('命名を中止しました。', 'AbortError')) }; signal.addEventListener('abort', stop, { once: true }) })
  try {
    const engine = await Promise.race([CreateWebWorkerMLCEngine(worker, NAMING_MODEL, { initProgressCallback: report => onProgress(`モデルを準備中 · ${report.text}`) }, { context_window_size: 4096 }), aborted])
    const proposals: NameProposal[] = []
    for (let start = 0; start < map.districts.length; start += 4) {
      signal.throwIfAborted()
      const batch = map.districts.slice(start, start + 4)
      let correction = ''
      for (let attempt = 0; attempt < 3; attempt++) {
      onProgress(`地名を提案中 · ${start + 1}〜${start + batch.length} / ${map.districts.length}`)
      const reply = await Promise.race([engine.chat.completions.create({
        messages: [
          { role: 'system', content: '架空の日本の町名を考える。observedFeaturesの具体的な特徴を使い、自然な漢字2〜5字の語幹に「町」を付ける。kind=wardの区域だけ「区」を付ける。「市」「県」「府」「都」は付けない。温泉宿lodgings=0かつfacilitiesにonsenがない区域では「湯」「泉」を使ってはいけない。forbiddenNamesの名称をそのまま返さない。理由は区域の具体的な特徴と名前の結び付きを一文で書く。曖昧な理由は禁止。人物や事件など架空の歴史は書かない。JSON以外は出力しない。形式: {"names":[{"id":"指定されたID","name":"町名","reason":"具体的な命名理由"}]}。各IDに一件ずつ。' },
          { role: 'user', content: JSON.stringify({ year: map.year, forbiddenNames: [map.config.name, ...map.districts.map(d => d.name), ...proposals.map(p => p.name)], districts: batch.map(d => districtNamingContext(map, d)), ...(correction ? { correction } : {}) }) + '\n/no_think' },
        ], temperature: .55, max_tokens: 650, stream: false,
        extra_body: { enable_thinking: false },
      }), aborted])
      try {
        const parsed = parseNameProposals(reply.choices[0]?.message.content ?? '', batch, [map.config.name, ...map.districts.map(d => d.name), ...proposals.map(p => p.name)])
        validateGeographicNames(map, parsed)
        proposals.push(...parsed)
        break
      } catch (error) {
        if (attempt === 2) throw error
        correction = error instanceof Error ? error.message : '地理的な根拠とJSONの形式を修正してください。'
        onProgress(`地名の重複と地理的な根拠を再確認中 · ${attempt + 1} / 2`)
      }
      }
    }
    return proposals
  } finally { signal.removeEventListener('abort', stop); worker.terminate() }
}
