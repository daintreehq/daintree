// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePanelStore } from "@/store/panelStore";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import type { PtyPanelData } from "@shared/types/panel";
import { useComposerDiffNotes } from "../useComposerDiffNotes";

const panel = (overrides: Partial<PtyPanelData> = {}) =>
  ({
    id: "t1",
    title: "t1",
    kind: "terminal",
    cwd: "/repo",
    detectedAgentId: "claude",
    worktreeId: "wt-1",
    location: "grid",
    hasPty: true,
    ...overrides,
  }) as unknown as PtyPanelData;

const add = (worktreePath: string, filePath = "a.ts") =>
  useDiffNotesStore
    .getState()
    .addNote({ worktreePath, filePath, anchor: { kind: "file" }, body: "Note" })!;

describe("useComposerDiffNotes", () => {
  beforeEach(() => {
    useDiffNotesStore.setState({ notes: {}, editingIds: {} });
    usePanelStore.setState({ panelsById: { t1: panel() }, panelIds: ["t1"] });
  });

  it("follows the worktree's notes as they come, go and open in an editor", () => {
    const { result } = renderHook(() => useComposerDiffNotes("t1", "/repo", true));
    expect(result.current).toEqual({ sendable: [], editing: [] });

    let note!: ReturnType<typeof add>;
    act(() => {
      note = add("/repo");
      add("/elsewhere");
    });
    expect(result.current).toEqual({ sendable: [note], editing: [] });

    act(() => useDiffNotesStore.getState().setEditing(note.id, true));
    expect(result.current).toEqual({ sendable: [], editing: [note] });
    act(() => useDiffNotesStore.getState().setEditing(note.id, false));

    act(() => void useDiffNotesStore.getState().clearSent([note]));
    expect(result.current).toEqual({ sendable: [], editing: [] });
  });

  it.each<[string, () => { path?: string; enabled?: boolean }]>([
    ["is off", () => ({ enabled: false })],
    ["has no worktree", () => ({ path: "" })],
    [
      "is a plain shell",
      () => {
        usePanelStore.setState({
          panelsById: { t1: panel({ detectedAgentId: undefined, launchAgentId: undefined }) },
        });
        return {};
      },
    ],
  ])("offers nothing when the composer %s", (_label, arrange) => {
    add("/repo");
    const { path = "/repo", enabled = true } = arrange();
    const { result } = renderHook(() => useComposerDiffNotes("t1", path, enabled));
    expect(result.current).toBeNull();
  });
});
