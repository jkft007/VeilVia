import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import { aiImagePlugin } from './server/ai-image';

// Production builds ship a strict CSP: no network access at all, no third-party scripts.
const csp: Plugin = {
  name: 'strict-csp',
  apply: 'build',
  transformIndexHtml(html) {
    const policy =
      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'none'; base-uri 'none'; form-action 'none'";
    return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}">`);
  },
};

// The text reader (Tesseract.js) runs from our own origin: worker, engine and English data are
// served from /ocr/ and only downloaded when someone actually reads text from a picture.
const OCR_FILES: Record<string, string> = {
  'worker.min.js': 'node_modules/tesseract.js/dist/worker.min.js',
  'tesseract-core-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
  'eng.traineddata.gz': 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
};

const ocrAssets: Plugin = {
  name: 'ocr-assets',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const m = /\/ocr\/([^/?#]+)/.exec(req.url ?? '');
      const file = m && OCR_FILES[m[1]];
      if (!file) return next();
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
      res.end(readFileSync(file));
    });
  },
  generateBundle() {
    for (const [name, file] of Object.entries(OCR_FILES)) {
      this.emitFile({ type: 'asset', fileName: `ocr/${name}`, source: readFileSync(file) });
    }
  },
};

export default defineConfig({
  base: './',
  plugins: [csp, ocrAssets, aiImagePlugin()],
  test: { environment: 'node', testTimeout: 60000, setupFiles: ['tests/setup.ts'] },
});
