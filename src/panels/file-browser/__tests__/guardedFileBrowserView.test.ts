import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const panels = vi.hoisted(() => ({
  byId: {} as Record<string, Record<string, unknown>>,
  setFileBrowserView: vi.fn<(id: string, patch: Record<string, unknown>) => void>(),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      panelsById: panels.byId,
      setFileBrowserView: panels.setFileBrowserView,
    }),
  },
}));

import { useFileDocumentStore } from "@/store/fileDocumentStore";
import {
  __resetPanelCloseGuardsForTests,
  registerPanelCloseGuard,
} from "@/services/panelCloseGuard";
import {
  __resetFileBrowserNavigationForTests,
  navigateFileBrowserView,
  unsavedDraftLeftBy,
} from "../guardedFileBrowserView";
import type { FileBrowserPanelData } from "@shared/types/panel";

function browserRecord(id: string, fields: Record<string, unknown> = {}) {
  return { id, kind: "file-browser", title: "Files", browserSelectedPath: "a.md", ...fields };
}

function seedBrowser(fields: Record<string, unknown> = {}) {
  panels.byId = { fb: browserRecord("fb", fields) };
}

function seedDocument(panelId = "fb", dirty = true, fileName = "a.md") {
  useFileDocumentStore.getState().setFileDocument(panelId, {
    identityKey: `doc:${panelId}`,
    fileName,
    draftText: dirty ? "draft" : null,
    dirty,
    conflict: false,
    save: async () => ({ status: "saved" as const }),
    discard: async () => {},
  });
}

const seedDirty = () => seedDocument();

/** A guard whose answer the test gives when it chooses. */
function deferredGuard(panelId = "fb") {
  let answer: (verdict: "proceed" | "cancel") => void = () => {};
  const guard = vi.fn(
    () =>
      new Promise<"proceed" | "cancel">((resolve) => {
        answer = resolve;
      })
  );
  registerPanelCloseGuard(panelId, guard);
  return { guard, answer: (verdict: "proceed" | "cancel") => answer(verdict) };
}

beforeEach(() => {
  panels.setFileBrowserView.mockReset();
  seedBrowser();
});

afterEach(() => {
  __resetPanelCloseGuardsForTests();
  __resetFileBrowserNavigationForTests();
  useFileDocumentStore.setState({ byPanelId: {} });
});

describe("navigateFileBrowserView (#17197)", () => {
  it("writes a patch that moves no selection straight through, over a dirty draft", async () => {
    seedDirty();
    const guard = vi.fn(async () => "cancel" as const);
    registerPanelCloseGuard("fb", guard);

    const outcome = navigateFileBrowserView("fb", { browserExpandedPaths: ["src"] });

    expect(panels.setFileBrowserView).toHaveBeenCalledWith("fb", { browserExpandedPaths: ["src"] });
    await expect(outcome).resolves.toBe("applied");
    expect(guard).not.toHaveBeenCalled();
  });

  it("moves a clean document's selection before the promise is even awaited", async () => {
    seedDocument("fb", false);
    const guard = vi.fn(async () => "cancel" as const);
    registerPanelCloseGuard("fb", guard);

    const outcome = navigateFileBrowserView("fb", { browserSelectedPath: "b.md" });

    expect(panels.setFileBrowserView).toHaveBeenCalledWith("fb", { browserSelectedPath: "b.md" });
    await expect(outcome).resolves.toBe("applied");
    expect(guard).not.toHaveBeenCalled();
  });

  it("holds a dirty selection change until the prompt answers", async () => {
    seedDirty();
    const { guard, answer } = deferredGuard();

    const outcome = navigateFileBrowserView("fb", { browserSelectedPath: "b.md" });
    await vi.waitFor(() => expect(guard).toHaveBeenCalled());
    expect(panels.setFileBrowserView).not.toHaveBeenCalled();
    answer("proceed");

    await expect(outcome).resolves.toBe("applied");
    expect(panels.setFileBrowserView).toHaveBeenCalledWith("fb", { browserSelectedPath: "b.md" });
  });

  it.each([
    ["cancel", "cancelled", 0],
    ["proceed", "applied", 1],
  ] as const)(
    "clears a dirty selection only once the prompt answers: %s",
    async (verdict, outcome, writes) => {
      seedDirty();
      const guard = vi.fn(async () => verdict);
      registerPanelCloseGuard("fb", guard);

      await expect(navigateFileBrowserView("fb", { browserSelectedPath: null })).resolves.toBe(
        outcome
      );
      expect(guard).toHaveBeenCalledTimes(1);
      expect(panels.setFileBrowserView).toHaveBeenCalledTimes(writes);
    }
  );

  it("keeps each browser's waiting selection its own", async () => {
    panels.byId = { fb: browserRecord("fb"), other: browserRecord("other") };
    seedDocument("fb");
    seedDocument("other");
    const first = deferredGuard("fb");
    const second = deferredGuard("other");

    const a = navigateFileBrowserView("fb", { browserSelectedPath: "b.md" });
    const b = navigateFileBrowserView("other", { browserSelectedPath: "c.md" });
    await vi.waitFor(() => expect(second.guard).toHaveBeenCalled());
    first.answer("proceed");
    second.answer("proceed");

    await expect(a).resolves.toBe("applied");
    await expect(b).resolves.toBe("applied");
    expect(panels.setFileBrowserView).toHaveBeenCalledWith("fb", { browserSelectedPath: "b.md" });
    expect(panels.setFileBrowserView).toHaveBeenCalledWith("other", {
      browserSelectedPath: "c.md",
    });
  });

  it("lets view settings through while a selection waits, without displacing it", async () => {
    seedDirty();
    const { guard, answer } = deferredGuard();

    const waiting = navigateFileBrowserView("fb", { browserSelectedPath: "b.md" });
    await vi.waitFor(() => expect(guard).toHaveBeenCalled());
    await navigateFileBrowserView("fb", { browserExpandedPaths: ["src"] });
    expect(panels.setFileBrowserView).toHaveBeenCalledWith("fb", { browserExpandedPaths: ["src"] });
    answer("proceed");

    await expect(waiting).resolves.toBe("applied");
    expect(panels.setFileBrowserView).toHaveBeenLastCalledWith("fb", {
      browserSelectedPath: "b.md",
    });
  });

  it("lets a later selection supersede one still waiting, even a clean same-file one", async () => {
    seedDirty();
    const { guard, answer } = deferredGuard();

    const waiting = navigateFileBrowserView("fb", { browserSelectedPath: "b.md" });
    await vi.waitFor(() => expect(guard).toHaveBeenCalled());
    // Re-picking the draft's own file is a newer choice that leaves nothing behind.
    const reselect = navigateFileBrowserView("fb", { browserSelectedPath: "a.md" });
    answer("proceed");

    await expect(waiting).resolves.toBe("superseded");
    await expect(reselect).resolves.toBe("applied");
    expect(panels.setFileBrowserView).toHaveBeenCalledTimes(1);
    expect(panels.setFileBrowserView).toHaveBeenCalledWith("fb", { browserSelectedPath: "a.md" });
  });

  it("answers unavailable when the target stopped being the panel the caller meant", async () => {
    seedDirty();
    const guard = vi.fn(async () => {
      seedBrowser({ location: "trash" });
      return "proceed" as const;
    });
    registerPanelCloseGuard("fb", guard);
    const isTarget = vi.fn((panel: FileBrowserPanelData) => panel.location !== "trash");

    await expect(
      navigateFileBrowserView("fb", { browserSelectedPath: "b.md" }, isTarget)
    ).resolves.toBe("unavailable");
    // Accepted before the prompt, refused after it.
    expect(guard).toHaveBeenCalledTimes(1);
    expect(isTarget.mock.results.map((result) => result.value)).toEqual([true, false]);
    expect(panels.setFileBrowserView).not.toHaveBeenCalled();
  });

  it("answers unavailable at once for a panel that is not a browser the caller wants", async () => {
    seedDirty();
    const guard = vi.fn(async () => "proceed" as const);
    registerPanelCloseGuard("fb", guard);
    const build = vi.fn(() => ({ browserSelectedPath: "b.md" }));

    await expect(navigateFileBrowserView("fb", build, () => false)).resolves.toBe("unavailable");
    panels.byId = { fb: { id: "fb", kind: "file", title: "a.md" } };
    await expect(navigateFileBrowserView("fb", build)).resolves.toBe("unavailable");

    expect(build).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
    expect(panels.setFileBrowserView).not.toHaveBeenCalled();
  });
});

describe("unsavedDraftLeftBy", () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: only the id and selection are read
  const panel = { id: "fb", browserSelectedPath: "docs/a.md" } as FileBrowserPanelData;

  it("names the draft only for a dirty document the move would leave", () => {
    expect(unsavedDraftLeftBy(panel, "b.md")).toBeNull();
    seedDocument("fb", false);
    expect(unsavedDraftLeftBy(panel, "b.md")).toBeNull();
    // The document's own name, which need not be the selection's basename.
    useFileDocumentStore.setState({ byPanelId: {} });
    seedDocument("fb", true, "Draft notes.md");
    expect(unsavedDraftLeftBy(panel, "b.md")).toBe("Draft notes.md");
    expect(unsavedDraftLeftBy(panel, null)).toBe("Draft notes.md");
    expect(unsavedDraftLeftBy(panel, "docs/a.md")).toBeNull();
    expect(unsavedDraftLeftBy(panel, undefined)).toBeNull();
  });
});
