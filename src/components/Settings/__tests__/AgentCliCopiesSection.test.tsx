// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentCliCopy } from "@shared/types/ipc/system";
import { AgentCliCopiesSection } from "../AgentCliCopiesSection";

const getCopies = vi.hoisted(() => vi.fn<(agentId: string) => Promise<AgentCliCopy[]>>());
const remoteHostName = vi.hoisted(() => ({ current: null as string | null }));

vi.mock("@/clients", () => ({ cliAvailabilityClient: { getCopies } }));
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
    ...overrides,
  };
  return { props, ...render(<AgentCliCopiesSection {...props} />) };
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
    const { container } = renderSection({ launchPath: null });

    expect(container.querySelector("#agents-cli-copies")).toBeTruthy();
  });

  it("lists every copy with its path and version, and marks only the launching one", async () => {
    getCopies.mockResolvedValue([launching, stale]);
    renderSection();

    await screen.findByText("Reports 2.0.0");
    expect(screen.getByText("/a/claude")).toBeTruthy();
    expect(screen.getByText("Reports 1.0.0")).toBeTruthy();
    expect(screen.getByText("/b/claude")).toBeTruthy();
    expect(screen.getAllByText("Launches")).toHaveLength(1);
    expect(screen.getByText(/2 copies found\. Daintree launches the marked one\./)).toBeTruthy();
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
    await waitFor(() => expect(screen.queryByText("/a/claude")).toBeNull());
    expect(screen.getByText("/new/claude")).toBeTruthy();
  });

  it("says nothing was found when the read comes back empty with no known path", async () => {
    getCopies.mockResolvedValue([]);
    renderSection({ launchPath: null });

    expect(await screen.findByText("No copies found. Re-check after installing.")).toBeTruthy();
  });
});
