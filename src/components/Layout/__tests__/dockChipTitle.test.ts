import { describe, it, expect } from "vitest";
import type {
  BrowserPanelData,
  FileBrowserPanelData,
  FilePanelData,
  PanelInstance,
} from "@shared/types/panel";
import { dockChipTitle } from "../dockChipTitle";
import { composeFileBrowserTitle } from "@/panels/file-browser/title";

function fileBrowser(overrides: Partial<FileBrowserPanelData> = {}): FileBrowserPanelData {
  return {
    id: "fb1",
    kind: "file-browser",
    title: composeFileBrowserTitle("develop"),
    location: "dock",
    ...overrides,
  } as FileBrowserPanelData;
}

describe("dockChipTitle — file browser (#11917)", () => {
  it("drops the composed prefix so the chip spends its width on the folder", () => {
    // The point of the derivation: "Files — " is a constant eight characters of
    // a ~140px label, so a long branch name would truncate to the half every
    // browser shares.
    const title = dockChipTitle(
      fileBrowser({ title: composeFileBrowserTitle("feature/issue-11917-dockable") })
    );
    expect(title).toBe("feature/issue-11917-dockable");
  });

  it("names the scoped folder ahead of the root the panel was opened on", () => {
    expect(dockChipTitle(fileBrowser({ browserRootPath: "src/components" }))).toBe("components");
  });

  it("ignores the viewer target so arrowing through the tree can't relabel the chip", () => {
    // Deliberately NOT the file-panel derivation: the docked surface is the
    // tree, and a label that moved with the selection would churn while reading.
    const stable = fileBrowser({ browserSelectedPath: "src/app.ts" });
    const moved = fileBrowser({ browserSelectedPath: "src/other.ts" });
    expect(dockChipTitle(stable)).toBe(dockChipTitle(moved));
    expect(dockChipTitle(stable)).toBe("develop");
  });

  it("keeps a user-locked rename over both structural fields", () => {
    const renamed = fileBrowser({
      title: "My notes",
      titleMode: "user",
      browserRootPath: "src/components",
      browserSelectedPath: "src/app.ts",
    });
    expect(dockChipTitle(renamed)).toBe("My notes");
  });

  it("returns a title it did not compose unchanged rather than guessing at it", () => {
    expect(dockChipTitle(fileBrowser({ title: "Scratch files" }))).toBe("Scratch files");
  });

  it("is never blank, even for a record carrying no title at all", () => {
    expect(dockChipTitle(fileBrowser({ title: "" }))).toBe("Files");
  });

  it("reads a scoped root written with either separator", () => {
    expect(dockChipTitle(fileBrowser({ browserRootPath: "src\\components\\" }))).toBe("components");
  });
});

describe("dockChipTitle — the derivations it dispatches to still hold", () => {
  it("labels a file panel with its basename and a browser with its host", () => {
    const filePanel = {
      id: "f1",
      kind: "file",
      title: "File",
      location: "dock",
      filePath: "/repo/src/spec.md",
    } as FilePanelData;
    const browserPanel = {
      id: "b1",
      kind: "browser",
      title: "Browser",
      location: "dock",
      browserUrl: "https://example.com:8080/some/path",
    } as BrowserPanelData;

    expect(dockChipTitle(filePanel)).toBe("spec.md");
    expect(dockChipTitle(browserPanel)).toBe("example.com:8080");
  });

  it("falls back to the panel title for a kind with no derivation of its own", () => {
    // Plugin view panels (#11332) take this branch — the chip must not assume
    // one of the built-in shapes.
    const plugin = {
      id: "x1",
      kind: "acme.viewer",
      title: "Acme Viewer",
      location: "dock",
    } as unknown as PanelInstance;
    expect(dockChipTitle(plugin)).toBe("Acme Viewer");
  });
});
