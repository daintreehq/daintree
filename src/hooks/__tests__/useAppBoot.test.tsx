// @vitest-environment jsdom
import { Suspense } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useAppBoot } from "../app/useAppBoot";
import { getBootPromise, getSafeBootPromise, resetBootPromiseForTests } from "@/lib/bootPromise";
import type { BootResult } from "@shared/types/ipc/app";

function makeBootResult(): BootResult {
  return {
    appState: { terminals: [], sidebarWidth: 350 } as BootResult["appState"],
    terminalConfig: {} as BootResult["terminalConfig"],
    project: null,
    agentSettings: {} as BootResult["agentSettings"],
    gpuWebGLHardware: true,
    gpuHardwareAccelerationDisabled: false,
    gpuDisabledReason: null,
    gpuAngleFallbackActive: false,
    safeMode: false,
    isWindowsStore: false,
    settingsRecovery: null,
    projectStateRecovery: null,
    crashPending: null,
    crashConfig: { autoRestoreOnCrash: false },
  };
}

function installElectron(boot: () => Promise<BootResult>) {
  const bootFn = vi.fn(boot);
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      app: { boot: bootFn },
    },
  });
  return bootFn;
}

function clearElectron() {
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetBootPromiseForTests();
});

// The hook is a thin `use(getSafeBootPromise())` wrapper; the boot logic
// (caching, sentinel wrapping, Electron-unavailable, thenable annotation) lives
// in `bootPromise.ts` and is exercised directly here, free of Suspense timing.
describe("bootPromise", () => {
  it("caches the in-flight promise across calls and fires boot() once", () => {
    const bootFn = installElectron(async () => makeBootResult());

    const first = getBootPromise();
    const second = getBootPromise();

    expect(first).toBe(second);
    expect(bootFn).toHaveBeenCalledTimes(1);
  });

  it("resolves getSafeBootPromise to an ok sentinel on success", async () => {
    const result = makeBootResult();
    installElectron(async () => result);

    await expect(getSafeBootPromise()).resolves.toEqual({ ok: true, result });
  });

  it("resolves getSafeBootPromise to an error sentinel when boot rejects", async () => {
    installElectron(async () => {
      throw new Error("boom");
    });

    const safe = await getSafeBootPromise();
    expect(safe.ok).toBe(false);
    if (!safe.ok) {
      expect(safe.error).toBeInstanceOf(Error);
      expect(safe.error.message).toBe("boom");
    }
  });

  it("resolves getSafeBootPromise to an error sentinel when Electron is unavailable", async () => {
    clearElectron();

    const safe = await getSafeBootPromise();
    expect(safe.ok).toBe(false);
    if (!safe.ok) {
      expect(safe.error.message).toBe("Electron unavailable");
    }
  });

  it("annotates the settled promise so use() can read it synchronously", async () => {
    const result = makeBootResult();
    installElectron(async () => result);

    const promise = getSafeBootPromise() as Promise<unknown> & {
      status?: string;
      value?: unknown;
    };
    // Pending until the IPC settles, then annotated with the React Suspense
    // fields use() reads without suspending for a microtask.
    expect(promise.status).toBe("pending");
    await promise;
    expect(promise.status).toBe("fulfilled");
    expect(promise.value).toEqual({ ok: true, result });
  });

  it("re-fires boot() after resetBootPromiseForTests clears the cache", () => {
    const bootFn = installElectron(async () => makeBootResult());

    void getBootPromise();
    resetBootPromiseForTests();
    void getBootPromise();

    expect(bootFn).toHaveBeenCalledTimes(2);
  });

  it("returns a rejected promise instead of throwing when the bridge lacks app.boot", async () => {
    // Truthy `window.electron` (so isElectronAvailable passes) but no `app` —
    // calling `app.boot()` throws synchronously. getBootPromise must not let
    // that escape its module-eval call site.
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {},
    });

    expect(() => getBootPromise()).not.toThrow();
    const safe = await getSafeBootPromise();
    expect(safe.ok).toBe(false);
  });

  it("serves a cached, already-fulfilled safe promise to later callers", async () => {
    installElectron(async () => makeBootResult());

    const first = getSafeBootPromise();
    await first;

    // A later caller (the App render) gets the same reference, already
    // annotated fulfilled — `use()` reads it without suspending.
    const second = getSafeBootPromise() as Promise<unknown> & { status?: string };
    expect(second).toBe(first);
    expect(second.status).toBe("fulfilled");
  });
});

describe("useAppBoot", () => {
  function Probe() {
    const safe = useAppBoot();
    return <div>{safe.ok ? "boot-ok" : `boot-err:${safe.error.message}`}</div>;
  }

  it("reads the ok sentinel synchronously when the boot promise is already settled", async () => {
    installElectron(async () => makeBootResult());
    // Settle (and annotate) the cached promise first; `use()` then reads
    // status="fulfilled" synchronously and renders without a Suspense tick.
    await getSafeBootPromise();

    render(
      <Suspense fallback={<div>boot-loading</div>}>
        <Probe />
      </Suspense>
    );

    expect(screen.getByText("boot-ok")).toBeTruthy();
  });

  it("reads the error sentinel without throwing into an error boundary", async () => {
    installElectron(async () => {
      throw new Error("boom");
    });
    await getSafeBootPromise();

    render(
      <Suspense fallback={<div>boot-loading</div>}>
        <Probe />
      </Suspense>
    );

    expect(screen.getByText("boot-err:boom")).toBeTruthy();
  });
});
