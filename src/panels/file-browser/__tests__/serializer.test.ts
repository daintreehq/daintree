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
      browserShowIgnored: true,
    };

    const restored = createFileBrowserDefaults(asOptions(serializeFileBrowser(panel)));

    expect(restored).toEqual({
      browserSelectedPath: "src/app.ts",
      browserExpandedPaths: ["src", "src/lib"],
      browserShowIgnored: true,
    });
  });

  it("preserves an explicitly-disabled ignored toggle through the round trip", () => {
    // A truthiness check anywhere in the pair would drop `false` and let the
    // default silently override a deliberate choice.
    const panel: FileBrowserPanelData = { ...basePanel, browserShowIgnored: false };

    const restored = createFileBrowserDefaults(asOptions(serializeFileBrowser(panel)));

    expect(restored.browserShowIgnored).toBe(false);
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
});

describe("createFileBrowserDefaults", () => {
  it("produces no fields when the opener passes only the kind", () => {
    // The sidebar entry point opens the browser with nothing but a worktree, so
    // this is the common path — it must not stamp defaults that then persist.
    expect(createFileBrowserDefaults({ kind: "file-browser" })).toEqual({});
  });
});
