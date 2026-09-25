// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffNote } from "@/components/Worktree/diffNotes";

const { panelState, writeMock, notifyUserInputMock, managedById } = vi.hoisted(() => ({
  panelState: { panelsById: {} as Record<string, unknown>, panelIds: [] as string[] },
  writeMock: vi.fn(),
  notifyUserInputMock: vi.fn(),
  managedById: new Map<string, { terminal: { modes: { bracketedPasteMode: boolean } } }>(),
}));

vi.mock("@/store", () => ({
  usePanelStore: Object.assign(vi.fn(), { getState: () => panelState }),
  usePreferencesStore: vi.fn(),
}));

vi.mock("@/clients", () => ({
  terminalClient: { write: writeMock },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    get: (id: string) => managedById.get(id),
    notifyUserInput: notifyUserInputMock,
  },
}));

vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: (panel: { agentFixture?: boolean }) => ({
    isAgent: panel.agentFixture === true,
  }),
}));

vi.mock("@/utils/terminalTitleDisplay", () => ({
  getTerminalDisplayTitle: (panel: { title: string }) => panel.title,
}));

import { deliverDiffNotes } from "../useDiffNoteDelivery";
import { useDiffNotesStore } from "@/store/diffNotesStore";

function terminal(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: "terminal",
    title: id === "agent" ? "Claude" : "Shell",
    location: "grid",
    hasPty: true,
    cwd: "/repo",
    agentFixture: id === "agent",
    ...overrides,
  };
}

function seedNote(body = "Fix the loop"): DiffNote {
  return useDiffNotesStore.getState().addNote({
    worktreePath: "/repo",
    filePath: "src/a.ts",
    anchor: { kind: "lines", side: "new", startLine: 4, endLine: 4, contentHash: "h" },
    body,
  })!;
}

describe("deliverDiffNotes", () => {
  beforeEach(() => {
    writeMock.mockReset();
    notifyUserInputMock.mockReset();
    managedById.clear();
    panelState.panelsById = { agent: terminal("agent"), shell: terminal("shell") };
    panelState.panelIds = ["agent", "shell"];
    useDiffNotesStore.setState({ notes: {}, editingIds: {} });
  });

  it("pastes the prompt as a bracketed paste with no Enter and clears the sent notes", () => {
    managedById.set("agent", { terminal: { modes: { bracketedPasteMode: true } } });
    const note = seedNote();

    const result = deliverDiffNotes("agent", [note]);

    expect(result).toEqual({ ok: true, sent: 1, kept: 0, targetTitle: "Claude" });
    expect(writeMock).toHaveBeenCalledTimes(1);
    const [targetId, data] = writeMock.mock.calls[0]!;
    expect(targetId).toBe("agent");
    expect(data).toBe('\x1b[200~File: src/a.ts\nLine(s): 4\n"Fix the loop"\x1b[201~');
    expect(data).not.toMatch(/\r/);
    expect(notifyUserInputMock).toHaveBeenCalledWith("agent");
    expect(useDiffNotesStore.getState().notes).toEqual({});
  });

  it("gives an agent in another worktree absolute paths", () => {
    panelState.panelsById.agent = terminal("agent", { cwd: "/elsewhere" });
    deliverDiffNotes("agent", [seedNote()]);
    expect(writeMock.mock.calls[0]![1]).toContain("File: /repo/src/a.ts");
  });

  it("refuses a plain shell and keeps the notes pending", () => {
    const note = seedNote();
    const result = deliverDiffNotes("shell", [note]);
    expect(result.ok).toBe(false);
    expect(writeMock).not.toHaveBeenCalled();
    expect(useDiffNotesStore.getState().notes[note.id]).toBeDefined();
  });

  it("refuses an agent that isn't in bracketed paste mode, where newlines would submit", () => {
    managedById.set("agent", { terminal: { modes: { bracketedPasteMode: false } } });
    const note = seedNote();
    const result = deliverDiffNotes("agent", [note]);
    expect(result.ok).toBe(false);
    expect(writeMock).not.toHaveBeenCalled();
    expect(useDiffNotesStore.getState().notes[note.id]).toBeDefined();
  });

  it("refuses an input-locked agent", () => {
    panelState.panelsById.agent = terminal("agent", { isInputLocked: true });
    const result = deliverDiffNotes("agent", [seedNote()]);
    expect(result.ok).toBe(false);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("keeps a note pending when the paste throws", () => {
    writeMock.mockImplementation(() => {
      throw new Error("port closed");
    });
    const note = seedNote();
    const result = deliverDiffNotes("agent", [note]);
    expect(result).toEqual({ ok: false, message: "port closed" });
    expect(useDiffNotesStore.getState().notes[note.id]).toBeDefined();
  });

  it("holds back a note whose editor is open and reports it as still pending", () => {
    const editing = seedNote("Half written");
    const ready = seedNote("Ready to go");
    useDiffNotesStore.getState().setEditing(editing.id, true);

    const result = deliverDiffNotes("agent", [editing, ready]);

    expect(result).toEqual({ ok: true, sent: 1, kept: 1, targetTitle: "Claude" });
    expect(writeMock.mock.calls[0]![1]).toContain("Ready to go");
    expect(writeMock.mock.calls[0]![1]).not.toContain("Half written");
    expect(useDiffNotesStore.getState().notes[editing.id]).toBeDefined();
  });
});
