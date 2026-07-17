// In production, `enforceIpcSenderValidation()` is called once at startup and
// flips a guard flag that all IPC handler registrations assert against. Unit
// tests don't run that bootstrap path, so we mark the guard ready here. Tests
// that need to verify the throwing behavior (e.g. `ipcGuard.test.ts`) reset
// the flag explicitly via `_resetIpcGuardForTesting()`.

import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { markIpcSecurityReady } from "./electron/ipc/ipcGuard.js";
import { primeRadix } from "./src/components/ui/radix-loader";

markIpcSecurityReady();

// `hardenedGit` resolves an app-owned `core.hooksPath` from DAINTREE_USER_DATA,
// falling back to the real home directory when nothing else is available. Any
// test that builds a git factory would otherwise create `~/.daintree/git-hooks`
// on the developer's machine. Point it at a temp root instead; suites that
// inspect the directory (hardenedGit's own) override this with their own
// mkdtemp before their first factory call.
//
// Assigned unconditionally: an inherited empty or relative value would survive
// `??=` and land right back on the home directory, and an inherited real
// userData path would let a test suite write into the developer's own app data.
// Keyed by pid so a stale hook file from an earlier run can't be dispatched by
// a later one.
process.env.DAINTREE_USER_DATA = path.join(os.tmpdir(), `daintree-vitest-userdata-${process.pid}`);

// Tests render Radix wrappers synchronously, but our production wrappers
// dynamic-import the Radix primitive chunk on demand. Prime the loader once
// at setup so the module-level cache is populated and wrappers render Radix
// content synchronously throughout the suite.
await primeRadix();

// jsdom does not implement Trusted Types. The renderer policy module
// (`src/lib/trustedTypesPolicy.ts`) throws at import time if
// `window.trustedTypes` is missing, which breaks any jsdom test that
// transitively imports a chip widget or FileViewerModal. Install a minimal
// pass-through stub so unrelated test files don't have to mock the module.
// Tests that exercise the throw branch (`trustedTypesPolicy.test.ts`)
// override this stub per-test via `vi.stubGlobal`. See #6392.
if (typeof globalThis !== "undefined") {
  const g = globalThis as { trustedTypes?: unknown };
  if (!g.trustedTypes) {
    g.trustedTypes = {
      createPolicy: (_name: string, options: { createHTML?: (s: string) => string }) => ({
        createHTML: (input: string) => options.createHTML?.(input) ?? input,
      }),
    };
  }
}

// node env does not implement requestAnimationFrame/cancelAnimationFrame.
// Several renderer-side modules (TerminalWebGLManager, etc.) schedule work via
// rAF in production. Install a sync default that runs the callback inline so
// tests retain synchronous expectations without each file repeating the shim.
// Tests that exercise rAF pacing explicitly override these globals locally.
//
// Use `vi.stubGlobal` rather than a raw `globalThis` assignment: forks-pool
// workers are reused across files, and a raw shim installed while a node-env
// file runs gets adopted as the "original" global by the next file's jsdom
// environment setup, then restored on its teardown — permanently shadowing
// jsdom's async rAF for every later jsdom file in that worker (which made
// async-effect renders flush in the wrong order, e.g. PluginSettingsForm's
// reveal-secret control intermittently missing). Stubbed globals are tracked
// and cleared by vitest between files, so the shim can't leak across the
// node→jsdom boundary.
if (typeof globalThis.requestAnimationFrame !== "function") {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    cb(0);
    return 0;
  });
}
if (typeof globalThis.cancelAnimationFrame !== "function") {
  vi.stubGlobal("cancelAnimationFrame", () => {});
}

// Node 25 exposes a broken native `localStorage` stub on `globalThis` (no
// `clear`/`getItem`/etc) that shadows JSDOM's Storage and leaks the warning
// `--localstorage-file was provided without a valid path`. JSDOM's env setup
// skips configurable:false globals, so we install an in-memory Storage shim
// in jsdom contexts that need a working Storage. Detect the broken stub by
// checking for a missing `getItem` method.
if (typeof window !== "undefined") {
  const candidate = (globalThis as { localStorage?: Storage }).localStorage;
  const isBroken = !candidate || typeof candidate.getItem !== "function";
  if (isBroken) {
    const data = new Map<string, string>();
    const memoryStorage: Storage = {
      get length() {
        return data.size;
      },
      clear() {
        data.clear();
      },
      getItem(key: string) {
        return data.has(key) ? (data.get(key) ?? null) : null;
      },
      setItem(key: string, value: string) {
        data.set(key, String(value));
      },
      removeItem(key: string) {
        data.delete(key);
      },
      key(index: number) {
        return Array.from(data.keys())[index] ?? null;
      },
    };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: memoryStorage,
    });
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      writable: true,
      value: memoryStorage,
    });
  }
}

// xterm 6.1's DOM renderer eagerly builds a WidthCache on `terminal.open()`,
// which creates a <canvas> and requires a 2d context to measure glyph widths.
// jsdom returns null from getContext, so xterm's `throwIfFalsy` aborts the open
// (#9540 bump). Install a minimal 2d-context stub so unit tests that open a real
// Terminal don't crash. Width values are not meaningful under jsdom — these
// tests assert lifecycle behavior, not layout. jsdom recreates
// HTMLCanvasElement per test file, so this can't leak across the node↔jsdom
// boundary; node-env files skip via the guard.
if (typeof HTMLCanvasElement !== "undefined") {
  const make2dContextStub = (canvas: HTMLCanvasElement): unknown => ({
    canvas,
    font: "",
    fillStyle: "",
    strokeStyle: "",
    textBaseline: "",
    measureText: (text: string) => ({ width: text.length * 8 }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4),
      width: w,
      height: h,
    }),
    fillRect: () => {},
    clearRect: () => {},
    fillText: () => {},
    strokeText: () => {},
    setTransform: () => {},
    scale: () => {},
    translate: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
  });
  HTMLCanvasElement.prototype.getContext = function getContext(
    this: HTMLCanvasElement,
    contextId: string
  ): unknown {
    return contextId === "2d" ? make2dContextStub(this) : null;
  } as typeof HTMLCanvasElement.prototype.getContext;
}
