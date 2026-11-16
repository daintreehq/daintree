/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  render: vi.fn<(node: ReactNode) => void>(),
  createRoot: vi.fn(),
  getSafeBootPromise: vi.fn(),
  initHostedViews: vi.fn(),
  reportBootstrapFailure: vi.fn<(error: unknown) => void>(),
  calls: [] as string[],
}));

vi.mock("../lib/trustedTypesPolicy", () => ({}));
vi.mock("../lib/canvasFontWhitespaceShim", () => ({}));
vi.mock("../index.css", () => ({}));
vi.mock("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url", () => ({
  default: "/fonts/jetbrains-mono-latin-400-normal.woff2",
}));
vi.mock("react-dom/client", () => ({ createRoot: mocks.createRoot }));
vi.mock("../theme/applyAppTheme", () => ({ applyDefaultAppTheme: vi.fn() }));
vi.mock("../lib/scrollbarGutter", () => ({
  markScrollbarPlatform: vi.fn(),
  publishScrollbarGutter: vi.fn(),
  watchScrollbarGutter: vi.fn(() => () => {}),
}));
vi.mock("../lib/fontPreload", () => ({ ensureLatin400Preload: vi.fn() }));
vi.mock("../utils/rendererGlobalErrorHandlers", () => ({
  registerRendererGlobalErrorHandlers: vi.fn(() => () => {}),
}));
vi.mock("../utils/rendererSentry", () => ({ initRendererSentry: vi.fn(async () => {}) }));
vi.mock("../utils/reportBootstrapFailure", () => ({
  reportBootstrapFailure: mocks.reportBootstrapFailure,
}));
vi.mock("../services/plugin/pluginDocumentRuntime", () => ({
  installPluginDocumentRuntime: vi.fn(),
}));
vi.mock("../store/pluginHostedViewsStore", () => ({
  usePluginHostedViewsStore: { getState: () => ({ init: mocks.initHostedViews }) },
}));
vi.mock("../lib/bootPromise", () => ({ getSafeBootPromise: mocks.getSafeBootPromise }));
vi.mock("../canopyWindow/CanopyWindowRoot", () => {
  mocks.calls.push("canopy-root-evaluated");
  return { CanopyWindowRoot: function CanopyWindowRoot() {} };
});

function shellScripts(): HTMLScriptElement[] {
  return [...document.head.querySelectorAll("script")].filter((script) =>
    script.src.includes("projectWindow/projectShell")
  );
}

/** The role root inside the `StrictMode` wrapper that was rendered. */
function renderedRoot(): { name: unknown; props: unknown } {
  const strictMode = mocks.render.mock.calls[0]![0];
  if (!isValidElement<{ children?: ReactNode }>(strictMode)) throw new Error("rendered no element");
  const root = strictMode.props.children;
  if (!isValidElement(root)) throw new Error("StrictMode wraps no element");
  return { name: typeof root.type === "function" ? root.type.name : root.type, props: root.props };
}

async function bootMain(): Promise<void> {
  await import("../main");
}

describe("src/main.tsx role routing", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.calls.length = 0;
    mocks.render.mockReset();
    mocks.createRoot.mockReset().mockImplementation(() => {
      mocks.calls.push("createRoot");
      return { render: mocks.render };
    });
    mocks.getSafeBootPromise.mockReset().mockImplementation(() => {
      mocks.calls.push("app:boot");
      return Promise.resolve(null);
    });
    mocks.initHostedViews.mockReset().mockImplementation(() => {
      mocks.calls.push("hosted-views-init");
    });
    mocks.reportBootstrapFailure.mockReset();
    document.head.innerHTML = "";
    document.body.innerHTML = '<div id="startup-skeleton"></div><div id="root"></div>';
  });

  afterEach(() => {
    delete window.__DAINTREE_SURFACE_HOST__;
    delete window.__DAINTREE_CANOPY_WINDOW__;
  });

  it("mounts the surface host root without the project shell", async () => {
    window.__DAINTREE_SURFACE_HOST__ = { surfaceId: "surface-1" };

    await bootMain();
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));

    expect(renderedRoot()).toEqual({ name: "SurfaceHostRoot", props: { surfaceId: "surface-1" } });
    expect(shellScripts()).toEqual([]);
    expect(mocks.calls).toEqual(["app:boot", "createRoot"]);
    expect(document.getElementById("startup-skeleton")).toBeNull();
    expect(mocks.reportBootstrapFailure).not.toHaveBeenCalled();
  });

  it("lets the surface-host role win when the Canopy flag is also set", async () => {
    window.__DAINTREE_SURFACE_HOST__ = { surfaceId: "surface-2" };
    window.__DAINTREE_CANOPY_WINDOW__ = true;

    await bootMain();
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));

    expect(renderedRoot()).toEqual({ name: "SurfaceHostRoot", props: { surfaceId: "surface-2" } });
    expect(mocks.calls).not.toContain("canopy-root-evaluated");
    expect(mocks.initHostedViews).not.toHaveBeenCalled();
  });

  it("mounts the Canopy root, listening for hosted views first, without the project shell", async () => {
    window.__DAINTREE_CANOPY_WINDOW__ = true;

    await bootMain();
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));

    expect(renderedRoot().name).toBe("CanopyWindowRoot");
    expect(shellScripts()).toEqual([]);
    expect(mocks.calls).toEqual([
      "app:boot",
      "hosted-views-init",
      "canopy-root-evaluated",
      "createRoot",
    ]);
    expect(mocks.reportBootstrapFailure).not.toHaveBeenCalled();
  });

  it("loads the project shell through a module script and leaves app:boot to it", async () => {
    await bootMain();

    // Inserted synchronously while the entry evaluates, so the element holds
    // the load event from the start.
    const [script] = shellScripts();
    expect(shellScripts()).toHaveLength(1);
    expect(script!.type).toBe("module");
    expect(new URL(script!.src).pathname).toBe("/src/projectWindow/projectShell.tsx");
    expect(mocks.getSafeBootPromise).not.toHaveBeenCalled();
    expect(mocks.createRoot).not.toHaveBeenCalled();
    expect(mocks.initHostedViews).not.toHaveBeenCalled();
    expect(document.getElementById("startup-skeleton")).not.toBeNull();
  });

  it("reports a bootstrap failure when the project shell fails to load", async () => {
    await bootMain();

    shellScripts()[0]!.dispatchEvent(new Event("error"));

    expect(mocks.reportBootstrapFailure).toHaveBeenCalledTimes(1);
    const [error] = mocks.reportBootstrapFailure.mock.calls[0]!;
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining("/src/projectWindow/projectShell.tsx")
    );
  });
});
