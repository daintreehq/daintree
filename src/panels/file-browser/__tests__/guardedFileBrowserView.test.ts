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

function seedBrowser(fields: Record<string, unknown> = {}) {
  panels.byId = {
    fb: { id: "fb", kind: "file-browser", title: "Files", browserSelectedPath: "a.md", ...fields },
  };
}

function seedDirty() {
  useFileDocumentStore.getState().setFileDocument("fb", {
    identityKey: "a",
    fileName: "a.md",
    draftText: "draft",
    dirty: true,
    conflict: false,
    save: async () => ({ status: "saved" as const }),
    discard: async () => {},
  });
}

/** A guard whose answer the test gives when it chooses. */
function deferredGuard() {
  let answer: (verdict: "proceed" | "cancel") => void = () => {};
  const guard = vi.fn(
    () =>
      new Promise<"proceed" | "cancel">((resolve) => {
        answer = resolve;
      })
  );
  registerPanelCloseGuard("fb", guard);
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
  it("writes a patch that moves no selection straight through, dirty or not", async () => {
    seedDirty();
    const guard = vi.fn(async () => "cancel" as const);
    registerPanelCloseGuard("fb", guard);

    await expect(navigateFileBrowserView("fb", { browserExpandedPaths: ["src"] })).resolves.toBe(
      "applied"
    );

    expect(guard).not.toHaveBeenCalled();
    expect(panels.setFileBrowserView).toHaveBeenCalledWith("fb", { browserExpandedPaths: ["src"] });
  });

  it("moves a clean selection before the promise is even awaited", () => {
    void navigateFileBrowserView("fb", { browserSelectedPath: "b.md" });

    expect(panels.setFileBrowserView).toHaveBeenCalledWith("fb", { browserSelectedPath: "b.md" });
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

  it("leaves the selection where it is when the prompt is cancelled", async () => {
    seedDirty();
    registerPanelCloseGuard("fb", async () => "cancel");

    await expect(navigateFileBrowserView("fb", { browserSelectedPath: null })).resolves.toBe(
      "cancelled"
    );
    expect(panels.setFileBrowserView).not.toHaveBeenCalled();
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
    registerPanelCloseGuard("fb", async () => {
      seedBrowser({ location: "trash" });
      return "proceed";
    });

    await expect(
      navigateFileBrowserView(
        "fb",
        { browserSelectedPath: "b.md" },
        (panel) => panel.location !== "trash"
      )
    ).resolves.toBe("unavailable");
    expect(panels.setFileBrowserView).not.toHaveBeenCalled();
  });
});

describe("unsavedDraftLeftBy", () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: only the id and selection are read
  const panel = { id: "fb", browserSelectedPath: "docs/a.md" } as FileBrowserPanelData;

  it("names the draft only for a dirty document the move would leave", () => {
    expect(unsavedDraftLeftBy(panel, "b.md")).toBeNull();
    seedDirty();
    expect(unsavedDraftLeftBy(panel, "b.md")).toBe("a.md");
    expect(unsavedDraftLeftBy(panel, null)).toBe("a.md");
    expect(unsavedDraftLeftBy(panel, "docs/a.md")).toBeNull();
    expect(unsavedDraftLeftBy(panel, undefined)).toBeNull();
  });
});
