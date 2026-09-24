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

    // Only present directories get a row; the absent ones are still named.
    await waitFor(() => {
      expect(screen.getAllByTestId("dev-preview-destructive-cache-row").length).toBe(1);
    });
    const [presentRow] = screen.getAllByTestId("dev-preview-destructive-cache-row");
    expect(presentRow!.dataset.relPath).toBe(".next");
    const absent = screen.getByTestId("dev-preview-destructive-cache-absent").textContent ?? "";
    for (const relPath of [".vite", ".turbo", "node_modules/.vite"]) {
      expect(absent).toContain(relPath);
    }

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
      expect(screen.getByText(/pnpm store keeps the files/)).toBeTruthy();
    });

    // Softened pnpm copy replaces the "several minutes" framing.
    expect(screen.getByText(/re-linked from the pnpm store/i)).toBeTruthy();
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
    expect(screen.queryByText(/pnpm store keeps the files/)).toBeNull();
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

  it("says nothing is deleted when nodeModules.exists is false even if a size value is somehow present", async () => {
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
      expect(screen.getByText(/Nothing, node_modules isn't there/)).toBeTruthy();
    });
    expect(screen.queryByText(/1\.2 MB/)).toBeNull();
    expect(screen.queryByTestId("dev-preview-destructive-node-modules-path")).toBeNull();
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

  describe("the copy follows what the preview found", () => {
    const DELETION_CLAIM = /\b(delete|deleted|deletes|clear|cleared|reinstall)\b/i;

    function renderTier(tier: "restartAndClearCache" | "reinstallAndRestart") {
      render(
        <DevPreviewDestructiveConfirmDialog
          panelId="panel-1"
          projectId="project-1"
          tier={tier}
          isOpen={true}
          onClose={() => {}}
          onConfirm={() => {}}
        />
      );
    }

    function confirmButton(): HTMLElement {
      return document.querySelector<HTMLElement>('[data-confirm-role="confirm"]')!;
    }

    it("never promises a deletion when no cache directory exists", async () => {
      stubDevPreviewIpc({
        getDestructivePreviewMeta: vi.fn().mockResolvedValue({
          ...baseMeta,
          cacheDirs: baseMeta.cacheDirs.map((d) => ({ ...d, exists: false, mtimeMs: null })),
        }),
        getDestructivePreviewSizes: vi.fn().mockResolvedValue(baseSizes),
      });
      renderTier("restartAndClearCache");

      await waitFor(() => {
        expect(screen.getByTestId("dev-preview-destructive-cache-none")).toBeTruthy();
      });
      expect(confirmButton().textContent).not.toMatch(DELETION_CLAIM);
      expect(screen.getByRole("heading", { level: 2 }).textContent).not.toMatch(DELETION_CLAIM);
      const description = document.getElementById(
        document.querySelector('[role="dialog"]')!.getAttribute("aria-describedby")!
      );
      expect(description?.textContent).not.toMatch(/\bare deleted\b|\bwill be deleted\b/i);
    });

    it("never promises a deletion when node_modules is missing", async () => {
      stubDevPreviewIpc({
        getDestructivePreviewMeta: vi.fn().mockResolvedValue({
          ...baseMeta,
          nodeModules: { relPath: "node_modules", exists: false, mtimeMs: null },
        }),
        getDestructivePreviewSizes: vi.fn().mockResolvedValue(baseSizes),
      });
      renderTier("reinstallAndRestart");

      await waitFor(() => {
        expect(screen.getByTestId("dev-preview-destructive-install-cmd")).toBeTruthy();
      });
      expect(confirmButton().textContent).not.toMatch(DELETION_CLAIM);
      expect(screen.getByRole("heading", { level: 2 }).textContent).not.toMatch(DELETION_CLAIM);
    });

    it("names the deletion in the button whenever something will be deleted", async () => {
      stubDevPreviewIpc({
        getDestructivePreviewMeta: vi.fn().mockResolvedValue(baseMeta),
        getDestructivePreviewSizes: vi.fn().mockResolvedValue(baseSizes),
      });
      renderTier("restartAndClearCache");
      await waitFor(() => {
        expect(screen.getAllByTestId("dev-preview-destructive-cache-row").length).toBeGreaterThan(
          0
        );
      });
      expect(confirmButton().textContent).toMatch(DELETION_CLAIM);
    });
  });

  it("wraps paths only at separators and keeps the full path", async () => {
    const cwd = "/Users/you/code/clients/northwind-traders/packages/storefront-web-app";
    stubDevPreviewIpc({
      getDestructivePreviewMeta: vi.fn().mockResolvedValue({ ...baseMeta, cwd }),
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

    const path = await screen.findByTestId("dev-preview-destructive-node-modules-path");
    expect(path.textContent).toBe(`${cwd}/node_modules`);
    const breaks = path.querySelectorAll("wbr");
    expect(breaks.length).toBeGreaterThan(0);
    for (const wbr of breaks) {
      expect(wbr.previousSibling?.textContent).toMatch(/[/\\]$/);
    }
  });

  it("totals the present caches once every size is known, and says so when it can't", async () => {
    const meta: DevPreviewDestructivePreviewMeta = {
      ...baseMeta,
      cacheDirs: [
        { relPath: ".next", exists: true, mtimeMs: 1_700_000_000_000 },
        { relPath: ".turbo", exists: true, mtimeMs: 1_700_000_000_000 },
        { relPath: ".vite", exists: false, mtimeMs: null },
      ],
    };
    const sizes: DevPreviewDestructivePreviewSizes = {
      cacheDirSizes: { ".next": 3 * 1024 * 1024, ".turbo": 1024 * 1024, ".vite": null },
      nodeModulesSizeBytes: null,
    };
    stubDevPreviewIpc({
      getDestructivePreviewMeta: vi.fn().mockResolvedValue(meta),
      getDestructivePreviewSizes: vi.fn().mockResolvedValue(sizes),
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
    await waitFor(() => expect(screen.getByText("4 MB")).toBeTruthy());

    cleanup();
    stubDevPreviewIpc({
      getDestructivePreviewMeta: vi.fn().mockResolvedValue(meta),
      getDestructivePreviewSizes: vi.fn().mockRejectedValue(new Error("EACCES")),
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
    await waitFor(() => expect(screen.getAllByText("Unknown").length).toBe(3));
  });

  it("locks Cancel while the confirmed operation runs", async () => {
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
        isConfirming={true}
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );
    const cancel = document.querySelector('[data-confirm-role="cancel"]');
    expect(cancel?.getAttribute("aria-disabled")).toBe("true");
  });

  it("never promises the install leaves the working tree alone", async () => {
    for (const lockfileName of ["package-lock.json", null]) {
      stubDevPreviewIpc({
        getDestructivePreviewMeta: vi.fn().mockResolvedValue({ ...baseMeta, lockfileName }),
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
      await screen.findByTestId("dev-preview-destructive-install-cmd");
      const description = document.getElementById(
        document.querySelector('[role="dialog"]')!.getAttribute("aria-describedby")!
      )!.textContent!;
      expect(description).not.toMatch(/git state/i);
      expect(description).toMatch(lockfileName ?? /lockfile/);
      cleanup();
    }
  });

  it("announces the preview once it settles, and says when sizes couldn't be measured", async () => {
    const sizesDeferred = deferred<DevPreviewDestructivePreviewSizes>();
    stubDevPreviewIpc({
      getDestructivePreviewMeta: vi.fn().mockResolvedValue(baseMeta),
      getDestructivePreviewSizes: vi.fn().mockReturnValue(sizesDeferred.promise),
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
    const status = screen.getByTestId("dev-preview-destructive-status");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("");

    await waitFor(() => expect(status.textContent).toMatch(/ready/i));
    expect(
      screen.getByTestId("dev-preview-destructive-reinstall-preview").getAttribute("aria-busy")
    ).toBe("true");

    await act(async () => {
      sizesDeferred.reject(new Error("EACCES"));
    });
    await waitFor(() => expect(status.textContent).toMatch(/couldn't be measured/i));
    expect(
      screen.getByTestId("dev-preview-destructive-reinstall-preview").hasAttribute("aria-busy")
    ).toBe(false);
  });
});
