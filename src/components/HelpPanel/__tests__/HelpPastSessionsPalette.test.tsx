// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HelpPastSession, HelpPastSessionsListing } from "@shared/types/ipc/help";

const dispatch = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ ok: true, result: { outcome: "resumed" } }))
);
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function matchMediaStub(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("matchMedia", matchMediaStub);
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

afterAll(() => {
  vi.unstubAllGlobals();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

const { HelpPastSessionsPalette } = await import("../HelpPastSessionsPalette");
const { usePaletteStore } = await import("@/store/paletteStore");
const { TooltipProvider } = await import("@/components/ui/tooltip");

const listPastSessions =
  vi.fn<
    (
      projectId: string,
      options?: { listing?: boolean }
    ) => Promise<HelpPastSessionsListing | HelpPastSession[]>
  >();

const session = (sessionId: string, title: string, updatedAt = 1): HelpPastSession => ({
  agentId: "claude",
  sessionId,
  title,
  updatedAt,
});
const listing = (overrides: Partial<HelpPastSessionsListing> = {}): HelpPastSessionsListing => ({
  sessions: [],
  unreadable: [],
  truncated: false,
  ...overrides,
});

function renderPalette() {
  const view = render(<HelpPastSessionsPalette workspace={{ id: "p1" }} tabs={[]} />, {
    wrapper: TooltipProvider,
  });
  act(() => usePaletteStore.getState().openPalette("assistant-sessions"));
  return view;
}

const input = () => screen.getByRole("combobox") as HTMLInputElement;
const retryButton = () => screen.queryByRole("button", { name: "Retry" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  listPastSessions.mockReset();
  dispatch.mockClear();
  Object.defineProperty(window, "electron", {
    value: { help: { listPastSessions } },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  act(() => usePaletteStore.getState().closePalette("assistant-sessions"));
});

describe("HelpPastSessionsPalette", () => {
  it("keeps the plain empty state for a project with no history at all", async () => {
    listPastSessions.mockResolvedValue(listing());
    renderPalette();

    expect(await screen.findByText("No past sessions yet")).toBeTruthy();
    expect(retryButton()).toBeNull();
    expect(screen.queryByText(/most recent/)).toBeNull();
    expect(input().placeholder).toMatch(/titles/i);
  });

  it("says which store couldn't be read instead of reporting no history", async () => {
    listPastSessions.mockResolvedValue(listing({ unreadable: ["codex"] }));
    renderPalette();

    expect(await screen.findByText("Couldn't read Codex history")).toBeTruthy();
    expect(screen.queryByText("No past sessions yet")).toBeNull();
    expect(retryButton()).not.toBeNull();
  });

  it("lists what did load beside the failure, and retries from the button", async () => {
    listPastSessions
      .mockResolvedValueOnce(
        listing({ sessions: [session("a", "Fix the build")], unreadable: ["codex"] })
      )
      .mockResolvedValueOnce(
        listing({ sessions: [session("a", "Fix the build"), session("b", "Codex answer")] })
      );
    renderPalette();

    expect(await screen.findByText("Fix the build")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Couldn't read Codex history");

    fireEvent.click(retryButton()!);

    expect(await screen.findByText("Codex answer")).toBeTruthy();
    expect(listPastSessions).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Couldn't read Codex history")).toBeNull();
    expect(retryButton()).toBeNull();
  });

  it("asks for the listing, not the bare rows an older shell gets", async () => {
    listPastSessions.mockResolvedValue(listing());
    renderPalette();
    await screen.findByText("No past sessions yet");

    expect(listPastSessions).toHaveBeenCalledWith("p1", { listing: true });
  });

  it("retries on Enter when nothing listed, and says so to the field", async () => {
    listPastSessions
      .mockResolvedValueOnce(listing({ unreadable: ["claude"] }))
      .mockResolvedValueOnce(listing({ sessions: [session("b", "Back")] }));
    renderPalette();
    await screen.findByText("Couldn't read Claude history");

    const hintId = input().getAttribute("aria-describedby");
    expect(hintId && document.getElementById(hintId)?.textContent).toBe("Press Enter to retry");
    expect(document.querySelectorAll(`[id="${hintId}"]`)).toHaveLength(1);

    fireEvent.keyDown(input(), { key: "Enter" });
    expect(await screen.findByText("Back")).toBeTruthy();
    expect(listPastSessions).toHaveBeenCalledTimes(2);
    expect(input().getAttribute("aria-describedby")).toBeNull();
  });

  it("resumes the selected row on Enter even beside a failure", async () => {
    listPastSessions.mockResolvedValue(
      listing({ sessions: [session("a", "Fix the build")], unreadable: ["codex"] })
    );
    renderPalette();
    await screen.findByText("Fix the build");
    await waitFor(() => expect(retryButton()?.hasAttribute("disabled")).toBe(false));

    fireEvent.keyDown(input(), { key: "Enter" });

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch.mock.calls[0]?.[1]).toEqual({ agentId: "claude", sessionId: "a" });
    expect(listPastSessions).toHaveBeenCalledTimes(1);
  });

  it("keeps the rows an earlier answer gave when a refresh is rejected", async () => {
    listPastSessions
      .mockResolvedValueOnce(
        listing({ sessions: [session("a", "Still here")], unreadable: ["codex"] })
      )
      .mockRejectedValueOnce(new Error("ipc down"));
    renderPalette();
    await screen.findByText("Still here");
    await waitFor(() => expect(retryButton()?.hasAttribute("disabled")).toBe(false));

    fireEvent.click(retryButton()!);

    expect(await screen.findByText("Couldn't load past sessions")).toBeTruthy();
    expect(screen.getByText("Still here")).toBeTruthy();
  });

  it("holds Retry while a reopening's own request is still out", async () => {
    const reopened = deferred<HelpPastSessionsListing>();
    listPastSessions
      .mockResolvedValueOnce(listing({ unreadable: ["codex"] }))
      .mockReturnValueOnce(reopened.promise);
    renderPalette();
    await screen.findByText("Couldn't read Codex history");

    act(() => usePaletteStore.getState().closePalette("assistant-sessions"));
    act(() => usePaletteStore.getState().openPalette("assistant-sessions"));
    await waitFor(() => expect(listPastSessions).toHaveBeenCalledTimes(2));

    fireEvent.keyDown(input(), { key: "Enter" });
    expect(listPastSessions).toHaveBeenCalledTimes(2);

    await act(async () => reopened.resolve(listing({ sessions: [session("a", "Recovered")] })));
    expect(await screen.findByText("Recovered")).toBeTruthy();
    expect(retryButton()).toBeNull();
  });

  it("treats a rejected request as a failed load, not an empty history", async () => {
    listPastSessions.mockRejectedValueOnce(new Error("ipc down")).mockResolvedValueOnce(listing());
    renderPalette();

    expect(await screen.findByText("Couldn't load past sessions")).toBeTruthy();

    fireEvent.click(retryButton()!);
    expect(await screen.findByText("No past sessions yet")).toBeTruthy();
  });

  it("keeps the failure through a search, since nothing loaded to match", async () => {
    listPastSessions.mockResolvedValue(listing({ unreadable: ["codex"] }));
    renderPalette();
    await screen.findByText("Couldn't read Codex history");

    fireEvent.change(input(), { target: { value: "deploy" } });

    expect(await screen.findByText("Couldn't read Codex history")).toBeTruthy();
    expect(screen.queryByText(/No matches/)).toBeNull();
    expect(retryButton()).not.toBeNull();
  });

  it("says a cut list shows only the most recent, and points at /resume, through a search too", async () => {
    const sessions = Array.from({ length: 3 }, (_, i) => session(`s${i}`, `Question ${i}`, i));
    listPastSessions.mockResolvedValue(listing({ sessions, truncated: true }));
    renderPalette();

    const note = await screen.findByText(/Showing the 3 most recent conversations/);
    expect(note.textContent).toContain("/resume");

    fireEvent.change(input(), { target: { value: "an old question nobody asked" } });
    await waitFor(() => expect(screen.queryByText("Question 0")).toBeNull());
    expect(screen.getByText(/Showing the 3 most recent conversations/)).toBeTruthy();
  });

  it("shows rows from a host on an older build that answers with the bare list", async () => {
    listPastSessions.mockResolvedValue([session("a", "From an old host")]);
    renderPalette();

    expect(await screen.findByText("From an old host")).toBeTruthy();
    expect(retryButton()).toBeNull();
  });
});
