import { describe, expect, it } from "vitest";
import type { FileBrowserPanelOptions } from "@shared/types/addPanelOptions";
import type { FileBrowserPanelData } from "@shared/types/panel";
import type { PanelSnapshot } from "@shared/types/project";
import { createFileBrowserDefaults } from "../defaults";
import { serializeFileBrowser } from "../serializer";

const basePanel: FileBrowserPanelData = {
  id: "panel-1",
  title: "Files",
  location: "grid",
  kind: "file-browser",
};

/**
 * Re-enter the create path with a serialized snapshot fragment. The snapshot is
 * a flat bag shared by every kind, so its `kind` is the open `PanelKind` union
 * — pin the discriminant here rather than spreading it through.
 */
function asOptions(snapshot: Partial<PanelSnapshot>): FileBrowserPanelOptions {
  const { kind: _kind, ...rest } = snapshot;
  return { ...rest, kind: "file-browser" };
}

describe("serializeFileBrowser", () => {
  it("omits fields the panel never set rather than writing undefined", () => {
    expect(serializeFileBrowser(basePanel)).toEqual({});
  });

  it("round-trips through createFileBrowserDefaults without losing a field", () => {
    const panel: FileBrowserPanelData = {
      ...basePanel,
      browserSelectedPath: "src/app.ts",
      browserExpandedPaths: ["src", "src/lib"],
      browserHideDotfiles: true,
    };

    const restored = createFileBrowserDefaults(asOptions(serializeFileBrowser(panel)));

    expect(restored).toEqual({
      browserSelectedPath: "src/app.ts",
      browserExpandedPaths: ["src", "src/lib"],
      browserHideDotfiles: true,
    });
  });

  it("preserves an explicitly-disabled dotfile toggle through the round trip", () => {
    // A truthiness check anywhere in the pair would drop `false` and let the
    // default silently override a deliberate choice.
    const panel: FileBrowserPanelData = { ...basePanel, browserHideDotfiles: false };

    const restored = createFileBrowserDefaults(asOptions(serializeFileBrowser(panel)));

    expect(restored.browserHideDotfiles).toBe(false);
  });

  it("does not carry a legacy browserShowIgnored value into the new dotfile field", () => {
    // The old field's meaning was inverted; an old panel that showed gitignored
    // files must NOT hydrate as hiding dotfiles (#10938-class trap). The
    // serializer only knows the new field, so the stale key is simply dropped.
    const legacy = { ...basePanel, browserShowIgnored: true } as FileBrowserPanelData;

    const snapshot = serializeFileBrowser(legacy);

    expect(snapshot).not.toHaveProperty("browserHideDotfiles");
    expect(snapshot).not.toHaveProperty("browserShowIgnored");
  });

  it("preserves an empty expansion list, which is not the same as never expanding", () => {
    const panel: FileBrowserPanelData = { ...basePanel, browserExpandedPaths: [] };

    expect(serializeFileBrowser(panel)).toEqual({ browserExpandedPaths: [] });
  });

  it("round-trips a non-root browse root but drops the worktree-root sentinel", () => {
    const rooted: FileBrowserPanelData = { ...basePanel, browserRootPath: "src/panels" };
    expect(createFileBrowserDefaults(asOptions(serializeFileBrowser(rooted)))).toEqual({
      browserRootPath: "src/panels",
    });

    // "" and absent are the same state; persisting "" would be pure noise.
    const reset: FileBrowserPanelData = { ...basePanel, browserRootPath: "" };
    expect(serializeFileBrowser(reset)).toEqual({});
  });

  it("round-trips a collapsed sidebar but keeps the open default sparse", () => {
    const collapsed: FileBrowserPanelData = { ...basePanel, browserSidebarCollapsed: true };
    expect(createFileBrowserDefaults(asOptions(serializeFileBrowser(collapsed)))).toEqual({
      browserSidebarCollapsed: true,
    });

    // `false` is the default open state, the same as absent — persisting it
    // would be noise, so neither an explicit `false` nor an omitted field writes.
    const open: FileBrowserPanelData = { ...basePanel, browserSidebarCollapsed: false };
    expect(serializeFileBrowser(open)).toEqual({});
    expect(serializeFileBrowser(basePanel)).toEqual({});
  });
});

describe("createFileBrowserDefaults", () => {
  it("produces no fields when the opener passes only the kind", () => {
    // The sidebar entry point opens the browser with nothing but a worktree, so
    // this is the common path — it must not stamp defaults that then persist.
    expect(createFileBrowserDefaults({ kind: "file-browser" })).toEqual({});
  });
});
