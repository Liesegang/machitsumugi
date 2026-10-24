# Terrain numeric kernel

This dependency-free Rust `cdylib` ports the existing TypeScript Priority-Flood,
D8/D8-LTD routing, implicit stream-power erosion, conservative hillslope
transport, and multi-flow sediment deposition. Resolution, iteration count,
physical closures, loop order, and tie rules remain those of the JS reference.

Raster elevation and cumulative incision retain `f32` storage. Arithmetic,
contributing areas, alluvium, and volume budgets retain `f64`. `sqrt` uses the
WASM instruction; `hypot` and `exp` call the same JavaScript engine functions as
the reference to avoid cross-library rounding differences. No fast-math or
relaxed SIMD flags are used.

## Rebuild

```sh
rustup target add wasm32-unknown-unknown
npm run build:wasm
node scripts/build-wasm.mjs --check
```

The optimized binary is checked in under `public/compute/terrain.wasm`. Ordinary
web builds verify its source/binary SHA-256 fingerprints without installing or
running Rust. Source fingerprints normalize CRLF to LF so Windows and Linux
checkouts agree. `Cargo.lock` records the empty dependency graph. Regeneration
updates the binary, public manifest, and `src/compute/terrain-kernel-version.ts`
together.

## Runtime contract

`prepareTerrainWasm()` asynchronously fetches, verifies, and instantiates once
per worker. Loading times out after five seconds. `wasmRouteDrainage()` and
`wasmErodeTerrain()` are then synchronous, returning `null` when initialization
or validated input requirements are not met so callers can use the JS path.

The ABI owns a single grid allocation. JS copies validated input into named
buffers and copies result arrays out before releasing it. Nested calls during
preview return `null`; they cannot overwrite the active simulation. Erosion
remains in WASM between four-pass preview boundaries. Sea level is evaluated
for every individual pass, including the final sixteen-pass ria transition.

Input is capped at 1,048,576 cells and 4,096 passes. The module's linear-memory
maximum is 256 MiB. Its ABI version is checked before use. Returned arrays are
independent of subsequent calls and memory growth.

## Validation

```sh
npx vitest run src/compute/wasm-terrain.test.ts
```

The quick differential suite compares against `routeDrainageJs` and
`erodeTerrainJs`, whose internal routing stays on the JS reference path. It
covers flat/tied terrain, pits, single-row edges, negative elevations,
submerged/standing-water deposition, uplift, changing sea level, preview
ordering, array ownership, invalid input, nested calls, and callback cleanup.
Production-size benchmarks are run separately, outside the quick suite.

Marine fluvial deposition additionally uses a depth-dependent washload length:
`max(previousLength, 0.05 m/s * max(1 m, depth) / 0.00004 m/s)`. These fictional
fine-settling/background-current parameters are not empirical calibration, a
grain-sorting model, or a full ocean-flow solution. Only connected seawater uses
this closure; lake trapping stays unchanged. Export still occurs solely through
the actual open raster boundary. The same f64 expression is used in JS/Rust.
