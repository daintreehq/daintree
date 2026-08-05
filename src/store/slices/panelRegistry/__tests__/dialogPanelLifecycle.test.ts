/**
 * The ephemeral contract for `location: "dialog"` panels (#11239).
 *
 * A dialog-presented panel is a real registry record so panel components can
 * render unmodified inside a modal — which means every surface that treats
 * "in the registry" as "part of the user's workspace" has to exclude it. The
 * issue's own framing: a quick file peek that leaks a zombie panel into session
 * restore would be worse than the duplication it replaces.
 *
 * Covered here: not counted toward the limit, not trashed (removed outright),
 * not movable by ordinary layout actions, and promotable into a real grid panel
 * under a re-checked ceiling. The "not persisted / not restored" half is proven
 * against the real persistence filter in `panelPersistence.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isFilePanel } from "@shared/types/panel";
import type { PanelInstance, FilePanelData } from "@shared/types/panel";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: { get: vi.fn().mockResolvedValue({}) },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
  },
}));

const notifyMock = vi.fn();
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

vi.mock("../../../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

const { usePanelStore } = await import("../../../panelStore");
const { usePanelLimitStore } = await import("../../../panelLimitStore");
const { countPanelsTowardLimit } = await import("../panelCount");

function makeFilePanel(id: string, overrides: Partial<FilePanelData> = {}): PanelInstance {
  return {
    id,
    kind: "file",
    title: "File",
    location: "grid",
    filePath: `/repo/${id}.md`,
    fileViewMode: "source",
    ...overrides,
  } as PanelInstance;
}

function seed(panels: PanelInstance[]): void {
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
  });
}

describe("dialog panel ephemeral lifecycle", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      electron: {},
    });
    const { reset } = usePanelStore.getState();
    await reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("panel limit", () => {
    it("excludes dialog panels from the limit count", () => {
      seed([
        makeFilePanel("grid-1"),
        makeFilePanel("dialog-1", { location: "dialog", excludeFromPersistence: true }),
      ]);
      const { panelsById, panelIds } = usePanelStore.getState();

      expect(countPanelsTowardLimit(panelsById, panelIds)).toBe(1);
    });

    it("excludes any excludeFromPersistence panel, not just dialogs", () => {
      // The assistant overlay carries the flag while sitting in the dock; the
      // field's contract covers counts regardless of location.
      seed([
        makeFilePanel("grid-1"),
        makeFilePanel("assistant", { location: "dock", excludeFromPersistence: true }),
      ]);
      const { panelsById, panelIds } = usePanelStore.getState();

      expect(countPanelsTowardLimit(panelsById, panelIds)).toBe(1);
    });

    it("excludes a dialog panel even when the ephemeral flag is missing", () => {
      // Ephemerality must follow from the location itself. If it depended only
      // on a caller remembering to stamp `excludeFromPersistence`, one forgetful
      // call site would silently leak a counted, persisted zombie panel.
      seed([makeFilePanel("grid-1"), makeFilePanel("dialog-1", { location: "dialog" })]);
      const { panelsById, panelIds } = usePanelStore.getState();

      expect(countPanelsTowardLimit(panelsById, panelIds)).toBe(1);
    });

    it("still excludes trashed panels", () => {
      seed([makeFilePanel("grid-1"), makeFilePanel("gone", { location: "trash" })]);
      const { panelsById, panelIds } = usePanelStore.getState();

      expect(countPanelsTowardLimit(panelsById, panelIds)).toBe(1);
    });
  });

  describe("layout actions refuse dialog panels", () => {
    it("moveTerminalToGrid returns false and leaves the location untouched", () => {
      seed([makeFilePanel("dialog-1", { location: "dialog", excludeFromPersistence: true })]);

      const moved = usePanelStore.getState().moveTerminalToGrid("dialog-1");

      expect(moved).toBe(false);
      expect(usePanelStore.getState().panelsById["dialog-1"]?.location).toBe("dialog");
    });

    it("moveTerminalToDock leaves the location untouched", () => {
      seed([makeFilePanel("dialog-1", { location: "dialog", excludeFromPersistence: true })]);

      usePanelStore.getState().moveTerminalToDock("dialog-1");

      expect(usePanelStore.getState().panelsById["dialog-1"]?.location).toBe("dialog");
    });

    it("backgroundTerminal leaves the location untouched", () => {
      seed([makeFilePanel("dialog-1", { location: "dialog", excludeFromPersistence: true })]);

      usePanelStore.getState().backgroundTerminal("dialog-1");

      expect(usePanelStore.getState().panelsById["dialog-1"]?.location).toBe("dialog");
    });

    it("trashPanel removes the panel outright instead of parking it in trash", () => {
      // Trashing would record a bogus "grid" restore target and leave the
      // ephemeral panel undoable back into the grid after its modal is gone.
      seed([makeFilePanel("dialog-1", { location: "dialog", excludeFromPersistence: true })]);

      usePanelStore.getState().trashPanel("dialog-1");

      expect(usePanelStore.getState().panelsById["dialog-1"]).toBeUndefined();
      expect(usePanelStore.getState().trashedTerminals.has("dialog-1")).toBe(false);
    });
  });

  describe("promoteDialogPanelToGrid", () => {
    beforeEach(() => {
      usePanelLimitStore.setState({ hardLimit: 10 });
    });

    it("keeps the same panel id, flips to grid, and clears the ephemeral flag", () => {
      seed([
        makeFilePanel("dialog-1", {
          location: "dialog",
          excludeFromPersistence: true,
          filePath: "/repo/spec.md",
        }),
      ]);

      const promoted = usePanelStore.getState().promoteDialogPanelToGrid("dialog-1");

      expect(promoted).toBe(true);
      const panel = usePanelStore.getState().panelsById["dialog-1"];
      expect(panel?.location).toBe("grid");
      expect(panel?.excludeFromPersistence).toBeUndefined();
      // Same record, not a second panel: the content the user was reading carries over.
      expect(panel && isFilePanel(panel) ? panel.filePath : undefined).toBe("/repo/spec.md");
      expect(usePanelStore.getState().panelIds).toEqual(["dialog-1"]);
    });

    it("makes the promoted panel count toward the limit", () => {
      seed([makeFilePanel("dialog-1", { location: "dialog", excludeFromPersistence: true })]);

      usePanelStore.getState().promoteDialogPanelToGrid("dialog-1");

      const { panelsById, panelIds } = usePanelStore.getState();
      expect(countPanelsTowardLimit(panelsById, panelIds)).toBe(1);
    });

    it("refuses to promote when the hard limit is already reached", () => {
      usePanelLimitStore.setState({ hardLimit: 2 });
      seed([
        makeFilePanel("grid-1"),
        makeFilePanel("grid-2"),
        makeFilePanel("dialog-1", { location: "dialog", excludeFromPersistence: true }),
      ]);

      const promoted = usePanelStore.getState().promoteDialogPanelToGrid("dialog-1");

      expect(promoted).toBe(false);
      // Left as a dialog so the user keeps reading rather than losing the view.
      expect(usePanelStore.getState().panelsById["dialog-1"]?.location).toBe("dialog");
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Panel limit reached" })
      );
    });

    it("refuses a non-file dialog without calling it a file (#11666)", () => {
      // Promotion serves file, diff, review and file-browser dialogs alike, so
      // a message naming "this file" told most of them the wrong thing about
      // what they were opening. A review hub is the fixture precisely because
      // nothing about it is file-shaped. Asserted as the absence of the wrong
      // phrase rather than the presence of the new sentence — the copy stays
      // free to be reworded, but can never re-acquire a kind it doesn't know.
      usePanelLimitStore.setState({ hardLimit: 1 });
      seed([
        makeFilePanel("grid-1"),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: only location and kind are read here
        {
          id: "dialog-review",
          kind: "review",
          title: "Review",
          location: "dialog",
          excludeFromPersistence: true,
        } as PanelInstance,
      ]);

      expect(usePanelStore.getState().promoteDialogPanelToGrid("dialog-review")).toBe(false);

      expect(notifyMock).toHaveBeenCalledTimes(1);
      const warning = notifyMock.mock.calls[0]![0] as { message?: string };
      expect(warning.message).not.toMatch(/\bthis file\b/i);
    });

    it("refuses panels that are not dialog-presented", () => {
      seed([makeFilePanel("grid-1")]);

      expect(usePanelStore.getState().promoteDialogPanelToGrid("grid-1")).toBe(false);
    });

    it("refuses a missing panel", () => {
      expect(usePanelStore.getState().promoteDialogPanelToGrid("nope")).toBe(false);
    });
  });
});
