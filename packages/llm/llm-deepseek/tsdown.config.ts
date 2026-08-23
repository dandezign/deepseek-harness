import { defineConfig } from 'tsdown'

/**
 * Builds the `wire` subpath beside the default index/invariant entries; the
 * workspace default entry glob covers only index, invariant, and startup.
 * Each entry is a separate build so both inline the shared adapter modules —
 * a multi-entry build creates an unlisted chunk.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js', 'lib/types/invariant.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/wire.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
