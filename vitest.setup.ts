// In production, `enforceIpcSenderValidation()` is called once at startup and
// flips a guard flag that all IPC handler registrations assert against. Unit
// tests don't run that bootstrap path, so we mark the guard ready here. Tests
// that need to verify the throwing behavior (e.g. `ipcGuard.test.ts`) reset
// the flag explicitly via `_resetIpcGuardForTesting()`.

import { markIpcSecurityReady } from "./electron/ipc/ipcGuard.js";
import { primeRadix } from "./src/components/ui/radix-loader";

markIpcSecurityReady();

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

// jsdom does not implement window.matchMedia. Several renderer components
// (InlineStatusBanner, etc.) call it at render time to check reduced-motion
// preferences. Install a stub that returns a no-preference match so tests
// render the animated path by default.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// node env does not implement requestAnimationFrame/cancelAnimationFrame.
// Several renderer-side modules (TerminalWebGLManager, etc.) schedule work via
// rAF in production. Install a sync default that runs the callback inline so
// tests retain synchronous expectations without each file repeating the shim.
// Tests that exercise rAF pacing explicitly override these globals locally.
if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    cb(0);
    return 0;
  }) as typeof globalThis.requestAnimationFrame;
}
if (typeof globalThis.cancelAnimationFrame !== "function") {
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
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
