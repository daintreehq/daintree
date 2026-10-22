import { describe, expect, it } from "vitest";
import {
  isFileEditorChoiceKey,
  type HostedFileEditorDescriptor,
  type PluginHostedViewDescriptor,
} from "@shared/types/plugin";
import {
  HOST_FILE_EDITOR_CHOICE,
  fileEditorChoiceKey,
  pickFileEditorChoice,
  pluginFileEditorCandidates,
} from "../fileEditorRegistry";

function editor(overrides: Partial<HostedFileEditorDescriptor> = {}): HostedFileEditorDescriptor {
  return { id: "main", mode: "edit", extensions: [], paths: [], maxBytes: 1024, ...overrides };
}

function view(
  pluginId: string,
  editors: HostedFileEditorDescriptor[],
  location: PluginHostedViewDescriptor["location"] = "fileEditor"
): PluginHostedViewDescriptor {
  return {
    id: `plugin-view:${pluginId}/editor`,
    pluginId,
    viewId: "editor",
    location,
    name: `${pluginId} fileEditor`,
    componentPath: `plugin://${pluginId}/editor.js`,
    fileEditors: editors,
  };
}

const options = (overrides: Partial<Parameters<typeof pluginFileEditorCandidates>[1]> = {}) => ({
  filePath: "/repo/content/a.json",
  rootPath: "/repo",
  mode: "edit" as const,
  disabled: new Set<string>(),
  displayNameOf: (pluginId: string) => `Name of ${pluginId}`,
  ...overrides,
});

describe("pluginFileEditorCandidates (#13809)", () => {
  it("matches by extension and by project-relative path, for the asked mode only", () => {
    const views = [
      view("zeta", [editor({ extensions: ["json"] })]),
      view("alpha", [editor({ paths: ["content/*.json"] })]),
      view("beta", [editor({ extensions: ["json"], mode: "view" })]),
      view("gamma", [editor({ paths: ["other/*.json"] })]),
    ];
    const found = pluginFileEditorCandidates(views, options());
    expect(found.map((c) => c.choiceId)).toEqual(["alpha/main", "zeta/main"]);
    expect(found[0]?.pluginName).toBe("Name of alpha");
  });

  it("orders deterministically regardless of snapshot order", () => {
    const a = view("a", [
      editor({ id: "y", extensions: ["json"] }),
      editor({ id: "x", extensions: ["json"] }),
    ]);
    const b = view("b", [editor({ extensions: ["json"] })]);
    const forward = pluginFileEditorCandidates([a, b], options()).map((c) => c.choiceId);
    const backward = pluginFileEditorCandidates([b, a], options()).map((c) => c.choiceId);
    expect(forward).toEqual(["a/x", "a/y", "b/main"]);
    expect(backward).toEqual(forward);
  });

  it("skips disabled plugins, non-editor views, an unknown snapshot and paths outside the root", () => {
    const views = [
      view("off", [editor({ extensions: ["json"] })]),
      view("settings", [editor({ extensions: ["json"] })], "settings"),
      view("pathy", [editor({ paths: ["**/*.json"] })]),
    ];
    expect(
      pluginFileEditorCandidates(
        views,
        options({ disabled: new Set(["off"]), filePath: "/elsewhere/a.json" })
      )
    ).toEqual([]);
    expect(pluginFileEditorCandidates(null, options())).toEqual([]);
  });
});

describe("pickFileEditorChoice", () => {
  const key = fileEditorChoiceKey("edit", "/repo/a.json");

  it("keys by mode and lower-case extension, or * without one", () => {
    expect(key).toBe("edit:json");
    expect(fileEditorChoiceKey("view", "/repo/DATA.CSV")).toBe("view:csv");
    expect(fileEditorChoiceKey("edit", "/repo/Makefile")).toBe("edit:*");
    // A suffix no manifest could name shares the extensionless answer, so the
    // key always survives main's validation.
    expect(fileEditorChoiceKey("edit", "/repo/notes.draft-v2")).toBe("edit:*");
    expect(
      isFileEditorChoiceKey(fileEditorChoiceKey("edit", "/repo/a.averyveryverylongsuffix"))
    ).toBe(true);
  });

  it("keeps the host first unless the user picked something still on offer", () => {
    const opts = [HOST_FILE_EDITOR_CHOICE, "acme/main"];
    expect(pickFileEditorChoice(opts, {}, key)).toBe(HOST_FILE_EDITOR_CHOICE);
    expect(pickFileEditorChoice(opts, { [key]: "acme/main" }, key)).toBe("acme/main");
    expect(pickFileEditorChoice(opts, { [key]: "gone/main" }, key)).toBe(HOST_FILE_EDITOR_CHOICE);
    expect(pickFileEditorChoice([], {}, key)).toBeNull();
  });
});
