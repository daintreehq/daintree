import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import type { PtyClient } from "../PtyClient.js";

const mockGetAppWebContents = vi.hoisted(() => vi.fn());

vi.mock("../../window/webContentsRegistry.js", () => ({
  getAppWebContents: mockGetAppWebContents,
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: {
    addProject: vi.fn(),
    getProjectState: vi.fn(),
    removeProject: vi.fn(),
    saveProjectState: vi.fn(),
  },
}));

const rendererCheckResult = {
  readyState: "complete",
  hasRoot: true,
  rootChildCount: 1,
  hasElectronApi: true,
  appVersionType: "string",
  homeDirType: "string",
  tmpDirType: "string",
  projectCount: 0,
};

function createWebContents(loading: boolean) {
  const emitter = new EventEmitter();
  let isLoading = loading;

  return Object.assign(emitter, {
    executeJavaScript: vi.fn().mockResolvedValue(rendererCheckResult),
    isLoading: vi.fn(() => isLoading),
    markLoaded() {
      isLoading = false;
      emitter.emit("did-finish-load");
    },
    failLoad() {
      isLoading = false;
      emitter.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "app://index.html");
    },
  }) as EventEmitter & {
    executeJavaScript: ReturnType<typeof vi.fn>;
    isLoading: ReturnType<typeof vi.fn>;
    markLoaded: () => void;
    failLoad: () => void;
  };
}

function createFailingPtyClient(): PtyClient {
  return {
    on: vi.fn(),
    removeListener: vi.fn(),
    spawn: vi.fn(() => {
      throw new Error("stop after renderer check");
    }),
    write: vi.fn(),
    kill: vi.fn(),
  } as unknown as PtyClient;
}

describe("runSmokeFunctionalChecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("waits for did-finish-load before probing renderer IPC", async () => {
    const wc = createWebContents(true);
    mockGetAppWebContents.mockReturnValue(wc as unknown as WebContents);

    const { runSmokeFunctionalChecks } = await import("../smokeTest.js");
    const resultPromise = runSmokeFunctionalChecks(
      {} as BrowserWindow,
      createFailingPtyClient(),
      () => false
    );

    await Promise.resolve();
    expect(wc.executeJavaScript).not.toHaveBeenCalled();

    wc.markLoaded();

    await expect(resultPromise).resolves.toBe(false);
    expect(wc.executeJavaScript).toHaveBeenCalledOnce();
  });

  it("does not run renderer IPC checks after did-fail-load", async () => {
    const wc = createWebContents(true);
    mockGetAppWebContents.mockReturnValue(wc as unknown as WebContents);

    const { runSmokeFunctionalChecks } = await import("../smokeTest.js");
    const resultPromise = runSmokeFunctionalChecks(
      {} as BrowserWindow,
      createFailingPtyClient(),
      () => false
    );

    wc.failLoad();

    await expect(resultPromise).resolves.toBe(false);
    expect(wc.executeJavaScript).not.toHaveBeenCalled();
  });
});

describe("runSmokeStabilitySoak", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("continues when a transient readiness probe times out and later recovers", async () => {
    const wc = createWebContents(false);
    wc.executeJavaScript
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce("complete");
    mockGetAppWebContents.mockReturnValue(wc as unknown as WebContents);

    const { runSmokeStabilitySoak } = await import("../smokeTest.js");

    await expect(
      runSmokeStabilitySoak({} as BrowserWindow, () => false, {
        durationMs: 2,
        stepMs: 1,
        probeTimeoutMs: 1,
        maxConsecutiveProbeTimeouts: 1,
      })
    ).resolves.toBeUndefined();
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it("fails when readiness probe timeouts exceed the consecutive threshold", async () => {
    const wc = createWebContents(false);
    wc.executeJavaScript.mockImplementation(() => new Promise(() => undefined));
    mockGetAppWebContents.mockReturnValue(wc as unknown as WebContents);

    const { runSmokeStabilitySoak } = await import("../smokeTest.js");

    await expect(
      runSmokeStabilitySoak({} as BrowserWindow, () => false, {
        durationMs: 2,
        stepMs: 1,
        probeTimeoutMs: 1,
        maxConsecutiveProbeTimeouts: 1,
      })
    ).rejects.toThrow("Renderer readiness probe timed out during soak");
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it("fails immediately on unexpected document readiness states", async () => {
    const wc = createWebContents(false);
    wc.executeJavaScript.mockResolvedValue("loading");
    mockGetAppWebContents.mockReturnValue(wc as unknown as WebContents);

    const { runSmokeStabilitySoak } = await import("../smokeTest.js");

    await expect(
      runSmokeStabilitySoak({} as BrowserWindow, () => false, {
        durationMs: 1,
        stepMs: 1,
        probeTimeoutMs: 5,
      })
    ).rejects.toThrow("unexpected document.readyState: loading");
    expect(wc.executeJavaScript).toHaveBeenCalledOnce();
  });
});
