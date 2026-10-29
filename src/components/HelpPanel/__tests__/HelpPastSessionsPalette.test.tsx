// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HelpPastSession, HelpPastSessionsListing } from "@shared/types/ipc/help";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(async () => ({ ok: true, result: { outcome: "resumed" } })) },
}));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => true,
}));
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

const listPastSessions = vi.fn<(projectId: string) => Promise<HelpPastSessionsListing>>();

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

beforeEach(() => {
  listPastSessions.mockReset();
  (window as unknown as { electron: unknown }).electron = { help: { listPastSessions } };
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

  it("retries from the keyboard: the chord beside rows, Enter when nothing listed", async () => {
    listPastSessions
      .mockResolvedValueOnce(listing({ sessions: [session("a", "Kept")], unreadable: ["claude"] }))
      .mockResolvedValueOnce(listing({ unreadable: ["claude"] }))
      .mockResolvedValueOnce(listing({ sessions: [session("b", "Back")] }));
    renderPalette();
    await screen.findByText("Kept");

    fireEvent.keyDown(input(), { key: "r", metaKey: true });
    expect(await screen.findByText("Couldn't read Claude history")).toBeTruthy();
    expect(screen.queryByText("Kept")).toBeNull();
    expect(input().getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(input().getAttribute("aria-describedby")!)?.textContent).toBe(
      "Press Enter to retry"
    );

    fireEvent.keyDown(input(), { key: "Enter" });
    expect(await screen.findByText("Back")).toBeTruthy();
    expect(listPastSessions).toHaveBeenCalledTimes(3);
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
    listPastSessions.mockResolvedValue([
      session("a", "From an old host"),
    ] as unknown as HelpPastSessionsListing);
    renderPalette();

    expect(await screen.findByText("From an old host")).toBeTruthy();
    expect(retryButton()).toBeNull();
  });
});
