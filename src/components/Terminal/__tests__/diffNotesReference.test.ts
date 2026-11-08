// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import { setCurrentViewStore, type WorktreeViewStoreApi } from "@/store/createWorktreeStore";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import type { DiffNote } from "@/components/Worktree/diffNotes";
import { expandDraftContext } from "../draftContextExpansion";

function agent(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/repo/a",
    cols: 80,
    rows: 24,
    detectedAgentId: "claude",
    worktreeId: "wt-a",
    location: "grid",
    hasPty: true,
    ...(overrides as object),
  } as PtyPanelData;
}

function seedPanels(...panels: PanelInstance[]): void {
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((panel) => [panel.id, panel])),
    panelIds: panels.map((panel) => panel.id),
  });
}

function addNote(worktreePath: string, filePath: string, body: string, line?: number): DiffNote {
  const note = useDiffNotesStore.getState().addNote({
    worktreePath,
    filePath,
    anchor:
      line === undefined
        ? { kind: "file" }
        : { kind: "lines", side: "new", startLine: line, endLine: line, contentHash: "x" },
    body,
  });
  return note!;
}

async function expand(text: string, terminalId = "a") {
  const taken: DiffNote[] = [];
  const out = await expandDraftContext(text, {
    terminalId,
    cwd: "/repo/a",
    onDiffNotesTaken: (notes) => taken.push(...notes),
  });
  return { out, taken };
}

describe("@notes expansion", () => {
  beforeEach(() => {
    useDiffNotesStore.setState({ notes: {}, editingIds: {} });
    setCurrentViewStore({
      getState: () => ({
        worktrees: new Map([
          ["wt-a", { path: "/repo/a" }],
          ["wt-b", { path: "/repo/b" }],
        ]),
      }),
    } as unknown as WorktreeViewStoreApi);
    seedPanels(agent("a"), agent("b", { worktreeId: "wt-b", cwd: "/repo/b" }));
    (window as unknown as { electron: unknown }).electron = {
      git: { getWorkingDiff: vi.fn().mockResolvedValue("") },
    };
  });

  afterEach(() => {
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
  });

  it("sends the agent's own worktree's notes in the send menu's format, without clearing them", async () => {
    const second = addNote("/repo/a", "src/b.ts", 'Say "why"', 4);
    const first = addNote("/repo/a", "src/a.ts", "Rename this");
    addNote("/repo/b", "src/other.ts", "Not for this agent");

    const { out, taken } = await expand("Fix these @notes");

    expect(out).toBe(
      'Fix these\nFile: src/a.ts\nLine(s): whole file\n"Rename this"\n\nFile: src/b.ts\nLine(s): 4\n"Say \\"why\\""'
    );
    expect(taken).toEqual([first, second]);
    expect(Object.keys(useDiffNotesStore.getState().notes)).toHaveLength(3);
  });

  it("moves what follows the token onto its own line, so it doesn't read as part of the last note", async () => {
    addNote("/repo/a", "src/a.ts", "Rename this");
    const { out } = await expand("Fix @notes and also rename X");
    expect(out).toBe('Fix\nFile: src/a.ts\nLine(s): whole file\n"Rename this"\nand also rename X');
  });

  it("takes one file's notes for the per-file form, spelled plain or quoted", async () => {
    const spaced = addNote("/repo/a", "my dir/a b.ts", "Spaced");
    addNote("/repo/a", "src/a.ts", "Plain");

    const quoted = await expand('See @notes:"my dir/a b.ts"');
    expect(quoted.taken).toEqual([spaced]);
    expect(quoted.out).toContain('File: my dir/a b.ts\nLine(s): whole file\n"Spaced"');
    expect(quoted.out).not.toContain("Plain");

    const plain = await expand("See @notes:src/a.ts, then stop");
    expect(plain.out).toContain('"Plain"\n, then stop');
  });

  it("resolves paths absolute for an agent outside the worktree's root", async () => {
    seedPanels(agent("a", { cwd: "/repo/a/packages/ui" }));
    addNote("/repo/a", "src/a.ts", "Absolute");
    const { out } = await expand("@notes");
    expect(out).toContain("File: /repo/a/src/a.ts");
  });

  it("holds back a note open in an editor, and says so when nothing else is left", async () => {
    const editing = addNote("/repo/a", "src/a.ts", "Mid rewrite");
    const ready = addNote("/repo/a", "src/b.ts", "Ready");
    useDiffNotesStore.getState().setEditing(editing.id, true);

    const mixed = await expand("@notes");
    expect(mixed.taken).toEqual([ready]);
    expect(mixed.out).not.toContain("Mid rewrite");

    const blocked = await expand("@notes:src/a.ts");
    expect(blocked.taken).toEqual([]);
    expect(blocked.out).toBe("[Diff notes for src/a.ts still being edited]");
  });

  it("sends a note once however many tokens name it", async () => {
    const a = addNote("/repo/a", "src/a.ts", "A");
    const b = addNote("/repo/a", "src/b.ts", "B");

    const fileFirst = await expand("@notes:src/a.ts then @notes");
    expect(fileFirst.taken).toEqual([a, b]);
    expect(fileFirst.out.match(/File: src\/a\.ts/g)).toHaveLength(1);
    expect(fileFirst.out.match(/File: src\/b\.ts/g)).toHaveLength(1);

    const allFirst = await expand("@notes then @notes:src/a.ts then @notes");
    expect(allFirst.taken).toEqual([a, b]);
    expect(allFirst.out).toContain("[Diff notes for src/a.ts included above]");
    expect(allFirst.out).toContain("[Diff notes included above]");
  });

  it("says when nothing is pending, in the token's place", async () => {
    addNote("/repo/b", "src/a.ts", "Another worktree's");
    const { out, taken } = await expand("Fix @notes and @notes:src/a.ts");
    expect(taken).toEqual([]);
    expect(out).toBe("Fix [No pending diff notes] and [No pending diff notes for src/a.ts]");
  });

  it("never expands a token a note's own text mentions", async () => {
    addNote("/repo/a", "src/a.ts", "Don't read @diff or @notes here");
    const { out } = await expand("@notes");
    expect(out).toContain("@diff or @notes here");
    expect(window.electron.git.getWorkingDiff).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    [
      "a plain shell",
      () => seedPanels(agent("a", { detectedAgentId: undefined, launchAgentId: undefined })),
    ],
    ["an agent restarting", () => seedPanels(agent("a", { isRestarting: true }))],
    ["an agent in no worktree", () => seedPanels(agent("a", { worktreeId: undefined }))],
    ["a terminal this view doesn't hold", () => seedPanels()],
  ])("keeps notes from %s", async (_label, arrange) => {
    addNote("/repo/a", "src/a.ts", "Secret from a shell");
    arrange();
    const { out, taken } = await expand("@notes");
    expect(taken).toEqual([]);
    expect(out).toBe("[Diff notes aren't available here]");
  });

  it("keeps notes from a caller that can't report delivery", async () => {
    addNote("/repo/a", "src/a.ts", "Would never clear");
    const out = await expandDraftContext("@notes", { terminalId: "a", cwd: "/repo/a" });
    expect(out).toBe("[Diff notes aren't available here]");
  });

  it("reads the notes as they were when the send began, not after a slow diff", async () => {
    const note = addNote("/repo/a", "src/a.ts", "Before");
    let finishDiff!: (diff: string) => void;
    (window.electron.git.getWorkingDiff as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<string>((resolve) => {
        finishDiff = resolve;
      })
    );

    const sending = expand("@notes and @diff");
    useDiffNotesStore.getState().saveNote(note, "After");
    finishDiff("");

    const { out, taken } = await sending;
    expect(out).toContain('"Before"');
    expect(taken).toEqual([note]);
  });
});
