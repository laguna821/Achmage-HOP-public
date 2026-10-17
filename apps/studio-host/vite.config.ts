import { defineConfig, normalizePath } from 'vite';
import { basename, dirname, relative, resolve } from 'node:path';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Plugin } from 'vite';
import { createHopOverrides } from './hop-overrides.ts';

const desktopConfig = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../desktop/src-tauri/tauri.conf.json'), 'utf-8'),
);
// Achmage HOP's own release version (the upstream HOP version above stays the base it is built on).
const achmageReleaseConfig = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../desktop/src-tauri/tauri.achmage.release.conf.json'), 'utf-8'),
);
const upstreamStudioDir = resolve(import.meta.dirname, '../../third_party/rhwp/rhwp-studio');
const upstreamSrc = resolve(import.meta.dirname, '../../third_party/rhwp/rhwp-studio/src');
const hopSrc = resolve(import.meta.dirname, 'src');
const rhwpWasmModule = normalizePath(resolve(import.meta.dirname, 'vendor/rhwp-core/rhwp.js'));
const rhwpWasmDir = dirname(rhwpWasmModule);
const rhwpWasmPackage = JSON.parse(readFileSync(resolve(rhwpWasmDir, 'package.json'), 'utf-8'));
const fontAssetsDir = resolve(import.meta.dirname, '../../assets/fonts');
// The Kordoc engine's WebView worker, built and checked against the Node worker by
// scripts/achmage/prepare-kordoc-runtime.mjs. Release builds set HOP_REQUIRE_KORDOC_WEB=1, so a missing worker fails
// the build instead of shipping an app whose document engine cannot start.
const kordocWebWorker = resolve(import.meta.dirname, '../desktop/src-tauri/resources/kordoc-web/engine-worker.js');

function hopFontAssets(): Plugin {
  return {
    name: 'hop-font-assets',
    configureServer(server) {
      server.middlewares.use('/fonts', (req, res, next) => {
        const fontName = basename(decodePath(req.url?.split('?')[0] ?? ''));
        if (!fontName.endsWith('.woff2')) {
          next();
          return;
        }

        const fontPath = resolve(fontAssetsDir, fontName);
        const relativeFontPath = relative(fontAssetsDir, fontPath);
        if (relativeFontPath.startsWith('..') || relativeFontPath === '' || !existsSync(fontPath)) {
          next();
          return;
        }

        res.setHeader('Content-Type', 'font/woff2');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        createReadStream(fontPath).pipe(res);
      });
    },
    closeBundle() {
      const outDir = resolve(import.meta.dirname, 'dist/fonts');
      mkdirSync(outDir, { recursive: true });
      for (const fileName of readdirSync(fontAssetsDir)) {
        const source = resolve(fontAssetsDir, fileName);
        if (!fileName.endsWith('.woff2') || !statSync(source).isFile()) continue;
        copyFileSync(source, resolve(outDir, fileName));
      }
    },
  };
}

function kordocWebWorkerAsset(): Plugin {
  return {
    name: 'achmage-kordoc-web-worker',
    configureServer(server) {
      server.middlewares.use('/kordoc/engine-worker.js', (_req, res, next) => {
        if (!existsSync(kordocWebWorker)) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'text/javascript');
        createReadStream(kordocWebWorker).pipe(res);
      });
    },
    closeBundle() {
      if (!existsSync(kordocWebWorker)) {
        if (process.env.HOP_REQUIRE_KORDOC_WEB === '1') {
          throw new Error('Kordoc WebView worker missing: run scripts/achmage/prepare-kordoc-runtime.mjs first');
        }
        return;
      }
      const outDir = resolve(import.meta.dirname, 'dist/kordoc');
      mkdirSync(outDir, { recursive: true });
      copyFileSync(kordocWebWorker, resolve(outDir, 'engine-worker.js'));
    },
  };
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return '';
  }
}

export default defineConfig({
  base: './',
  plugins: [hopFontAssets(), kordocWebWorkerAsset()],
  build: {
    rollupOptions: {
      // kordoc-host.html: the hidden window that runs the document engine for the Telegram gateway.
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        'kordoc-host': resolve(import.meta.dirname, 'kordoc-host.html'),
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(rhwpWasmPackage.version),
    __HOP_VERSION__: JSON.stringify(desktopConfig.version),
    __ACHMAGE_VERSION__: JSON.stringify(achmageReleaseConfig.version),
  },
  resolve: {
    alias: [
      ...createHopOverrides(hopSrc),
      { find: '@wasm/rhwp.js', replacement: rhwpWasmModule },
      { find: '@/upstream', replacement: resolve(hopSrc, 'upstream') },
      { find: '@upstream', replacement: upstreamSrc },
      { find: '@', replacement: upstreamSrc },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 7700,
    fs: {
      allow: [
        import.meta.dirname,
        rhwpWasmDir,
        fontAssetsDir,
        upstreamStudioDir,
      ],
    },
  },
});
