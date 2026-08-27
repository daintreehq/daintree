// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevPreviewDestructiveConfirmDialog } from "../DevPreviewDestructiveConfirmDialog";
import type {
  DevPreviewDestructivePreviewMeta,
  DevPreviewDestructivePreviewSizes,
} from "@shared/types/ipc/devPreview";

vi.mock("zustand/react/shallow", () => ({ useShallow: (fn: unknown) => fn }));
vi.mock("@/store", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface ElectronDevPreviewStub {
  getDestructivePreviewMeta: ReturnType<typeof vi.fn>;
  getDestructivePreviewSizes: ReturnType<typeof vi.fn>;
}

function stubDevPreviewIpc(stub: ElectronDevPreviewStub) {
  vi.stubGlobal("window", window);
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: { devPreview: stub },
  });
}

const baseMeta: DevPreviewDestructivePreviewMeta = {
  cwd: "/repo",
  cacheDirs: [
    { relPath: ".next", exists: true, mtimeMs: 1_700_000_000_000 },
    { relPath: ".vite", exists: false, mtimeMs: null },
    { relPath: ".turbo", exists: false, mtimeMs: null },
    { relPath: "node_modules/.vite", exists: false, mtimeMs: null },
  ],
  nodeModules: { relPath: "node_modules", exists: true, mtimeMs: 1_700_000_000_000 },
  packageManager: "npm",
  lockfileName: "package-lock.json",
};

const baseSizes: DevPreviewDestructivePreviewSizes = {
  cacheDirSizes: {
    ".next": 1024 * 1024,
    ".vite": null,
    ".turbo": null,
    "node_modules/.vite": null,
  },
  nodeModulesSizeBytes: 250 * 1024 * 1024,
};

describe("DevPreviewDestructiveConfirmDialog", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the cache-tier title and confirm button before sizes resolve", async () => {
    const sizesDeferred = deferred<DevPreviewDestructivePreviewSizes>();
    stubDevPreviewIpc({
      getDestructivePreviewMeta: vi.fn().mockResolvedValue(baseMeta),
      getDestructivePreviewSizes: vi.fn().mockReturnValue(sizesDeferred.promise),
    });

    render(
      <DevPreviewDestructiveConfirmDialog
        panelId="panel-1"
        projectId="project-1"
        tier="restartAndClearCache"
        isOpen={true}
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );

    expect(screen.getByText("Clear cache and restart?")).toBeTruthy();

    await waitFor(() => {
      expect(screen.getAllByTestId("dev-preview-destructive-cache-row").length).toBe(4);
    });

    const presentRow = screen
      .getAllByTestId("dev-preview-destructive-cache-row")
      .find((row) => row.dataset.relPath === ".next");
    expect(presentRow?.dataset.exists).toBe("true");
    const absentRow = screen
      .getAllByTestId("dev-preview-destructive-cache-row")
      .find((row) => row.dataset.relPath === ".vite");
    expect(absentRow?.dataset.exists).toBe("false");

    // Confirm button is enabled once meta loads, even though sizes haven't resolved yet.
    const confirmBtn = screen.getByRole<HTMLButtonElement>("button", { name: /clear cache/i });
    expect(confirmBtn.hasAttribute("aria-disabled")).toBe(false);

    await act(async () => {
      sizesDeferred.resolve(baseSizes);
    });
  });

  it("calls onConfirm immediately without waiting for sizes", async () => {
    const sizesDeferred = deferred<DevPreviewDestructivePreviewSizes>();
    const onConfirm = vi.fn();
    stubDevPreviewIpc({
      getDestructivePreviewMeta: vi.fn().mockResolvedValue(baseMeta),
      getDestructivePreviewSizes: vi.fn().mockReturnValue(sizesDeferred.promise),
    });

    render(
      <DevPreviewDestructiveConfirmDialog
        panelId="panel-1"
        projectId="project-1"
        tier="restartAndClearCache"
        isOpen={true}
        onClose={() => {}}
        onConfirm={onConfirm}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("dev-preview-destructive-cache-row").length).toBeGreaterThan(0);
    });

    const confirmBtn = screen.getByRole("button", { name: /clear cache/i });
    await act(async () => {
      confirmBtn.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await act(async () => {
      sizesDeferred.resolve(baseSizes);
    });
  });

  it("shows the pnpm caveat and softened reinstall copy when pnpm is detected", async () => {
    const pnpmMeta: DevPreviewDestructivePreviewMeta = {
      ...baseMeta,
      packageManager: "pnpm",
      lockfileName: "pnpm-lock.yaml",
    };

    stubDevPreviewIpc({
      getDestructivePreviewMeta: vi.fn().mockResolvedValue(pnpmMeta),
      getDestructivePreviewSizes: vi.fn().mockResolvedValue(baseSizes),
    });

    render(
      <DevPreviewDestructiveConfirmDialog
        panelId="panel-1"
        projectId="project-1"
        tier="reinstallAndRestart"
        isOpen={true}
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/pnpm store files remain/)).toBeTruthy();
    });

    // Softened pnpm copy replaces the "several minutes" framing.
    expect(screen.getByText(/re-link from the pnpm store/i)).toBeTruthy();
    expect(screen.queryByText(/several minutes/)).toBeNull();

    const installCmd = screen.getByTestId("dev-preview-destructive-install-cmd");
    expect(installCmd.textContent).toContain("pnpm install");
  });

  it("retains the slow reinstall framing for npm", async () => {
    stubDevPreviewIpc({
      getDestructivePreviewMeta: vi.fn().mockResolvedValue(baseMeta),
      getDestructivePreviewSizes: vi.fn().mockResolvedValue(baseSizes),
    });

    render(
      <DevPreviewDestructiveConfirmDialog
        panelId="panel-1"
        projectId="project-1"
        tier="reinstallAndRestart"
        isOpen={true}
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/can take several minutes/)).toBeTruthy();
    });
    expect(screen.queryByText(/pnpm store files remain/)).toBeNull();
  });

  it("blocks confirm when meta errors", async () => {
    const sizesDeferred = deferred<DevPreviewDestructivePreviewSizes>();
    stubDevPreviewIpc({
      getDestructivePreviewMeta: vi.fn().mockRejectedValue(new Error("session not found")),
      getDestructivePreviewSizes: vi.fn().mockReturnValue(sizesDeferred.promise),
    });

    render(
      <DevPreviewDestructiveConfirmDialog
        panelId="panel-1"
        projectId="project-1"
        tier="restartAndClearCache"
        isOpen={true}
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("dev-preview-destructive-meta-error")).toBeTruthy();
    });
    const confirmBtn = screen.getByRole<HTMLButtonElement>("button", { name: /clear cache/i });
    expect(confirmBtn.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      sizesDeferred.resolve(baseSizes);
    });
  });

  it("disables confirm while meta is loading", async () => {
    const metaDeferred = deferred<DevPreviewDestructivePreviewMeta>();
    stubDevPreviewIpc({
      getDestructivePreviewMeta: vi.fn().mockReturnValue(metaDeferred.promise),
      getDestructivePreviewSizes: vi.fn().mockResolvedValue(baseSizes),
    });

    render(
      <DevPreviewDestructiveConfirmDialog
        panelId="panel-1"
        projectId="project-1"
        tier="restartAndClearCache"
        isOpen={true}
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );

    const confirmBtn = screen.getByRole<HTMLButtonElement>("button", { name: /clear cache/i });
    expect(confirmBtn.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      metaDeferred.resolve(baseMeta);
    });

    await waitFor(() => {
      expect(
        screen
          .getByRole<HTMLButtonElement>("button", { name: /clear cache/i })
          .hasAttribute("aria-disabled")
      ).toBe(false);
    });
  });

  it("does not disable confirm when only sizes fail", async () => {
    stubDevPreviewIpc({
      getDestructivePreviewMeta: vi.fn().mockResolvedValue(baseMeta),
      getDestructivePreviewSizes: vi.fn().mockRejectedValue(new Error("disk error")),
    });

    render(
      <DevPreviewDestructiveConfirmDialog
        panelId="panel-1"
        projectId="project-1"
        tier="restartAndClearCache"
        isOpen={true}
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("dev-preview-destructive-cache-row").length).toBeGreaterThan(0);
    });

    const confirmBtn = screen.getByRole<HTMLButtonElement>("button", { name: /clear cache/i });
    expect(confirmBtn.hasAttribute("aria-disabled")).toBe(false);
  });

  it("passes panelId/projectId to both IPC calls and sets skipNodeModules for the cache tier", async () => {
    const metaFn = vi.fn().mockResolvedValue(baseMeta);
    const sizesFn = vi.fn().mockResolvedValue(baseSizes);
    stubDevPreviewIpc({
      getDestructivePreviewMeta: metaFn,
      getDestructivePreviewSizes: sizesFn,
    });

    render(
      <DevPreviewDestructiveConfirmDialog
        panelId="panel-77"
        projectId="project-99"
        tier="restartAndClearCache"
        isOpen={true}
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );

    await waitFor(() => expect(metaFn).toHaveBeenCalled());
    expect(metaFn).toHaveBeenCalledWith({ panelId: "panel-77", projectId: "project-99" });
    expect(sizesFn).toHaveBeenCalledWith({
      panelId: "panel-77",
      projectId: "project-99",
      skipNodeModules: true,
    });
  });

  it("does not skip node_modules for the reinstall tier", async () => {
    const sizesFn = vi.fn().mockResolvedValue(baseSizes);
    stubDevPreviewIpc({
      getDestructivePreviewMeta: vi.fn().mockResolvedValue(baseMeta),
      getDestructivePreviewSizes: sizesFn,
    });

    render(
      <DevPreviewDestructiveConfirmDialog
        panelId="panel-1"
        projectId="project-1"
        tier="reinstallAndRestart"
        isOpen={true}
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );

    await waitFor(() => expect(sizesFn).toHaveBeenCalled());
    expect(sizesFn).toHaveBeenCalledWith({
      panelId: "panel-1",
      projectId: "project-1",
      skipNodeModules: false,
    });
  });

  it("shows 'not present' when nodeModules.exists is false even if a size value is somehow present", async () => {
    const missingMeta: DevPreviewDestructivePreviewMeta = {
      ...baseMeta,
      nodeModules: { relPath: "node_modules", exists: false, mtimeMs: null },
    };
    stubDevPreviewIpc({
      getDestructivePreviewMeta: vi.fn().mockResolvedValue(missingMeta),
      // Pretend a size came back anyway (e.g. TOCTOU between meta + sizes).
      // The UI must still render "not present" to match meta.
      getDestructivePreviewSizes: vi.fn().mockResolvedValue({
        cacheDirSizes: baseSizes.cacheDirSizes,
        nodeModulesSizeBytes: 1_234_567,
      } satisfies DevPreviewDestructivePreviewSizes),
    });

    render(
      <DevPreviewDestructiveConfirmDialog
        panelId="panel-1"
        projectId="project-1"
        tier="reinstallAndRestart"
        isOpen={true}
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("not present")).toBeTruthy();
    });
    expect(screen.queryByText(/1\.2 MB/)).toBeNull();
  });

  it("does not fire IPC calls when projectId is missing", () => {
    const meta = vi.fn().mockResolvedValue(baseMeta);
    const sizes = vi.fn().mockResolvedValue(baseSizes);
    stubDevPreviewIpc({
      getDestructivePreviewMeta: meta,
      getDestructivePreviewSizes: sizes,
    });

    render(
      <DevPreviewDestructiveConfirmDialog
        panelId="panel-1"
        projectId={undefined}
        tier="restartAndClearCache"
        isOpen={true}
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );

    expect(meta).not.toHaveBeenCalled();
    expect(sizes).not.toHaveBeenCalled();
  });
});
