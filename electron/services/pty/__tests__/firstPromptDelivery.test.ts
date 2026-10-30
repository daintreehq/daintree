import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectState, TerminalSnapshot } from "../../../../shared/types/project.js";
import type { TerminalFirstPrompt } from "../../../../shared/types/panel.js";

const { views, withheld, enqueueProjectStateUpdate } = vi.hoisted(() => ({
  views: new Map<string, Array<{ id: number; send: ReturnType<typeof vi.fn> }>>(),
  withheld: new Set<number>(),
  enqueueProjectStateUpdate: vi.fn(),
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWebContentsForProject: (projectId: string) => views.get(projectId) ?? [],
}));
vi.mock("../../../ipc/utils.js", () => ({
  isWithheldFromView: (id: number) => withheld.has(id),
}));
vi.mock("../../ProjectStore.js", () => ({
  projectStore: { enqueueProjectStateUpdate },
}));

import { CHANNELS } from "../../../ipc/channels.js";
import { deliverFirstPrompt, withFirstPrompt } from "../firstPromptDelivery.js";

const record: TerminalFirstPrompt = { text: "Fix the login bug", via: "send", at: 5 };

function pane(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return { id: "t1", kind: "terminal", title: "Claude", launchAgentId: "claude", ...overrides };
}

function stateWith(...terminals: TerminalSnapshot[]): ProjectState {
  return { projectId: "p1", sidebarWidth: 300, terminals } as ProjectState;
}

beforeEach(() => {
  views.clear();
  withheld.clear();
  enqueueProjectStateUpdate.mockReset().mockResolvedValue(undefined);
});

describe("deliverFirstPrompt (#15521)", () => {
  it("sends the record to the project's views on this machine, and saves nothing itself", () => {
    const view = { id: 1, send: vi.fn() };
    const other = { id: 2, send: vi.fn() };
    views.set("p1", [view]);
    views.set("p2", [other]);

    deliverFirstPrompt("p1", "t1", record);

    expect(view.send).toHaveBeenCalledWith(CHANNELS.EVENTS_PUSH, {
      name: "terminal:first-prompt",
      payload: { id: "t1", firstPrompt: record },
    });
    expect(other.send).not.toHaveBeenCalled();
    expect(enqueueProjectStateUpdate).not.toHaveBeenCalled();
  });

  it("saves the record into project state when no view of the project is open", async () => {
    const withheldView = { id: 3, send: vi.fn() };
    withheld.add(3);
    views.set("p1", [withheldView]);

    deliverFirstPrompt("p1", "t1", record);
    await vi.waitFor(() => expect(enqueueProjectStateUpdate).toHaveBeenCalledTimes(1));

    expect(withheldView.send).not.toHaveBeenCalled();
    const [projectId, updater] = enqueueProjectStateUpdate.mock.calls[0]!;
    expect(projectId).toBe("p1");
    const next = updater(stateWith(pane(), pane({ id: "t2" })));
    expect(next.terminals).toEqual([pane({ firstPrompt: record }), pane({ id: "t2" })]);
  });
});

describe("withFirstPrompt", () => {
  it("leaves a pane that already has a record, or is gone, as it is", () => {
    const launched: TerminalFirstPrompt = { text: "Launch task", via: "launch", at: 1 };
    expect(withFirstPrompt(stateWith(pane({ firstPrompt: launched })), "t1", record)).toBeNull();
    expect(withFirstPrompt(stateWith(pane({ id: "t2" })), "t1", record)).toBeNull();
    expect(withFirstPrompt(null, "t1", record)).toBeNull();
  });

  it("never records onto a shell, a trashed pane or a pane without a PTY", () => {
    expect(withFirstPrompt(stateWith(pane({ launchAgentId: undefined })), "t1", record)).toBeNull();
    expect(withFirstPrompt(stateWith(pane({ location: "trash" })), "t1", record)).toBeNull();
    expect(withFirstPrompt(stateWith(pane({ kind: "browser" })), "t1", record)).toBeNull();
  });
});
