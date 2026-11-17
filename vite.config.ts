import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Transformers.js already points ONNX Runtime's WASM loader at its matching
 * versioned jsDelivr CDN by default. Vite also discovers the package's
 * fallback WASM binary as a local static asset; this one exceeds Cloudflare's
 * 25 MiB per-file limit. Remove only that redundant local copy. The runtime
 * continues to load and cache its exact-version WASM binary from the CDN.
 */
const useTransformersWasmCdn: Plugin = {
  name: 'use-transformers-onnx-wasm-cdn',
  generateBundle(_options, bundle) {
    for (const [fileName, output] of Object.entries(bundle)) {
      if (
        output.type === 'asset' &&
        fileName.includes('ort-wasm-simd-threaded.asyncify') &&
        fileName.endsWith('.wasm')
      ) {
        this.warn('Omitting bundled ONNX WASM fallback; Transformers.js loads the same versioned binary from its configured CDN.')
        delete bundle[fileName]
      }
    }
  },
}

export default defineConfig({
  plugins: [react(), useTransformersWasmCdn],
})
