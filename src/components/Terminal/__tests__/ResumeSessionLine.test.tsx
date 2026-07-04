// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Hoisted so the vi.mock factories (which are hoisted above module code) can
// safely reference this shared, mutable mock state.
const h = vi.hoisted(() => ({
  records: { sessions: [] as unknown[], hasLoaded: true },
  resumeFn: vi.fn(),
  // dispatch returns a Promise so `.finally()` (the '+N more' button's
  // shortcut-hint teardown) has something to chain onto, as it does for real.
  dispatch: vi.fn(() => Promise.resolve()),
  hide: vi.fn(),
  items: { list: [] as Array<Record<string, unknown>> },
}));

vi.mock("@/hooks/useAgentSessionRecords", () => ({
  useAgentSessionRecords: () => h.records,
}));
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (sel: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    sel({ worktrees: new Map() }),
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (sel: (s: { currentProject: { id: string } }) => unknown) =>
    sel({ currentProject: { id: "p1" } }),
}));
vi.mock("@/hooks/useResumeAgentSession", () => ({
  useResumeAgentSession: () => h.resumeFn,
}));
vi.mock("@/services/resumeSessionItems", () => ({
  buildResumeSessionItems: () => h.items.list,
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: h.dispatch },
}));
vi.mock("@/store/shortcutHintStore", () => ({
  shortcutHintStore: { getState: () => ({ hide: h.hide }) },
}));
vi.mock("@/components/PanelPalette/PanelKindIcon", () => ({
  PanelKindIcon: () => <span data-testid="panel-icon" />,
}));

import { ResumeSessionLine } from "../ResumeSessionLine";

function makeItem(id: string, name: string, isStale = false) {
  return {
    id,
    name,
    iconId: "claude",
    color: "#fff",
    description: `Scripting · ${id}`,
    isStale,
    session: { sessionId: id },
  };
}

beforeEach(() => {
  h.records.sessions = [];
  h.records.hasLoaded = true;
  h.items.list = [];
  h.resumeFn.mockClear();
  h.dispatch.mockClear();
  h.hide.mockClear();
});

describe("ResumeSessionLine", () => {
  it("renders nothing when there are no resumable sessions", () => {
    h.items.list = [];
    const { container } = render(<ResumeSessionLine />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing while the journal is still loading", () => {
    h.records.hasLoaded = false;
    h.items.list = [makeItem("s1", "Resume Claude")];
    const { container } = render(<ResumeSessionLine />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the single most-recent session and resumes it on click", () => {
    h.items.list = [makeItem("s1", "Resume Claude")];
    render(<ResumeSessionLine />);
    fireEvent.click(screen.getByText("Resume Claude"));
    expect(h.resumeFn).toHaveBeenCalledWith({ sessionId: "s1" });
  });

  it("skips stale entries and hides when only stale ones remain", () => {
    h.items.list = [makeItem("s1", "Resume Claude", true)];
    const { container } = render(<ResumeSessionLine />);
    expect(container.firstChild).toBeNull();
  });

  it("offers a '+N more' browse entry into the resume launcher", async () => {
    h.items.list = [makeItem("s1", "Resume Claude"), makeItem("s2", "Resume Codex")];
    // Hold the dispatch open so the hide assertion proves the load-bearing
    // `.finally()` teardown (fired after the shortcut hint is emitted), not just
    // the pre-dispatch clear.
    let resolveDispatch: (() => void) | undefined;
    h.dispatch.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveDispatch = () => resolve()))
    );
    render(<ResumeSessionLine />);
    const more = screen.getByRole("button", { name: /browse 1 more resumable session/i });
    fireEvent.click(more);
    expect(h.dispatch).toHaveBeenCalledWith("terminal.resumeSessions", undefined, {
      source: "user",
    });
    // The launcher opens as a modal; the teaching shortcut hint sits above it,
    // so opening it must tear the hint down once dispatch settles (mirrors the
    // toolbar resume button).
    const hidesBeforeSettle = h.hide.mock.calls.length;
    resolveDispatch?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.hide.mock.calls.length).toBeGreaterThan(hidesBeforeSettle);
  });

  it("does not show '+N more' when there is only one session", () => {
    h.items.list = [makeItem("s1", "Resume Claude")];
    render(<ResumeSessionLine />);
    expect(screen.queryByRole("button", { name: /more resumable/i })).toBeNull();
  });
});
