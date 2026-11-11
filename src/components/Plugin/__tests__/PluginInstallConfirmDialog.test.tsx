// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginInstallConfirmDialog } from "../PluginInstallConfirmDialog";
import type { PluginInstallConfirmRequest } from "../PluginInstallConfirmDialog";
import type { LoadedPluginInfo, PluginManifest } from "@shared/types/plugin";

vi.mock("zustand/react/shallow", () => ({ useShallow: (fn: unknown) => fn }));
vi.mock("@/store", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/store/portalStore", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});
vi.mock("@/hooks/useOverlayState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useOverlayState")>()),
  useOverlayState: () => {},
}));
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

/**
 * The shared install disclosure in its URL mode (#16776). An opened archive's
 * behaviour is pinned by `PluginArchiveInstallConfirmDialog.test.tsx`; these
 * cover what a URL install adds: its approval is bound to the installed state
 * the dialog showed.
 */

const EMPTY_CONTRIBUTES: PluginManifest["contributes"] = {
  panels: [],
  toolbarButtons: [],
  menuItems: [],
  commands: [],
  views: [],
  mcpServers: [],
  skills: [],
  keybindings: [],
  contextMenus: [],
  forgeProviders: [],
  fileDecorationProviders: [],
  fileEditors: [],
  agents: [],
  processTools: [],
  recipes: [],
  settings: [],
};

function installedRow(version: string): LoadedPluginInfo {
  return {
    manifest: { name: "acme.tool", version, contributes: EMPTY_CONTRIBUTES },
    instanceId: "acme.tool",
    origin: "global",
    projectId: null,
    dir: "/plugins/acme.tool",
    loadedAt: 0,
    isBuiltin: false,
    source: "url",
    installedAt: 0,
    archiveHash: null,
    originalUrl: "https://example.com/acme.dntr",
    loadError: null,
    disabled: false,
    updateAvailable: null,
    devMode: false,
    pluginDanger: "safe",
    blocklisted: false,
  };
}

function urlRequest(
  overrides: Partial<PluginInstallConfirmRequest> = {}
): PluginInstallConfirmRequest {
  return {
    key: "review-1",
    manifest: {
      name: "acme.tool",
      displayName: "Acme Tool",
      version: "1.2.3",
      category: "other",
      authors: [],
      capabilities: ["shell:exec"],
      recipes: { count: 0, names: [] },
      projectTemplates: [],
      permissionBypassAgents: [],
    },
    source: { kind: "url", label: "example.com/acme.dntr" },
    ...overrides,
  };
}

const list = vi.fn<() => Promise<LoadedPluginInfo[]>>();
const provenanceListeners = new Set<() => void>();
const onConfirm = vi.fn();
const onClose = vi.fn();

function emitProvenanceChanged() {
  act(() => {
    for (const listener of [...provenanceListeners]) listener();
  });
}

/** Drain the lookup's promise chain, which adopts the bridge's promise. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

function elapse(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function confirmButton(): HTMLElement {
  return screen.getByRole("button", { name: "Install plugin" });
}

function isArmed(): boolean {
  return confirmButton().getAttribute("aria-disabled") !== "true";
}

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function renderReview(request: PluginInstallConfirmRequest = urlRequest()) {
  return render(
    <PluginInstallConfirmDialog request={request} onConfirm={onConfirm} onClose={onClose} />
  );
}

describe("PluginInstallConfirmDialog for a URL install", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    provenanceListeners.clear();
    list.mockReset();
    list.mockResolvedValue([]);
    Object.assign(window, {
      electron: {
        plugin: {
          list,
          onProvenanceChanged: (listener: () => void) => {
            provenanceListeners.add(listener);
            return () => provenanceListeners.delete(listener);
          },
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("names the URL it was downloaded from, and promises no replacement", async () => {
    renderReview();
    await settle();

    expect(screen.getByTestId("archive-install-source").textContent).toBe("example.com/acme.dntr");
    expect(screen.getByText(/full Node\.js privileges/)).toBeTruthy();
    // A fresh install is bound to finding nothing installed, so it can't
    // promise to replace whatever turns up under the same id.
    expect(screen.queryByText(/replacing any installed plugin/)).toBeNull();
  });

  it("approves a fresh install as one", async () => {
    renderReview();
    await settle();
    elapse(60_000);

    click(confirmButton());

    expect(onConfirm).toHaveBeenCalledWith({ replacesVersion: null });
  });

  it("approves a replacement with the version it said it replaces", async () => {
    list.mockResolvedValue([installedRow("1.0.0")]);
    renderReview();
    await settle();
    elapse(60_000);

    expect(screen.getByTestId("archive-installed-version").textContent).toContain("v1.0.0");
    click(confirmButton());

    expect(onConfirm).toHaveBeenCalledWith({ replacesVersion: "1.0.0" });
  });

  it("holds the confirm when it can't tell what's installed, until a retry can", async () => {
    list.mockRejectedValue(new Error("host unreachable"));
    renderReview();
    await settle();
    elapse(60_000);

    expect(isArmed()).toBe(false);
    expect(screen.getByText("Couldn't check which version is installed")).toBeTruthy();
    click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();

    list.mockResolvedValue([installedRow("1.0.0")]);
    click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    elapse(60_000);

    expect(screen.queryByText("Couldn't check which version is installed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith({ replacesVersion: "1.0.0" });
  });

  it("re-arms the read-time cooldown when what it would replace changes under it", async () => {
    renderReview();
    await settle();
    elapse(60_000);
    expect(isArmed()).toBe(true);

    // Another window installs the plugin while the review is open.
    list.mockResolvedValue([installedRow("1.0.0")]);
    emitProvenanceChanged();
    await settle();

    expect(screen.getByTestId("archive-installed-version").textContent).toContain("v1.0.0");
    expect(isArmed()).toBe(false);
    click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();

    elapse(60_000);
    click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith({ replacesVersion: "1.0.0" });
  });

  it("keeps an opened archive's copy when the source is a file", async () => {
    renderReview(urlRequest({ source: { kind: "archive", fileName: "acme.dntr" } }));
    await settle();

    expect(screen.getByTestId("archive-install-source").textContent).toBe("acme.dntr");
    expect(screen.getByText(/replacing any installed plugin with the same ID/)).toBeTruthy();
  });
});
