import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

/** One immutable identity shared by the bundle and its public verification file. */
export function buildIdentity(): Plugin {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const git = (...args: string[]) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }
  const candidate = git('rev-parse', 'HEAD') || process.env.GITHUB_SHA || ''
  const commit = /^[a-f0-9]{40}$/i.test(candidate) ? candidate.toLowerCase() : null
  const info = { commit, dirty: !!git('status', '--porcelain'), builtAt: new Date().toISOString() }
  return {
    name: 'machitsumugi-build-identity',
    config: () => ({ define: { __BUILD_INFO__: JSON.stringify(info) } }),
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify(info, null, 2) + '\n' }) },
  }
}
