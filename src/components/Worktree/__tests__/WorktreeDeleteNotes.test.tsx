// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { WorktreeDeleteNotesAnswer } from "@shared/types/plugin";

const pluginClientMock = vi.hoisted(() => ({
  getWorktreeDeleteNoteSources: vi.fn(),
  getWorktreeDeleteNotes: vi.fn(),
}));

vi.mock("@/clients/pluginClient", () => ({ pluginClient: pluginClientMock }));

import { WorktreeDeleteNotes } from "../WorktreeDeleteNotes";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (e: unknown) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SOURCES = [
  { pluginId: "acme.sync", pluginName: "Acme Sync" },
  { pluginId: "acme.deploy", pluginName: "Acme Deploy" },
];

let answers: Map<string, Deferred<WorktreeDeleteNotesAnswer | null>>;

beforeEach(() => {
  answers = new Map(SOURCES.map((s) => [s.pluginId, deferred()]));
  pluginClientMock.getWorktreeDeleteNoteSources.mockResolvedValue(SOURCES);
  pluginClientMock.getWorktreeDeleteNotes.mockImplementation(
    (_worktreeId: string, pluginId: string) => answers.get(pluginId)!.promise
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const flush = () => act(async () => {});

describe("WorktreeDeleteNotes", () => {
  it("shows each plugin as it is asked, then fills its row in as it answers", async () => {
    render(<WorktreeDeleteNotes worktreeId="/repo/wt" heading="Notes from plugins" />);
    await flush();
    expect(pluginClientMock.getWorktreeDeleteNotes).toHaveBeenCalledWith("/repo/wt", "acme.sync");
    expect(screen.getAllByTestId("worktree-delete-note-pending").map((r) => r.textContent)).toEqual(
      ["Checking with Acme Sync…", "Checking with Acme Deploy…"]
    );

    await act(async () => {
      answers.get("acme.deploy")!.resolve({
        status: "answered",
        notes: [{ severity: "warning", text: "Preview deployment still running" }],
      });
    });
    const note = screen.getByTestId("worktree-delete-note");
    expect(note.getAttribute("data-severity")).toBe("warning");
    expect(note.textContent).toContain("Acme Deploy: Preview deployment still running");
    expect(screen.getAllByTestId("worktree-delete-note-pending")).toHaveLength(1);

    await act(async () => {
      answers.get("acme.sync")!.resolve({ status: "no-answer" });
    });
    expect(screen.getByTestId("worktree-delete-note-no-answer").textContent).toBe(
      "Acme Sync didn't answer"
    );
    expect(screen.queryByTestId("worktree-delete-note-pending")).toBeNull();
  });

  it("names a plugin whose ask failed as not answering", async () => {
    render(<WorktreeDeleteNotes worktreeId="/repo/wt" />);
    await flush();
    await act(async () => {
      answers.get("acme.sync")!.reject(new Error("ipc down"));
      answers.get("acme.deploy")!.resolve({ status: "answered", notes: [] });
    });
    expect(screen.getByTestId("worktree-delete-note-no-answer").textContent).toBe(
      "Acme Sync didn't answer"
    );
    expect(screen.queryByTestId("worktree-delete-note")).toBeNull();
  });

  it("renders nothing once every plugin has nothing to say or went away", async () => {
    render(<WorktreeDeleteNotes worktreeId="/repo/wt" heading="Notes from plugins" />);
    await flush();
    await act(async () => {
      answers.get("acme.sync")!.resolve({ status: "answered", notes: [] });
      answers.get("acme.deploy")!.resolve(null);
    });
    expect(screen.queryByTestId("worktree-delete-notes")).toBeNull();
  });

  it("renders nothing, and asks nothing, with no worktree or no sources", async () => {
    const { rerender } = render(<WorktreeDeleteNotes worktreeId={null} />);
    await flush();
    expect(pluginClientMock.getWorktreeDeleteNoteSources).not.toHaveBeenCalled();

    pluginClientMock.getWorktreeDeleteNoteSources.mockRejectedValueOnce(new Error("no bridge"));
    rerender(<WorktreeDeleteNotes worktreeId="/repo/wt" />);
    await flush();
    expect(screen.queryByTestId("worktree-delete-notes")).toBeNull();
  });

  it("drops a late answer for a worktree it has moved off", async () => {
    const { rerender } = render(<WorktreeDeleteNotes worktreeId="/repo/a" />);
    await flush();
    const first = answers.get("acme.sync")!;
    answers = new Map(SOURCES.map((s) => [s.pluginId, deferred()]));
    rerender(<WorktreeDeleteNotes worktreeId="/repo/b" />);
    await flush();
    await act(async () => {
      first.resolve({ status: "answered", notes: [{ severity: "info", text: "about a" }] });
    });
    expect(screen.queryByTestId("worktree-delete-note")).toBeNull();
    expect(screen.getAllByTestId("worktree-delete-note-pending")).toHaveLength(2);
  });

  it("shows a note's text as text, never markup", async () => {
    render(<WorktreeDeleteNotes worktreeId="/repo/wt" />);
    await flush();
    await act(async () => {
      answers.get("acme.sync")!.resolve({
        status: "answered",
        notes: [{ severity: "info", text: "<b>bold</b>" }],
      });
    });
    const note = screen.getByTestId("worktree-delete-note");
    expect(note.querySelector("b")).toBeNull();
    expect(note.textContent).toContain("<b>bold</b>");
  });
});
