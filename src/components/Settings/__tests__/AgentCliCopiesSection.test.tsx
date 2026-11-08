// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { AgentCliCopy } from "@shared/types/ipc/system";
import { AgentCliCopiesSection } from "../AgentCliCopiesSection";

const getCopies = vi.hoisted(() => vi.fn<(agentId: string) => Promise<AgentCliCopy[]>>());
const chooseCopy = vi.hoisted(() => vi.fn<(agentId: string, path: string) => Promise<void>>());
const resetCopy = vi.hoisted(() => vi.fn<(agentId: string) => Promise<void>>());
const remoteHostName = vi.hoisted(() => ({ current: null as string | null }));

vi.mock("@/clients", () => ({ cliAvailabilityClient: { getCopies, chooseCopy, resetCopy } }));
vi.mock("@/hooks/useSettingsOwner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useSettingsOwner")>()),
  useRemoteHostName: () => remoteHostName.current,
}));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

const launching: AgentCliCopy = { path: "/a/claude", version: "1.0.0", launches: true };
const stale: AgentCliCopy = { path: "/b/claude", version: "2.0.0", launches: false };

function renderSection(overrides: Partial<Parameters<typeof AgentCliCopiesSection>[0]> = {}) {
  const props = {
    agentId: "claude",
    launchPath: "/a/claude",
    isActive: true,
    isRefreshing: false,
    onRefresh: vi.fn(async () => {}),
    onChosen: vi.fn(async () => {}),
    ...overrides,
  };
  return { props, ...render(<AgentCliCopiesSection {...props} />) };
}

/** The settings row holding this path, so a version or marker is checked against its own copy. */
function rowOf(path: string): HTMLElement {
  return screen.getByText(path).closest("[data-settings-row]") as HTMLElement;
}

/** The choice row for this path or for the default. */
function choiceOf(name: string): { radio: HTMLInputElement; row: HTMLElement } {
  const radio = screen.getByRole<HTMLInputElement>("radio", { name });
  return { radio, row: radio.closest("label") as HTMLElement };
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

describe("AgentCliCopiesSection", () => {
  beforeEach(() => {
    getCopies.mockReset();
    chooseCopy.mockReset().mockResolvedValue(undefined);
    resetCopy.mockReset().mockResolvedValue(undefined);
    remoteHostName.current = null;
  });

  it("shows the launching path before its version is read, then the version it reports", async () => {
    const read = deferred<AgentCliCopy[]>();
    getCopies.mockReturnValue(read.promise);
    renderSection();

    expect(screen.getByText("/a/claude")).toBeTruthy();
    expect(screen.getByText("Launches")).toBeTruthy();

    await act(async () => read.resolve([launching]));
    expect(screen.getByText("Reports 1.0.0")).toBeTruthy();
    expect(getCopies).toHaveBeenCalledWith("claude");
  });

  it("anchors the section the duplicate-install toast opens", () => {
    getCopies.mockReturnValue(new Promise(() => {}));
    const { container } = renderSection({ launchPath: undefined });

    expect(container.querySelector("#agents-cli-copies")).toBeTruthy();
    expect(screen.getByText("Checking for copies…")).toBeTruthy();
  });

  it("waits for the launch path rather than reading twice on the way in", async () => {
    getCopies.mockResolvedValue([launching]);
    const { props, rerender } = renderSection({ launchPath: undefined });
    expect(getCopies).not.toHaveBeenCalled();

    rerender(<AgentCliCopiesSection {...props} launchPath="/a/claude" />);

    await screen.findByText("Reports 1.0.0");
    expect(getCopies).toHaveBeenCalledTimes(1);
  });

  it("lists every copy as a choice with its version, marking only the launching one", async () => {
    getCopies.mockResolvedValue([launching, stale]);
    renderSection();

    await screen.findByText("Reports 2.0.0");
    expect(choiceOf("Default").radio.checked).toBe(true);
    expect(within(choiceOf("/a/claude").row).getByText("Reports 1.0.0")).toBeTruthy();
    expect(within(choiceOf("/a/claude").row).getByText("Launches")).toBeTruthy();
    expect(choiceOf("/a/claude").radio.checked).toBe(false);
    expect(within(choiceOf("/b/claude").row).getByText("Reports 2.0.0")).toBeTruthy();
    expect(within(choiceOf("/b/claude").row).queryByText("Launches")).toBeNull();
    expect(screen.getByText(/2 copies found\. Choose which one launches\./)).toBeTruthy();
  });

  describe("choosing which copy launches (#16399)", () => {
    it("asks the host to launch the chosen copy, then reads what launches now", async () => {
      getCopies.mockResolvedValue([launching, stale]);
      const { props } = renderSection();
      await screen.findByText("Reports 2.0.0");

      await act(async () => fireEvent.click(choiceOf("/b/claude").radio));

      expect(chooseCopy).toHaveBeenCalledWith("claude", "/b/claude");
      expect(resetCopy).not.toHaveBeenCalled();
      expect(props.onChosen).toHaveBeenCalledTimes(1);
    });

    it("shows a chosen copy as selected, and goes back to the default on request", async () => {
      getCopies.mockResolvedValue([
        { ...stale, launches: true },
        { ...launching, launches: false },
      ]);
      const { props } = renderSection({ launchPath: "/b/claude", chosenPath: "/b/claude" });
      await screen.findByText("Reports 2.0.0");
      expect(choiceOf("/b/claude").radio.checked).toBe(true);
      expect(choiceOf("Default").radio.checked).toBe(false);

      await act(async () => fireEvent.click(choiceOf("Default").radio));

      expect(resetCopy).toHaveBeenCalledWith("claude");
      expect(chooseCopy).not.toHaveBeenCalled();
      expect(props.onChosen).toHaveBeenCalledTimes(1);
    });

    it("keeps a chosen copy that can't launch selected, and offers the others", async () => {
      getCopies.mockResolvedValue([{ ...launching, launches: false }]);
      renderSection({ launchPath: null, chosenPath: "/gone/claude" });
      await screen.findByText("Reports 1.0.0");

      const chosen = choiceOf("/gone/claude");
      expect(chosen.radio.checked).toBe(true);
      expect(within(chosen.row).getByText(/Not available now/)).toBeTruthy();
      expect(choiceOf("/a/claude").radio.checked).toBe(false);
      expect(choiceOf("Default").radio.checked).toBe(false);
      // Nothing launches until another copy is chosen or the default is back.
      expect(screen.queryByText("Launches")).toBeNull();
    });

    it("offers the way back while nothing else was found", async () => {
      getCopies.mockResolvedValue([]);
      renderSection({ launchPath: null, chosenPath: "/gone/claude" });

      expect(await screen.findByRole("radio", { name: "Default" })).toBeTruthy();
      expect(choiceOf("/gone/claude").radio.checked).toBe(true);
      expect(screen.queryByText(/No copies found/)).toBeNull();
    });

    it("says why a choice didn't take, and retries it", async () => {
      getCopies.mockResolvedValue([launching, stale]);
      chooseCopy.mockRejectedValueOnce(
        new Error("That copy wasn't found on this machine. Re-check and choose again.")
      );
      const { props } = renderSection();
      await screen.findByText("Reports 2.0.0");

      await act(async () => fireEvent.click(choiceOf("/b/claude").radio));

      expect(await screen.findByText(/wasn't found on this machine/)).toBeTruthy();
      expect(props.onChosen).not.toHaveBeenCalled();
      // The selection stays with what actually launches.
      expect(choiceOf("Default").radio.checked).toBe(true);

      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
      expect(chooseCopy).toHaveBeenCalledTimes(2);
      expect(chooseCopy).toHaveBeenLastCalledWith("claude", "/b/claude");
      expect(screen.queryByText(/wasn't found on this machine/)).toBeNull();
      expect(props.onChosen).toHaveBeenCalledTimes(1);
    });

    it("takes one choice at a time", async () => {
      getCopies.mockResolvedValue([launching, stale]);
      const applying = deferred<void>();
      chooseCopy.mockReturnValueOnce(applying.promise);
      renderSection();
      await screen.findByText("Reports 2.0.0");

      await act(async () => fireEvent.click(choiceOf("/b/claude").radio));
      expect(choiceOf("/b/claude").radio.checked).toBe(true);
      expect(choiceOf("/a/claude").radio.disabled).toBe(true);

      await act(async () => applying.resolve());
      expect(choiceOf("/a/claude").radio.disabled).toBe(false);
      expect(chooseCopy).toHaveBeenCalledTimes(1);
    });

    it("reads the copies again once the choice changes what launches", async () => {
      getCopies.mockResolvedValue([launching, stale]);
      const { props, rerender } = renderSection();
      await screen.findByText("Reports 2.0.0");
      expect(getCopies).toHaveBeenCalledTimes(1);

      rerender(<AgentCliCopiesSection {...props} launchPath="/b/claude" chosenPath="/b/claude" />);

      await act(async () => {});
      expect(getCopies).toHaveBeenCalledTimes(2);
    });
  });

  it("adds no description to a single local copy", async () => {
    getCopies.mockResolvedValue([launching]);
    renderSection();

    await screen.findByText("Reports 1.0.0");
    expect(screen.queryByText(/copies found/)).toBeNull();
    expect(screen.queryByText(/^Found/)).toBeNull();
  });

  it("says so when a copy reported no version, and never names an install method", async () => {
    getCopies.mockResolvedValue([{ ...launching, version: null }]);
    const { container } = renderSection();

    await screen.findByText("No version reported");
    expect(container.textContent).not.toMatch(/homebrew|npm|native|installer/i);
  });

  it("names the host in a remote window, since that's where the copies were read", async () => {
    remoteHostName.current = "studio-01";
    getCopies.mockResolvedValue([launching, stale]);
    renderSection();

    expect(await screen.findByText(/2 copies found on studio-01\./)).toBeTruthy();
  });

  it("names the host for a single copy too", async () => {
    remoteHostName.current = "studio-01";
    getCopies.mockResolvedValue([launching]);
    renderSection();

    expect(await screen.findByText("Found on studio-01")).toBeTruthy();
  });

  it("runs nothing while the tab is mounted but hidden, and reads once it's shown", async () => {
    getCopies.mockResolvedValue([launching]);
    const { props, rerender } = renderSection({ isActive: false });
    expect(getCopies).not.toHaveBeenCalled();

    rerender(<AgentCliCopiesSection {...props} isActive />);
    await screen.findByText("Reports 1.0.0");
    expect(getCopies).toHaveBeenCalledTimes(1);
  });

  it("Re-check re-probes first, then shows what the copies report now", async () => {
    getCopies.mockResolvedValueOnce([launching]);
    const order: string[] = [];
    const onRefresh = vi.fn(async () => {
      order.push("refresh");
    });
    renderSection({ onRefresh });
    await screen.findByText("Reports 1.0.0");

    getCopies.mockImplementation(async () => {
      order.push("read");
      return [{ ...launching, version: "1.1.0" }];
    });
    fireEvent.click(screen.getByRole("button", { name: /Re-check/ }));

    await screen.findByText("Reports 1.1.0");
    expect(order).toEqual(["refresh", "read"]);
  });

  it("runs nothing for a page left while its Re-check was running", async () => {
    getCopies.mockResolvedValue([launching]);
    const refresh = deferred<void>();
    const { unmount } = renderSection({ onRefresh: () => refresh.promise });
    await screen.findByText("Reports 1.0.0");
    getCopies.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /Re-check/ }));
    unmount();
    await act(async () => refresh.resolve());

    expect(getCopies).not.toHaveBeenCalled();
  });

  it("reads after the Re-check even when the tab came back while it ran", async () => {
    getCopies.mockResolvedValue([launching]);
    const refresh = deferred<void>();
    const { props, rerender } = renderSection({ onRefresh: () => refresh.promise });
    await screen.findByText("Reports 1.0.0");

    fireEvent.click(screen.getByRole("button", { name: /Re-check/ }));
    rerender(<AgentCliCopiesSection {...props} isActive={false} />);
    rerender(<AgentCliCopiesSection {...props} isActive />);
    await act(async () => {});

    getCopies.mockResolvedValue([{ ...launching, version: "1.1.0" }]);
    await act(async () => refresh.resolve());

    await screen.findByText("Reports 1.1.0");
  });

  it("disables Re-check while a check runs", async () => {
    getCopies.mockResolvedValue([launching]);
    renderSection({ isRefreshing: true });
    await screen.findByText("Reports 1.0.0");

    expect((screen.getByRole("button", { name: /Re-check/ }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("keeps the launching path and offers Retry when the copies can't be read", async () => {
    getCopies.mockRejectedValueOnce(new Error("Host disconnected"));
    renderSection();

    await screen.findByText("Couldn't read the copies of this CLI");
    expect(screen.getByText("/a/claude")).toBeTruthy();

    getCopies.mockResolvedValue([launching]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await screen.findByText("Reports 1.0.0");
    expect(screen.queryByText("Couldn't read the copies of this CLI")).toBeNull();
  });

  it("re-reads when the launching path changes, and ignores the answer it replaced", async () => {
    const first = deferred<AgentCliCopy[]>();
    getCopies.mockReturnValueOnce(first.promise);
    const { props, rerender } = renderSection();

    getCopies.mockResolvedValueOnce([{ path: "/new/claude", version: "3.0.0", launches: true }]);
    rerender(<AgentCliCopiesSection {...props} launchPath="/new/claude" />);
    await screen.findByText("Reports 3.0.0");

    await act(async () => first.resolve([launching]));
    expect(screen.queryByText("/a/claude")).toBeNull();
    expect(within(rowOf("/new/claude")).getByText("Launches")).toBeTruthy();
  });

  it("drops a list that marks the old launching copy, even when the new read fails", async () => {
    getCopies.mockResolvedValueOnce([launching, stale]);
    const { props, rerender } = renderSection();
    await screen.findByText("Reports 2.0.0");

    getCopies.mockRejectedValueOnce(new Error("Host disconnected"));
    rerender(<AgentCliCopiesSection {...props} launchPath="/b/claude" />);

    await screen.findByText("Couldn't read the copies of this CLI");
    expect(screen.queryByText("/a/claude")).toBeNull();
    expect(within(rowOf("/b/claude")).getByText("Launches")).toBeTruthy();
  });

  it("trusts a fresh read over a launch path this page hasn't refetched", async () => {
    // A passive re-check moved the launching copy without this page's details following.
    getCopies.mockResolvedValue([{ path: "/new/claude", version: "3.0.0", launches: true }]);
    renderSection({ launchPath: "/a/claude" });

    await screen.findByText("Reports 3.0.0");
    expect(within(rowOf("/new/claude")).getByText("Launches")).toBeTruthy();
    expect(screen.queryByText("/a/claude")).toBeNull();
  });

  it("keeps a list read for a launch path that arrived during its Re-check", async () => {
    getCopies.mockResolvedValue([launching]);
    const refresh = deferred<void>();
    const { props, rerender } = renderSection({ onRefresh: () => refresh.promise });
    await screen.findByText("Reports 1.0.0");

    const moved = [{ path: "/new/claude", version: "3.0.0", launches: true }];
    getCopies.mockResolvedValue(moved);
    fireEvent.click(screen.getByRole("button", { name: /Re-check/ }));
    rerender(<AgentCliCopiesSection {...props} launchPath="/new/claude" />);
    await act(async () => refresh.resolve());

    await screen.findByText("Reports 3.0.0");
    expect(within(rowOf("/new/claude")).getByText("Launches")).toBeTruthy();
  });

  it("says nothing was found when the agent has no launch path and the read comes back empty", async () => {
    getCopies.mockResolvedValue([]);
    renderSection({ launchPath: null });

    expect(await screen.findByText("No copies found. Re-check after installing.")).toBeTruthy();
  });
});
