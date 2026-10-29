// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginArchiveInstallConfirmDialog } from "../PluginArchiveInstallConfirmDialog";
import {
  __resetPluginArchiveInstallStoreForTesting,
  usePluginArchiveInstallStore,
} from "@/store/pluginArchiveInstallStore";
import type {
  LoadedPluginInfo,
  PluginArchiveInstallIntent,
  PluginInstallResult,
} from "@shared/types/plugin";

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

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const installFromPath = vi.fn<(p: string) => Promise<PluginInstallResult>>();

function intent(overrides: Partial<PluginArchiveInstallIntent> = {}): PluginArchiveInstallIntent {
  return {
    intentId: "i1",
    archivePath: "/tmp/acme.dntr",
    archiveFileName: "acme.dntr",
    manifest: {
      name: "acme.tool",
      displayName: "Acme Tool",
      version: "1.2.3",
      category: "other",
      authors: [{ name: "Ada Lovelace", role: "maintainer" }],
      capabilities: ["fs:project-read", "network:fetch"],
      recipes: { count: 0, names: [] },
      projectTemplates: [],
    },
    ...overrides,
  };
}

function enqueue(next: PluginArchiveInstallIntent) {
  act(() => usePluginArchiveInstallStore.getState().enqueue(next));
}

function confirmButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Install plugin" }) as HTMLButtonElement;
}

/**
 * Elapse the ConfirmDialog read-time cooldown so the primary button arms.
 * Deliberately advances far past any plausible cooldown rather than mirroring
 * the component's constant — the assertions are about the disabled→enabled
 * transition, not the specific duration.
 */
function armConfirm() {
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
}

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/**
 * Settle the confirm handler's promise chain. `waitFor` polls on real timers
 * and deadlocks under `vi.useFakeTimers()`, so drain the microtask queue
 * explicitly instead — the install mock resolves immediately.
 */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PluginArchiveInstallConfirmDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    __resetPluginArchiveInstallStoreForTesting();
    installFromPath.mockResolvedValue({ status: "installed", pluginId: "acme.tool" });
    Object.assign(window, { electron: { plugin: { installFromPath } } });
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders nothing to decide when the queue is empty", () => {
    render(<PluginArchiveInstallConfirmDialog />);

    expect(screen.queryByRole("button", { name: "Install plugin" })).toBeNull();
  });

  it("previews the archive's real identity and declared capabilities", () => {
    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(intent());

    // Title names the entity, not the file.
    expect(screen.getByText("Install 'Acme Tool'?")).toBeTruthy();
    // The preview shows actual manifest content — not a filename and a count.
    expect(screen.getByText("acme.dntr")).toBeTruthy();
    expect(screen.getByText("acme.tool")).toBeTruthy();
    expect(screen.getByText("v1.2.3")).toBeTruthy();
    expect(screen.getByText("Ada Lovelace (maintainer)")).toBeTruthy();
    // Capabilities render as the detail pane's human-readable permission rows.
    expect(screen.getByText("Read project files")).toBeTruthy();
    expect(screen.getByText("Make network requests")).toBeTruthy();
  });

  it("orders permissions risk-first and flags a shell:exec archive", () => {
    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(
      intent({
        manifest: {
          name: "acme.tool",
          version: "1.2.3",
          category: "other",
          authors: [],
          capabilities: ["fs:project-read", "shell:exec", "network:fetch"],
          recipes: { count: 0, names: [] },
          projectTemplates: [],
        },
      })
    );

    expect(screen.getByText("Can run arbitrary commands on your machine")).toBeTruthy();
    const labels = ["Run shell commands", "Make network requests", "Read project files"].map(
      (label) => screen.getByText(label)
    );
    // danger → warning → neutral, regardless of declaration order.
    expect(
      labels[0]!.compareDocumentPosition(labels[1]!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      labels[1]!.compareDocumentPosition(labels[2]!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("shows the warning strip — and no danger strip — for warning-tier capabilities", () => {
    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(
      intent({
        manifest: {
          name: "acme.tool",
          version: "1.2.3",
          category: "other",
          authors: [],
          capabilities: ["network:fetch", "git:write"],
          recipes: { count: 0, names: [] },
          projectTemplates: [],
        },
      })
    );

    expect(
      screen.getByText("Requests sensitive permissions — review before installing")
    ).toBeTruthy();
    expect(screen.queryByText("Can run arbitrary commands on your machine")).toBeNull();
  });

  it("shows no strip at all when every capability is read-only", () => {
    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(
      intent({
        manifest: {
          name: "acme.tool",
          version: "1.2.3",
          category: "other",
          authors: [],
          capabilities: ["fs:project-read", "clipboard:read"],
          recipes: { count: 0, names: [] },
          projectTemplates: [],
        },
      })
    );

    expect(screen.getByText("Read project files")).toBeTruthy();
    expect(
      screen.queryByText("Requests sensitive permissions — review before installing")
    ).toBeNull();
    expect(screen.queryByText("Can run arbitrary commands on your machine")).toBeNull();
  });

  it("says so explicitly when no authors or capabilities are declared", () => {
    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(
      intent({
        manifest: {
          name: "bare.plugin",
          version: "0.1.0",
          category: "other",
          authors: [],
          capabilities: [],
          recipes: { count: 0, names: [] },
          projectTemplates: [],
        },
      })
    );

    expect(screen.getByText("No authors declared")).toBeTruthy();
    expect(screen.getByText("No special permissions")).toBeTruthy();
  });

  it("falls back to the plugin ID when the manifest declares no display name", () => {
    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(
      intent({
        manifest: {
          name: "bare.plugin",
          version: "0.1.0",
          category: "other",
          authors: [],
          capabilities: [],
          recipes: { count: 0, names: [] },
          projectTemplates: [],
        },
      })
    );

    expect(screen.getByText("Install 'bare.plugin'?")).toBeTruthy();
  });

  it("clamps a hostile display name out of the title but keeps the real ID in the card", () => {
    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(
      intent({
        manifest: {
          name: "sketchy.publisher",
          displayName: "x".repeat(200),
          version: "1.0.0",
          category: "other",
          authors: [],
          capabilities: [],
          recipes: { count: 0, names: [] },
          projectTemplates: [],
        },
      })
    );

    expect(screen.getByText(`Install '${"x".repeat(60)}…'?`)).toBeTruthy();
    expect(screen.getByText("sketchy.publisher")).toBeTruthy();
  });

  it("leaves a display name at exactly the clamp length untouched", () => {
    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(
      intent({
        manifest: {
          name: "sketchy.publisher",
          displayName: "y".repeat(60),
          version: "1.0.0",
          category: "other",
          authors: [],
          capabilities: [],
          recipes: { count: 0, names: [] },
          projectTemplates: [],
        },
      })
    );

    // 60 is the boundary: no ellipsis, nothing dropped.
    expect(screen.getByText(`Install '${"y".repeat(60)}'?`)).toBeTruthy();
  });

  it("renders with a fallback icon when a version-skewed intent carries no category", () => {
    render(<PluginArchiveInstallConfirmDialog />);
    // A replay-buffered payload from an older build predates the `category`
    // field — the dialog must degrade to the fallback tile, not crash.
    enqueue(
      intent({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- deliberately drops `category` to model a pre-upgrade payload
        manifest: {
          name: "old.build",
          version: "1.0.0",
          authors: [],
          capabilities: [],
          recipes: { count: 0, names: [] },
          projectTemplates: [],
        } as unknown as PluginArchiveInstallIntent["manifest"],
      })
    );

    expect(screen.getByText("Install 'old.build'?")).toBeTruthy();
  });

  it("caps the author list instead of rendering every hostile entry", () => {
    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(
      intent({
        manifest: {
          name: "acme.tool",
          version: "1.2.3",
          category: "other",
          authors: Array.from({ length: 10 }, (_, i) => ({ name: `Author ${i + 1}` })),
          capabilities: [],
          recipes: { count: 0, names: [] },
          projectTemplates: [],
        },
      })
    );

    expect(screen.getByText("Author 1, Author 2, Author 3 +7 more")).toBeTruthy();
    // The cap must actually drop the tail, not merely append a count.
    expect(screen.queryByText(/Author 4/)).toBeNull();
  });

  it("keeps the install disabled until the read-time cooldown elapses", () => {
    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(intent());

    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
    click(confirmButton());
    expect(installFromPath).not.toHaveBeenCalled();

    armConfirm();
    expect(confirmButton().hasAttribute("aria-disabled")).toBe(false);
  });

  it("hands the approved archive path to the installer exactly once", async () => {
    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(intent());
    armConfirm();

    click(confirmButton());
    await flush();

    expect(installFromPath).toHaveBeenCalledWith("/tmp/acme.dntr");
    expect(installFromPath).toHaveBeenCalledOnce();
  });

  it("installs nothing when the user cancels", () => {
    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(intent());
    armConfirm();

    click(screen.getByRole("button", { name: "Cancel" }));

    expect(installFromPath).not.toHaveBeenCalled();
    expect(usePluginArchiveInstallStore.getState().current).toBeNull();
  });

  it("promotes the next archive after one is approved, re-arming its cooldown", async () => {
    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(intent());
    enqueue(
      intent({ intentId: "i2", archivePath: "/tmp/beta.dntr", archiveFileName: "beta.dntr" })
    );
    armConfirm();

    click(confirmButton());
    await flush();
    expect(usePluginArchiveInstallStore.getState().current?.intentId).toBe("i2");

    // The promoted item earns its own read time — a click landing now must not
    // approve an archive the user hasn't read.
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
    click(confirmButton());
    expect(installFromPath).toHaveBeenCalledOnce();

    armConfirm();
    click(confirmButton());
    await flush();
    expect(installFromPath).toHaveBeenCalledWith("/tmp/beta.dntr");
  });

  it("a rapid double-click cannot approve the archive queued behind it", async () => {
    let release: ((r: PluginInstallResult) => void) | undefined;
    installFromPath.mockImplementation(
      () =>
        new Promise<PluginInstallResult>((resolve) => {
          release = resolve;
        })
    );

    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(intent());
    enqueue(
      intent({ intentId: "i2", archivePath: "/tmp/beta.dntr", archiveFileName: "beta.dntr" })
    );
    armConfirm();

    // Two native clicks in one batched update — both handlers run against the
    // same render snapshot, mirroring a real double-click.
    act(() => {
      const btn = confirmButton();
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(installFromPath).toHaveBeenCalledOnce();
    expect(installFromPath).toHaveBeenCalledWith("/tmp/acme.dntr");

    await act(async () => {
      release?.({ status: "installed", pluginId: "acme.tool" });
    });
  });

  it("resolves the archive it approved, not whatever is current when it settles", async () => {
    // Regression: resolving "the current intent" meant an install settling after
    // a remount (ErrorBoundary reset) advanced past — and silently discarded —
    // the archive promoted in the meantime.
    let release: ((r: PluginInstallResult) => void) | undefined;
    installFromPath.mockImplementation(
      () =>
        new Promise<PluginInstallResult>((resolve) => {
          release = resolve;
        })
    );

    const { unmount } = render(<PluginArchiveInstallConfirmDialog />);
    enqueue(intent());
    enqueue(
      intent({ intentId: "i2", archivePath: "/tmp/beta.dntr", archiveFileName: "beta.dntr" })
    );
    armConfirm();

    click(confirmButton());
    // The dialog goes away mid-install and comes back — the in-flight promise
    // for i1 outlives the component instance that started it.
    unmount();
    render(<PluginArchiveInstallConfirmDialog />);

    await act(async () => {
      release?.({ status: "installed", pluginId: "acme.tool" });
    });
    await flush();

    // i1 resolved; i2 must still be awaiting its own decision.
    expect(usePluginArchiveInstallStore.getState().current?.intentId).toBe("i2");
  });

  it("keeps the dialog open with the reason when the install fails", async () => {
    installFromPath.mockResolvedValue({
      status: "failed",
      errors: [{ code: "archive_invalid", message: "Archive is corrupt" }],
    } as PluginInstallResult);

    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(intent());
    armConfirm();

    click(confirmButton());
    await flush();

    expect(screen.getByRole("alert").textContent).toContain("Archive is corrupt");
    // Still the current decision — a failed install must not silently advance.
    expect(usePluginArchiveInstallStore.getState().current?.intentId).toBe("i1");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("treats a non-installed result as a failure rather than success", async () => {
    installFromPath.mockResolvedValue({ status: "cancelled" } as PluginInstallResult);

    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(intent());
    armConfirm();

    click(confirmButton());
    await flush();

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(usePluginArchiveInstallStore.getState().current?.intentId).toBe("i1");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("surfaces a thrown install error inline instead of crashing", async () => {
    installFromPath.mockRejectedValue(new Error("IPC channel closed"));

    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(intent());
    armConfirm();

    click(confirmButton());
    await flush();

    expect(screen.getByRole("alert").textContent).toContain("IPC channel closed");
    expect(usePluginArchiveInstallStore.getState().current?.intentId).toBe("i1");
  });

  it("lets the user retry after a failure without reopening the archive", async () => {
    installFromPath.mockResolvedValueOnce({
      status: "failed",
      errors: [{ code: "archive_invalid", message: "Archive is corrupt" }],
    } as PluginInstallResult);

    render(<PluginArchiveInstallConfirmDialog />);
    enqueue(intent());
    armConfirm();

    click(confirmButton());
    await flush();
    expect(screen.getByRole("alert")).toBeTruthy();

    installFromPath.mockResolvedValue({ status: "installed", pluginId: "acme.tool" });
    click(confirmButton());
    await flush();

    expect(usePluginArchiveInstallStore.getState().current).toBeNull();
    expect(installFromPath).toHaveBeenCalledTimes(2);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Plugin installed" })
    );
  });

  describe("contributed recipes", () => {
    const recipeIntent = (count: number) =>
      intent({
        manifest: {
          ...intent().manifest,
          recipes: {
            count,
            names: Array.from({ length: count }, (_, i) => `Recipe ${i}`),
          },
        },
      });

    it("lists every contributed recipe rather than counting a tail (#12001)", () => {
      // A recipe runs shell commands and launches agents, so this D2 confirm is
      // the only place the user reads them before approving. The list used to
      // stop at ten with "+N more" underneath.
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(recipeIntent(24));

      const rendered = Array.from(
        screen.getByTestId("archive-recipe-list").querySelectorAll("li"),
        (li) => li.textContent
      );
      expect(rendered).toEqual(Array.from({ length: 24 }, (_, i) => `Recipe ${i}`));
    });

    it("renders one row per contribution when two recipes share a name", () => {
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(
        intent({
          manifest: {
            ...intent().manifest,
            recipes: { count: 2, names: ["Deploy", "Deploy"] },
          },
        })
      );

      // Two recipes are two things to approve even when they read alike.
      expect(screen.getByTestId("archive-recipe-list").querySelectorAll("li")).toHaveLength(2);
    });

    it("bounds the recipe list in a keyboard-reachable region, not by dropping rows", () => {
      // A scrollable region with no focusable children of its own has to be
      // reachable in its own right (WCAG 2.1.1) — that is what replaced the
      // source-side truncation.
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(recipeIntent(24));

      const list = screen.getByTestId("archive-recipe-list");
      expect(list.getAttribute("tabindex")).toBe("0");
      expect(list.getAttribute("role")).toBe("region");
      expect(list.getAttribute("aria-label")).toContain("24");
    });

    it("renders no recipe block for an archive that contributes none", () => {
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent());

      expect(screen.queryByTestId("archive-recipe-list")).toBeNull();
      expect(screen.queryByText("Recipes")).toBeNull();
    });

    it("agrees in number between the prose and the rows it introduces", () => {
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(recipeIntent(3));

      const list = screen.getByTestId("archive-recipe-list");
      expect(list.querySelectorAll("li")).toHaveLength(3);
      expect(screen.getByText(/Adds 3 launch recipes/)).toBeTruthy();
    });

    it("says 'recipe' for a single contribution", () => {
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(recipeIntent(1));

      expect(screen.getByText(/Adds 1 launch recipe,/)).toBeTruthy();
    });
  });

  describe("an archive for a plugin that's already installed (#15053)", () => {
    const list = vi.fn<() => Promise<LoadedPluginInfo[]>>();
    const provenanceListeners = new Set<() => void>();

    function emitProvenanceChanged() {
      act(() => {
        for (const listener of [...provenanceListeners]) listener();
      });
    }

    function row(version: string, overrides: Record<string, unknown> = {}): LoadedPluginInfo {
      return {
        manifest: { name: "acme.tool", version },
        instanceId: "acme.tool",
        origin: "global",
        projectId: null,
        isBuiltin: false,
        disabled: false,
        devMode: false,
        ...overrides,
      } as unknown as LoadedPluginInfo;
    }

    function deferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    /** Drain the lookup's promise chain, which adopts the bridge's promise. */
    async function settle() {
      await act(async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
    }

    function installedRowText(): string | null {
      return screen.queryByTestId("archive-installed-version")?.textContent ?? null;
    }

    beforeEach(() => {
      provenanceListeners.clear();
      list.mockReset();
      list.mockResolvedValue([]);
      Object.assign(window, {
        electron: {
          plugin: {
            installFromPath,
            list,
            onProvenanceChanged: (listener: () => void) => {
              provenanceListeners.add(listener);
              return () => provenanceListeners.delete(listener);
            },
          },
        },
      });
    });

    it("reads as a fresh install when nothing is installed under the archive's id", async () => {
      list.mockResolvedValue([row("9.9.9", { instanceId: "other.tool" })]);
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent());
      await settle();

      expect(screen.getByText("Install 'Acme Tool'?")).toBeTruthy();
      expect(screen.getByText(/replacing any installed plugin with the same ID/)).toBeTruthy();
      expect(installedRowText()).toBeNull();
      armConfirm();
      expect(confirmButton().hasAttribute("aria-disabled")).toBe(false);
    });

    it("names both versions and calls a newer archive an update", async () => {
      list.mockResolvedValue([row("1.0.0")]);
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent());
      await settle();

      expect(
        screen.getByText(/Installing replaces the installed v1\.0\.0 with this newer v1\.2\.3\./)
      ).toBeTruthy();
      expect(screen.queryByText(/replacing any installed plugin/)).toBeNull();
      expect(installedRowText()).toBe("Replaces installed v1.0.0Update");
    });

    it("calls the same version a reinstall", async () => {
      list.mockResolvedValue([row("1.2.3")]);
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent());
      await settle();

      expect(screen.getByText(/v1\.2\.3 is already installed\./)).toBeTruthy();
      expect(installedRowText()).toBe("Replaces installed v1.2.3Reinstall");
    });

    it("says outright that an older archive is a downgrade", async () => {
      list.mockResolvedValue([row("2.0.0")]);
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent());
      await settle();

      expect(
        screen.getByText(
          /This archive is older than the installed version\. Installing replaces v2\.0\.0 with the older v1\.2\.3\./
        )
      ).toBeTruthy();
      expect(installedRowText()).toBe("Replaces installed v2.0.0Downgrade");
    });

    it("shows both versions without a direction when they can't be ordered", async () => {
      list.mockResolvedValue([row("1.2.3+build.1")]);
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent({ manifest: { ...intent().manifest, version: "1.2.3+build.2" } }));
      await settle();

      expect(
        screen.getByText(
          /Installing replaces the installed v1\.2\.3\+build\.1 with this archive's v1\.2\.3\+build\.2\./
        )
      ).toBeTruthy();
      expect(installedRowText()).toBe("Replaces installed v1.2.3+build.1");
    });

    it("counts a disabled install, since its folder is what gets replaced", async () => {
      list.mockResolvedValue([row("1.0.0", { disabled: true })]);
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent());
      await settle();

      expect(installedRowText()).toBe("Replaces installed v1.0.0Update");
    });

    it("ignores a builtin, a project plugin and a per-project instance sharing the id", async () => {
      list.mockResolvedValue([
        row("9.0.0", { isBuiltin: true }),
        row("9.0.0", { origin: "project", projectId: "p1", instanceId: "project__p1__acme.tool" }),
        row("9.0.0", { projectId: "p1", instanceId: "project__p1__installed__acme.tool" }),
      ]);
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent());
      await settle();

      expect(installedRowText()).toBeNull();
      expect(screen.getByText(/replacing any installed plugin with the same ID/)).toBeTruthy();
    });

    it("holds the confirm past the cooldown until the installed version is known", async () => {
      const pending = deferred<LoadedPluginInfo[]>();
      list.mockReturnValue(pending.promise);
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent());
      armConfirm();

      expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByText("Checking which version is installed…")).toBeTruthy();
      click(confirmButton());
      expect(installFromPath).not.toHaveBeenCalled();

      pending.resolve([row("2.0.0")]);
      await settle();

      expect(confirmButton().hasAttribute("aria-disabled")).toBe(false);
      expect(screen.queryByText("Checking which version is installed…")).toBeNull();
      expect(installedRowText()).toBe("Replaces installed v2.0.0Downgrade");
    });

    it("keeps the hint back for a read that settles quickly", async () => {
      const pending = deferred<LoadedPluginInfo[]>();
      list.mockReturnValue(pending.promise);
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent());
      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(screen.queryByText("Checking which version is installed…")).toBeNull();
      pending.resolve([]);
      await settle();
      armConfirm();
      expect(screen.queryByText("Checking which version is installed…")).toBeNull();
    });

    it("falls back to today's copy and releases the confirm when the read fails", async () => {
      list.mockRejectedValue(new Error("host unreachable"));
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent());
      await settle();
      armConfirm();

      expect(confirmButton().hasAttribute("aria-disabled")).toBe(false);
      expect(screen.getByText(/replacing any installed plugin with the same ID/)).toBeTruthy();
      expect(installedRowText()).toBeNull();
    });

    it("treats a bridge that throws synchronously like a failed read", async () => {
      list.mockImplementation(() => {
        throw new Error("bridge torn down");
      });
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent());
      await settle();
      armConfirm();

      expect(confirmButton().hasAttribute("aria-disabled")).toBe(false);
      expect(installedRowText()).toBeNull();
    });

    it("follows an install or uninstall made elsewhere while it's open", async () => {
      list.mockResolvedValue([row("1.0.0")]);
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent());
      await settle();
      expect(installedRowText()).toBe("Replaces installed v1.0.0Update");

      list.mockResolvedValue([row("1.2.3")]);
      emitProvenanceChanged();
      await settle();
      expect(installedRowText()).toBe("Replaces installed v1.2.3Reinstall");

      list.mockResolvedValue([]);
      emitProvenanceChanged();
      await settle();
      expect(installedRowText()).toBeNull();
    });

    it("keeps the answer it has when a refresh fails", async () => {
      list.mockResolvedValue([row("2.0.0")]);
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent());
      await settle();

      list.mockRejectedValue(new Error("host unreachable"));
      emitProvenanceChanged();
      await settle();

      expect(installedRowText()).toBe("Replaces installed v2.0.0Downgrade");
    });

    it("never lets an older read overwrite a newer one", async () => {
      const first = deferred<LoadedPluginInfo[]>();
      const second = deferred<LoadedPluginInfo[]>();
      list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent());
      await settle();
      emitProvenanceChanged();
      await settle();

      second.resolve([row("2.0.0")]);
      await settle();
      first.resolve([]);
      await settle();

      expect(installedRowText()).toBe("Replaces installed v2.0.0Downgrade");
    });

    it("doesn't re-read while its own install runs, and reads again if it fails", async () => {
      list.mockResolvedValue([row("1.0.0")]);
      const install = deferred<PluginInstallResult>();
      installFromPath.mockReturnValue(install.promise);
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent());
      await settle();
      armConfirm();
      const readsBeforeInstall = list.mock.calls.length;

      click(confirmButton());
      await settle();
      // The install's own provenance push lands before its reply.
      list.mockResolvedValue([row("1.2.3")]);
      emitProvenanceChanged();
      await settle();

      expect(list.mock.calls.length).toBe(readsBeforeInstall);
      expect(installedRowText()).toBe("Replaces installed v1.0.0Update");

      install.resolve({ status: "failed", errors: [{ code: "archive_invalid", message: "Bad" }] });
      await settle();

      expect(list.mock.calls.length).toBeGreaterThan(readsBeforeInstall);
      expect(installedRowText()).toBe("Replaces installed v1.2.3Reinstall");
    });

    it("reads again for the next queued archive of the same plugin", async () => {
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent());
      enqueue(
        intent({
          intentId: "i2",
          archivePath: "/tmp/acme-1.3.0.dntr",
          archiveFileName: "acme-1.3.0.dntr",
          manifest: { ...intent().manifest, version: "1.3.0" },
        })
      );
      await settle();
      expect(installedRowText()).toBeNull();
      armConfirm();

      list.mockResolvedValue([row("1.2.3")]);
      click(confirmButton());
      await settle();

      expect(usePluginArchiveInstallStore.getState().current?.intentId).toBe("i2");
      expect(installedRowText()).toBe("Replaces installed v1.2.3Update");
    });

    it("stops listening once the dialog has nothing to show", async () => {
      render(<PluginArchiveInstallConfirmDialog />);
      enqueue(intent());
      await settle();
      expect(provenanceListeners.size).toBe(1);

      click(screen.getByRole("button", { name: "Cancel" }));
      await settle();

      expect(usePluginArchiveInstallStore.getState().current).toBeNull();
      expect(provenanceListeners.size).toBe(0);
    });
  });
});
