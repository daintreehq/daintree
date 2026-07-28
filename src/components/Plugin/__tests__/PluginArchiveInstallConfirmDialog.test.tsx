// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginArchiveInstallConfirmDialog } from "../PluginArchiveInstallConfirmDialog";
import {
  __resetPluginArchiveInstallStoreForTesting,
  usePluginArchiveInstallStore,
} from "@/store/pluginArchiveInstallStore";
import type { PluginArchiveInstallIntent, PluginInstallResult } from "@shared/types/plugin";

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

    expect(confirmButton().disabled).toBe(true);
    click(confirmButton());
    expect(installFromPath).not.toHaveBeenCalled();

    armConfirm();
    expect(confirmButton().disabled).toBe(false);
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
    expect(confirmButton().disabled).toBe(true);
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
});
