/**
 * Request signer.
 *
 * FoxESS signs every API call in the browser with a WebAssembly module
 * (`/v2/js/signature.js` + `signature.wasm`). The server currently ignores the
 * `signature` header (a garbage value is accepted), but that is an
 * implementation detail we do not want to depend on: if it is ever enforced we
 * still produce byte-identical signatures, because we run the site's own module.
 *
 * The module is downloaded once and cached on disk. Any failure degrades to a
 * placeholder value instead of breaking the check, since the header is not
 * validated today.
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// The Emscripten module loaded below is CommonJS and calls `require('fs')`.
const nodeRequire = createRequire(import.meta.url);

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PLACEHOLDER = `${'0'.repeat(32)}.1`;

export function createSigner(config, logger) {
  const { signatureMode, signerDir, baseUrl, timeoutMs } = {
    signatureMode: config.foxess.signatureMode,
    signerDir: config.foxess.signerDir,
    baseUrl: config.foxess.baseUrl,
    timeoutMs: config.api.timeoutMs,
  };

  let signerPromise = null;
  let warned = false;
  let mode = signatureMode === 'off' ? 'off' : 'pending';

  function degraded(reason) {
    mode = 'placeholder';
    if (!warned) {
      warned = true;
      logger.warn('signing with a placeholder signature (server does not validate it)', { reason });
    }
    return PLACEHOLDER;
  }

  async function download(url, target) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error(`empty body for ${url}`);
    await mkdir(signerDir, { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, buffer);
    await rename(tmp, target);
    return buffer;
  }

  async function ensureFiles() {
    const jsPath = join(signerDir, 'signature.js');
    const wasmPath = join(signerDir, 'signature.wasm');

    let fresh = false;
    try {
      const [jsStat, wasmStat] = await Promise.all([stat(jsPath), stat(wasmPath)]);
      fresh = Date.now() - Math.min(jsStat.mtimeMs, wasmStat.mtimeMs) < CACHE_TTL_MS;
    } catch {
      fresh = false;
    }

    if (!fresh) {
      await download(`${baseUrl}/v2/js/signature.js`, jsPath);
      await download(`${baseUrl}/v2/js/signature.wasm`, wasmPath);
      logger.debug('signature module downloaded', { dir: signerDir });
    }

    const [source, wasm] = await Promise.all([readFile(jsPath, 'utf8'), readFile(wasmPath)]);
    if (wasm.subarray(0, 4).toString('hex') !== '0061736d') {
      throw new Error('signature.wasm is not a WebAssembly module');
    }
    return { source, wasm };
  }

  /** Instantiates the Emscripten module with the wasm binary injected (no fetches). */
  async function instantiate(source, wasm) {
    const moduleObject = { wasmBinary: wasm };
    let resolveReady;
    const ready = new Promise((resolve) => {
      resolveReady = resolve;
    });
    moduleObject.onRuntimeInitialized = () => resolveReady(moduleObject);

    let runtimes = 0;
    const fakeProcess = {
      ...process,
      on: (event, handler) => {
        // Emscripten installs uncaughtException handlers; keep Node's behaviour.
        if (event === 'uncaughtException' || event === 'unhandledRejection') return fakeProcess;
        process.on(event, handler);
        return fakeProcess;
      },
      removeAllListeners: () => fakeProcess,
    };

    const factory = new Function(
      'Module',
      'require',
      '__dirname',
      'process',
      'module',
      'exports',
      `"use strict";var module={exports:{}};var exports=module.exports;${source}
;return Module;`,
    );
    factory(moduleObject, nodeRequire, signerDir, fakeProcess, { exports: {} }, {});

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('signature wasm init timeout')), 10_000).unref?.(),
    );
    const readyModule = await Promise.race([ready, timeout]);
    runtimes += 1;

    const begin = readyModule.cwrap('begin_signature', 'string', ['string', 'string', 'string', 'string']);
    const end = readyModule.cwrap('end_signature', 'number', ['string']);
    logger.debug('signature module ready', { runtimes });
    return (path, token, lang, timestamp) => {
      const pointer = begin(path, token, lang, String(timestamp));
      try {
        return pointer;
      } finally {
        end(pointer);
      }
    };
  }

  async function init() {
    const { source, wasm } = await ensureFiles();
    return instantiate(source, wasm);
  }

  return {
    get mode() {
      return mode;
    },

    /**
     * @returns {Promise<string>} `md5.signature` shaped value.
     */
    async sign(path, token, lang, timestamp) {
      if (mode === 'off') return PLACEHOLDER;
      if (!signerPromise) {
        signerPromise = init();
      }
      try {
        const fn = await signerPromise;
        mode = 'wasm';
        return fn(path, token || '', lang, timestamp);
      } catch (error) {
        signerPromise = null;
        return degraded(error.message);
      }
    },
  };
}

export const SIGNER_PLACEHOLDER = PLACEHOLDER;
