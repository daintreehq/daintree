// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  fileEditorSlotKey,
  type FileEditorSlotKey,
  type PluginHostedViewDescriptor,
  type ProjectSurfaceChoices,
  type ProjectSurfaceSlotKey,
  type ProjectSurfaceSlotState,
} from "@shared/types/plugin";
import {
  currentFileEditorDefault,
  resolveFileEditorDefault,
  type FileEditorDefaultInput,
} from "../fileEditorDefaults";
import { useProjectStore } from "@/store/projectStore";
import { usePluginHostedViewsStore } from "@/store/pluginHostedViewsStore";
import {
  _resetPluginProjectSurfacesStoreForTest,
  usePluginProjectSurfacesStore,
} from "@/store/pluginProjectSurfacesStore";
import { setWorktreePathIndexAccessor, setWorktreeSelectionAccessor } from "@/store/storeAccessors";

const ROOT = "/repo";
const ACME = "project__p1__acme.cms";
const ZED = "project__p1__zed.pages";

function editorView(
  pluginId: string,
  editors: Array<{ id: string; paths: string[]; mode?: "edit" | "view" }>
): PluginHostedViewDescriptor {
  return {
    id: `${pluginId}/editor`,
    pluginId,
    viewId: "editor",
    componentPath: "plugin://x/editor.js",
    location: "fileEditor",
    name: "editor",
    fileEditors: editors.map((editor) => ({
      id: editor.id,
      mode: editor.mode ?? "edit",
      extensions: [],
      paths: editor.paths,
      maxBytes: 1024,
    })),
  } as PluginHostedViewDescriptor;
}

function slot(pluginId: string, editorId: string): ProjectSurfaceSlotState {
  return {
    mode: "exclusive",
    options: [{ pluginId, scope: "project", value: { kind: "data", data: { editorId } } }],
    defaultOptionId: pluginId,
    refused: [],
  };
}

const JSON_SLOT = fileEditorSlotKey("content/*.json");
const ABOUT_SLOT = fileEditorSlotKey("content/about.json");

function input(overrides: Partial<FileEditorDefaultInput> = {}): FileEditorDefaultInput {
  return {
    slots: { [JSON_SLOT]: slot(ACME, "records") },
    choices: {},
    choicesLoaded: true,
    views: [editorView(ACME, [{ id: "records", paths: ["content/*.json"] }])],
    disabled: new Set(),
    rootPath: ROOT,
    filePath: `${ROOT}/content/about.json`,
    ...overrides,
  };
}

describe("resolveFileEditorDefault (#13811)", () => {
  it("names the owner's editor for a file its pattern covers, unanswered", () => {
    expect(resolveFileEditorDefault(input())).toEqual({
      slot: JSON_SLOT,
      pluginId: ACME,
      choiceId: `${ACME}/records`,
      choice: null,
    });
  });

  it("matches the pattern against the path relative to the root, and nothing outside it", () => {
    expect(resolveFileEditorDefault(input({ filePath: `${ROOT}/content/deep/x.json` }))).toBeNull();
    expect(resolveFileEditorDefault(input({ filePath: `${ROOT}/content/notes.md` }))).toBeNull();
    expect(resolveFileEditorDefault(input({ filePath: "/elsewhere/content/x.json" }))).toBeNull();
  });

  it("applies nothing until the answers are known, then honours them", () => {
    expect(resolveFileEditorDefault(input({ choicesLoaded: false }))).toBeNull();

    const answered = (choice: "surface" | "stock"): ProjectSurfaceChoices => ({
      [JSON_SLOT]: { pluginId: "acme.cms", choice, decidedAt: 1 },
    });
    expect(resolveFileEditorDefault(input({ choices: answered("stock") }))).toBeNull();
    expect(resolveFileEditorDefault(input({ choices: answered("surface") }))?.choice).toBe(
      "surface"
    );
  });

  it("asks again when the pattern has passed to another plugin since the answer", () => {
    const result = resolveFileEditorDefault(
      input({
        slots: { [JSON_SLOT]: slot(ZED, "page") },
        choices: { [JSON_SLOT]: { pluginId: "acme.cms", choice: "stock", decidedAt: 1 } },
        views: [editorView(ZED, [{ id: "page", paths: ["content/*.json"] }])],
      })
    );
    expect(result).toMatchObject({ pluginId: ZED, choice: null });
  });

  it("applies nothing while the claimed editor isn't on offer", () => {
    expect(resolveFileEditorDefault(input({ views: null }))).toBeNull();
    expect(resolveFileEditorDefault(input({ disabled: new Set([ACME]) }))).toBeNull();
    // Reloaded without the pattern, or as a Rendered editor: a stale claim
    // must not name an editor that no longer edits these files.
    for (const editors of [
      [{ id: "records", paths: ["data/*.json"] }],
      [{ id: "records", paths: ["content/*.json"], mode: "view" as const }],
      [{ id: "other", paths: ["content/*.json"] }],
    ]) {
      expect(resolveFileEditorDefault(input({ views: [editorView(ACME, editors)] }))).toBeNull();
    }
  });

  it("prefers the more specific of two matching patterns, whatever order they arrived in", () => {
    const views = [
      editorView(ACME, [{ id: "records", paths: ["content/*.json"] }]),
      editorView(ZED, [{ id: "page", paths: ["content/about.json"] }]),
    ];
    const forward: Partial<Record<ProjectSurfaceSlotKey, ProjectSurfaceSlotState>> = {
      [JSON_SLOT]: slot(ACME, "records"),
      [ABOUT_SLOT]: slot(ZED, "page"),
    };
    const reverse: Partial<Record<ProjectSurfaceSlotKey, ProjectSurfaceSlotState>> = {
      [ABOUT_SLOT]: slot(ZED, "page"),
      [JSON_SLOT]: slot(ACME, "records"),
    };
    expect(resolveFileEditorDefault(input({ slots: forward, views }))?.slot).toBe(ABOUT_SLOT);
    expect(resolveFileEditorDefault(input({ slots: reverse, views }))?.slot).toBe(ABOUT_SLOT);
  });

  it("breaks a specificity tie by pattern, ordinally, whatever order the claims arrived in", () => {
    // Both carry 14 literal characters and no globstar.
    const a: FileEditorSlotKey = fileEditorSlotKey("content/a*.json");
    const t: FileEditorSlotKey = fileEditorSlotKey("content/*t.json");
    const views = [
      editorView(ACME, [{ id: "records", paths: ["content/a*.json"] }]),
      editorView(ZED, [{ id: "page", paths: ["content/*t.json"] }]),
    ];
    for (const slots of [
      { [a]: slot(ACME, "records"), [t]: slot(ZED, "page") },
      { [t]: slot(ZED, "page"), [a]: slot(ACME, "records") },
    ]) {
      // "content/*" sorts before "content/a".
      expect(resolveFileEditorDefault(input({ slots, views }))?.slot).toBe(t);
    }
  });

  it("ranks a pattern without a globstar above one with, whatever its length", () => {
    const deep: FileEditorSlotKey = fileEditorSlotKey("**/content/about.json");
    const views = [
      editorView(ACME, [{ id: "records", paths: ["content/about.json"] }]),
      editorView(ZED, [{ id: "page", paths: ["**/content/about.json"] }]),
    ];
    const result = resolveFileEditorDefault(
      input({ slots: { [deep]: slot(ZED, "page"), [ABOUT_SLOT]: slot(ACME, "records") }, views })
    );
    expect(result?.slot).toBe(ABOUT_SLOT);
  });

  it("falls through to the next match when the user chose Daintree's own for the narrower one", () => {
    const views = [
      editorView(ACME, [{ id: "records", paths: ["content/*.json"] }]),
      editorView(ZED, [{ id: "page", paths: ["content/about.json"] }]),
    ];
    const result = resolveFileEditorDefault(
      input({
        slots: { [JSON_SLOT]: slot(ACME, "records"), [ABOUT_SLOT]: slot(ZED, "page") },
        choices: { [ABOUT_SLOT]: { pluginId: "zed.pages", choice: "stock", decidedAt: 1 } },
        views,
      })
    );
    expect(result?.slot).toBe(JSON_SLOT);
  });

  it("ignores catalogue slots and claims that carry no editor", () => {
    const result = resolveFileEditorDefault(
      input({
        slots: {
          emptyCanvas: {
            mode: "exclusive",
            options: [{ pluginId: ACME, scope: "project", value: { kind: "view", viewId: "x" } }],
            defaultOptionId: ACME,
            refused: [],
          },
          [JSON_SLOT]: {
            mode: "exclusive",
            options: [{ pluginId: ACME, scope: "project", value: { kind: "data", data: {} } }],
            defaultOptionId: ACME,
            refused: [],
          },
        },
      })
    );
    expect(result).toBeNull();
  });
});

describe("currentFileEditorDefault (#13811)", () => {
  afterEach(() => {
    _resetPluginProjectSurfacesStoreForTest();
    usePluginHostedViewsStore.setState({ views: null, loadFailed: false });
    setWorktreePathIndexAccessor(() => null);
    setWorktreeSelectionAccessor(() => ({ activeWorktreeId: null, restoreWorktreeId: null }));
  });

  /** `/repo` is the active worktree, with `/repo/nested` a worktree inside it. */
  function seed() {
    usePluginProjectSurfacesStore.setState({
      slots: { [JSON_SLOT]: slot(ACME, "records") },
      choices: {},
      choicesLoaded: true,
    });
    usePluginHostedViewsStore.setState({
      views: [editorView(ACME, [{ id: "records", paths: ["content/*.json"] }])],
    });
    setWorktreePathIndexAccessor(
      () =>
        new Map([
          ["main", "/repo"],
          ["nested", "/repo/nested"],
        ])
    );
    setWorktreeSelectionAccessor(() => ({ activeWorktreeId: "main", restoreWorktreeId: null }));
  }

  it("matches against the worktree a new panel is bound to, as the pane will", () => {
    seed();
    expect(currentFileEditorDefault("/repo/content/about.json")?.choiceId).toBe(`${ACME}/records`);
    // The pane reads this file through the active worktree, where the path is
    // `nested/content/a.json` — so the opener must not apply the default either.
    expect(currentFileEditorDefault("/repo/nested/content/a.json")).toBeNull();
  });

  it("falls back to the containing worktree, then the project, for a file outside the active one", () => {
    seed();
    setWorktreeSelectionAccessor(() => ({ activeWorktreeId: "other", restoreWorktreeId: null }));
    expect(currentFileEditorDefault("/repo/nested/content/a.json")?.slot).toBe(JSON_SLOT);

    setWorktreePathIndexAccessor(() => null);
    useProjectStore.setState({
      currentProject: { id: "p1", path: "/repo", name: "repo", emoji: "", lastOpened: 0 },
    });
    expect(currentFileEditorDefault("/repo/content/about.json")?.slot).toBe(JSON_SLOT);
  });
});
