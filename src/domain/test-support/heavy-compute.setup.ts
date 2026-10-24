/// <reference types="node" />
import { readFile } from 'node:fs/promises'
import { prepareTerrainWasm, terrainWasmStatus } from '../../compute/wasm-terrain'

// Node has no browser asset URL. Load exactly the checked-in, hash-verified
// production binary before collecting terrain modules with top-level fixtures.
const bytes = Uint8Array.from(await readFile(new URL('../../../public/compute/terrain.wasm', import.meta.url))).buffer
if (!await prepareTerrainWasm({ bytes })) {
  throw new Error(`Heavy regressions require the production WASM kernel: ${terrainWasmStatus().reason}`)
}
