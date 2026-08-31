import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      // n8ao imports `postprocessing` for a pass we don't use; see src/stubs/postprocessing.ts.
      postprocessing: fileURLToPath(new URL('./src/stubs/postprocessing.ts', import.meta.url)),
    },
  },
});
