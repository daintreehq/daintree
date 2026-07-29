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
 *
 * `worktreeId` rides the base object rather than the per-kind fragment
 * `serializeFileBrowser` returns, so restore carries it separately; supplying
 * one here keeps these cases worktree-rooted, which is what their fixtures
 * describe. The workspace-rooted cases below omit it deliberately.
 */
function asOptions(snapshot: Partial<PanelSnapshot>): FileBrowserPanelOptions {
  const { kind: _kind, ...rest } = snapshot;
  return { ...rest, kind: "file-browser", worktreeId: "wt-1" };
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

  it("round-trips the last-known tree snapshot (#11367)", () => {
    const treeSnapshot = {
      worktreeId: "wt-1",
      rootPath: "",
      listings: [
        {
          dirPath: "",
          nodes: [{ name: "src", path: "src", isDirectory: true }],
        },
      ],
    };
    const panel: FileBrowserPanelData = { ...basePanel, browserTreeSnapshot: treeSnapshot };

    const restored = createFileBrowserDefaults(asOptions(serializeFileBrowser(panel)));

    expect(restored).toEqual({ browserTreeSnapshot: treeSnapshot });
    // A panel that never captured one stays sparse.
    expect(serializeFileBrowser(basePanel)).toEqual({});
  });

  it("round-trips a non-default sidebar width but keeps the 288 default sparse", () => {
    const resized: FileBrowserPanelData = { ...basePanel, browserSidebarWidth: 420 };
    expect(createFileBrowserDefaults(asOptions(serializeFileBrowser(resized)))).toEqual({
      browserSidebarWidth: 420,
    });

    // 288 is the default width, the same state as absent — a reset-to-default or
    // never-resized panel must not persist a width.
    const atDefault: FileBrowserPanelData = { ...basePanel, browserSidebarWidth: 288 };
    expect(serializeFileBrowser(atDefault)).toEqual({});
    expect(serializeFileBrowser(basePanel)).toEqual({});
  });

  it("persists both a collapsed sidebar and a custom width together", () => {
    // Collapse doesn't clear the width, so a panel collapsed while wide keeps
    // both bits — re-opening restores the last-dragged width.
    const both: FileBrowserPanelData = {
      ...basePanel,
      browserSidebarCollapsed: true,
      browserSidebarWidth: 360,
    };
    expect(serializeFileBrowser(both)).toEqual({
      browserSidebarCollapsed: true,
      browserSidebarWidth: 360,
    });
  });

  it("persists workspace rooting so a promoted panel keeps its folder (#11489)", () => {
    // Promotion into the grid adopts the active worktree as a placement key, so
    // by save time an absent worktreeId no longer distinguishes the two — the
    // marker is the only thing that survives to say which folder to browse.
    const promoted: FileBrowserPanelData = {
      ...basePanel,
      worktreeId: "wt-1",
      browserWorkspaceRooted: true,
    };

    expect(serializeFileBrowser(promoted)).toEqual({ browserWorkspaceRooted: true });

    const restored = createFileBrowserDefaults({
      ...asOptions(serializeFileBrowser(promoted)),
      worktreeId: "wt-1",
    });
    expect(restored).toEqual({ browserWorkspaceRooted: true });
  });

  it("keeps a worktree-rooted panel sparse rather than writing the marker false", () => {
    const worktreeRooted: FileBrowserPanelData = {
      ...basePanel,
      worktreeId: "wt-1",
      browserWorkspaceRooted: false,
    };

    expect(serializeFileBrowser(worktreeRooted)).toEqual({});
  });
});

describe("createFileBrowserDefaults", () => {
  it("produces no fields when the opener names a worktree and nothing else", () => {
    // The sidebar entry point opens the browser with nothing but a worktree, so
    // this is the common path — it must not stamp defaults that then persist.
    expect(createFileBrowserDefaults({ kind: "file-browser", worktreeId: "wt-1" })).toEqual({});
  });

  it("marks a panel opened without a worktree as workspace-rooted (#11489)", () => {
    expect(createFileBrowserDefaults({ kind: "file-browser" })).toEqual({
      browserWorkspaceRooted: true,
    });
  });

  it("treats an unresolvable empty worktree id as naming a worktree, not as absent", () => {
    // Fail closed, matching the pane's presence check: "" names a worktree that
    // cannot resolve, and browsing the workspace root instead would be the wrong
    // folder rather than a degraded one.
    expect(createFileBrowserDefaults({ kind: "file-browser", worktreeId: "" })).toEqual({});
  });

  it("keeps a restored workspace-rooted panel workspace-rooted despite an adopted worktree", () => {
    // The shape a promoted panel persists: grid placement stamped a worktreeId
    // on it (#11290), so only the marker still tells the two apart.
    expect(
      createFileBrowserDefaults({
        kind: "file-browser",
        worktreeId: "wt-1",
        browserWorkspaceRooted: true,
      })
    ).toEqual({ browserWorkspaceRooted: true });
  });
});
