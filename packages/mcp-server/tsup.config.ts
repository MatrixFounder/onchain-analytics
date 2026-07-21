import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  // Declarations are emitted by `tsc --emitDeclarationOnly` (see the package.json `build`
  // script), not by tsup's `dts` option: rollup-plugin-dts's bundled TS is incompatible with
  // our pinned typescript@6 (TypeError reading 'useCaseSensitiveFileNames') — see .AGENTS.md.
  dts: false,
  clean: true,
});
