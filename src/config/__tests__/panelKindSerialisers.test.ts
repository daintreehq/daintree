import { describe, it, expect } from "vitest";
import type { FileTreeNode } from "@shared/types";
import type { FileBrowserPanelData } from "@shared/types/panel";
import {
  flattenTree,
  listingsFromSnapshot,
  snapshotFromListings,
} from "@/panels/file-browser/fileBrowserTree";
import { serializeFileBrowser } from "@/panels/file-browser/serializer";
import { createFileBrowserDefaults } from "@/panels/file-browser/defaults";
import { getDeserializer } from "../panelKindSerialisers";

describe("panelKindSerialisers", () => {
  describe("browser", () => {
    it("extracts browser fields", () => {
      const deserialize = getDeserializer("browser");
      const result = deserialize!({
        id: "b1",
        browserUrl: "https://example.com",
        browserHistory: { past: [], present: "", future: [] },
        browserZoom: 1.5,
        browserConsoleOpen: true,
      });
      expect(result).toEqual({
        browserUrl: "https://example.com",
        browserHistory: { past: [], present: "", future: [] },
        browserZoom: 1.5,
        browserConsoleOpen: true,
      });
    });

    it("returns undefined for missing optional fields", () => {
      const deserialize = getDeserializer("browser");
      const result = deserialize!({ id: "b1" });
      expect(result.browserUrl).toBeUndefined();
      expect(result.browserConsoleOpen).toBeUndefined();
    });
  });

  describe("dev-preview", () => {
    it("extracts dev-preview fields", () => {
      const deserialize = getDeserializer("dev-preview");
      const result = deserialize!({
        id: "d1",
        devCommand: "npm run dev",
        browserUrl: "http://localhost:5173",
        browserZoom: 1.0,
        devPreviewConsoleOpen: true,
        createdAt: 100,
      });
      expect(result).toEqual({
        devCommand: "npm run dev",
        browserUrl: "http://localhost:5173",
        browserZoom: 1.0,
        devPreviewConsoleOpen: true,
        createdAt: 100,
        browserHistory: undefined,
        viewportPreset: undefined,
        viewportRotated: false,
        viewportDpr: 1,
        viewportFit: false,
        devPreviewScrollPosition: undefined,
      });
    });

    it("falls back from devCommand to command", () => {
      const deserialize = getDeserializer("dev-preview");
      const result = deserialize!({ id: "d1", command: "  npm start  " });
      expect(result.devCommand).toBe("npm start");
    });

    it("returns undefined devCommand when both missing", () => {
      const deserialize = getDeserializer("dev-preview");
      const result = deserialize!({ id: "d1" });
      expect(result.devCommand).toBeUndefined();
    });

    it("keeps a known viewportPreset and round-trips emulation fields", () => {
      const deserialize = getDeserializer("dev-preview");
      const result = deserialize!({
        id: "d1",
        viewportPreset: "ipad",
        viewportRotated: true,
        viewportDpr: 2,
        viewportFit: true,
      });
      expect(result.viewportPreset).toBe("ipad");
      expect(result.viewportRotated).toBe(true);
      expect(result.viewportDpr).toBe(2);
      expect(result.viewportFit).toBe(true);
    });

    it("drops a stale/unknown viewportPreset id instead of resurrecting it", () => {
      const deserialize = getDeserializer("dev-preview");
      const result = deserialize!({ id: "d1", viewportPreset: "nokia" });
      expect(result.viewportPreset).toBeUndefined();
    });

    it("clamps an out-of-range persisted viewportDpr to 1", () => {
      const deserialize = getDeserializer("dev-preview");
      const result = deserialize!({
        id: "d1",
        viewportDpr: 5 as unknown as 1 | 2 | 3,
      });
      expect(result.viewportDpr).toBe(1);
    });
  });

  describe("file-browser", () => {
    const deserialize = () => getDeserializer("file-browser")!;

    it("keeps safe relative paths and drops everything that could escape the root", () => {
      const result = deserialize()({
        id: "fb1",
        browserExpandedPaths: [
          "src",
          "src/lib",
          "/etc",
          "../secrets",
          "a/../../b",
          "..\\..\\windows",
          "C:\\Users",
          "\\\\server\\share",
          "",
          42,
          null,
          { nope: true },
        ],
      });

      expect(result.browserExpandedPaths).toEqual(["src", "src/lib"]);
    });

    it("rejects traversal written with backslashes, not just forward slashes", () => {
      // A snapshot written on Windows can be opened on POSIX and vice versa, so
      // the sanitizer can't assume one separator convention.
      const result = deserialize()({
        id: "fb1",
        browserExpandedPaths: ["ok", "nested\\..\\..\\escape"],
      });

      expect(result.browserExpandedPaths).toEqual(["ok"]);
    });

    it("deduplicates and caps a pathological expansion list", () => {
      const huge = Array.from({ length: 5000 }, (_, index) => `dir-${index % 900}`);

      const result = deserialize()({ id: "fb1", browserExpandedPaths: huge });
      const restored = result.browserExpandedPaths ?? [];

      // Every surviving entry becomes a directory the browser re-lists on each
      // refresh, so this is a work bound rather than a cosmetic one.
      expect(restored.length).toBeLessThanOrEqual(500);
      expect(new Set(restored).size).toBe(restored.length);
    });

    it("preserves a legitimately empty expansion list", () => {
      // "The user had nothing expanded" is a real state, distinct from "this
      // panel predates the field".
      expect(deserialize()({ id: "fb1", browserExpandedPaths: [] }).browserExpandedPaths).toEqual(
        []
      );
    });

    it("returns undefined when the persisted value is not a list at all", () => {
      expect(
        deserialize()({ id: "fb1", browserExpandedPaths: "src" }).browserExpandedPaths
      ).toBeUndefined();
    });

    it("drops a non-string selected path rather than handing the pane an object", () => {
      // The snapshot schema passes unknown keys through, so this shape survives
      // main-process validation and would be `.split("/")` by the pane.
      expect(
        deserialize()({ id: "fb1", browserSelectedPath: {} }).browserSelectedPath
      ).toBeUndefined();
      expect(
        deserialize()({ id: "fb1", browserSelectedPath: "../escape" }).browserSelectedPath
      ).toBeUndefined();
      expect(
        deserialize()({ id: "fb1", browserSelectedPath: "src/app.ts" }).browserSelectedPath
      ).toBe("src/app.ts");
    });

    it("drops a non-boolean dotfile toggle rather than coercing it", () => {
      expect(
        deserialize()({ id: "fb1", browserHideDotfiles: "yes" }).browserHideDotfiles
      ).toBeUndefined();
      expect(deserialize()({ id: "fb1", browserHideDotfiles: false }).browserHideDotfiles).toBe(
        false
      );
    });

    it("restores a collapsed sidebar only from a literal true", () => {
      // Only `true` collapses; `false` and absent are the open default, and a
      // corrupted string/object must fall back to open rather than crash the pane.
      expect(
        deserialize()({ id: "fb1", browserSidebarCollapsed: true }).browserSidebarCollapsed
      ).toBe(true);
      expect(
        deserialize()({ id: "fb1", browserSidebarCollapsed: false }).browserSidebarCollapsed
      ).toBeUndefined();
      expect(
        deserialize()({ id: "fb1", browserSidebarCollapsed: "yes" }).browserSidebarCollapsed
      ).toBeUndefined();
      expect(deserialize()({ id: "fb1" }).browserSidebarCollapsed).toBeUndefined();
    });

    it("ignores a legacy browserShowIgnored key instead of migrating it", () => {
      // The old field is unknown to the deserializer now; a persisted `true`
      // must not resurface as the inverted new toggle (#10938 / #11330).
      // Bound to a variable so the removed key isn't an object-literal excess
      // property — a persisted blob really can carry unknown keys.
      const legacy = { id: "fb1", browserShowIgnored: true };
      const output = deserialize()(legacy);
      expect(output.browserHideDotfiles).toBeUndefined();
      expect(output).not.toHaveProperty("browserShowIgnored");
    });

    describe("browserTreeSnapshot (#11367)", () => {
      const validSnapshot = {
        worktreeId: "wt-1",
        rootPath: "",
        listings: [
          {
            dirPath: "",
            nodes: [
              { name: "src", path: "src", isDirectory: true },
              { name: "README.md", path: "README.md", isDirectory: false },
            ],
          },
          {
            dirPath: "src",
            nodes: [{ name: "app.ts", path: "src/app.ts", isDirectory: false }],
          },
        ],
      };

      it("restores a well-formed snapshot intact", () => {
        expect(
          deserialize()({ id: "fb1", browserTreeSnapshot: validSnapshot }).browserTreeSnapshot
        ).toEqual(validSnapshot);
      });

      it("restores a snapshot rooted at a subfolder whose root listing is present", () => {
        const rooted = {
          worktreeId: "wt-1",
          rootPath: "src",
          listings: [
            { dirPath: "src", nodes: [{ name: "app.ts", path: "src/app.ts", isDirectory: false }] },
          ],
        };
        expect(
          deserialize()({ id: "fb1", browserTreeSnapshot: rooted }).browserTreeSnapshot
        ).toEqual(rooted);
      });

      it("drops the whole snapshot on any malformed element rather than partially trusting it", () => {
        // A partially trusted snapshot could seed rows for paths that were
        // never listed; the cost of dropping is only a cold start.
        const malformed: unknown[] = [
          "not an object",
          42,
          [],
          { ...validSnapshot, worktreeId: "" },
          { ...validSnapshot, worktreeId: 7 },
          { ...validSnapshot, rootPath: "../escape" },
          { ...validSnapshot, listings: "nope" },
          // Duplicate directory keys.
          {
            ...validSnapshot,
            listings: [validSnapshot.listings[0], validSnapshot.listings[0]],
          },
          // Escaping node path.
          {
            ...validSnapshot,
            listings: [{ dirPath: "", nodes: [{ name: "x", path: "../x", isDirectory: false }] }],
          },
          // Separator inside a basename.
          {
            ...validSnapshot,
            listings: [{ dirPath: "", nodes: [{ name: "a/b", path: "a", isDirectory: false }] }],
          },
          // Non-boolean directory bit.
          {
            ...validSnapshot,
            listings: [{ dirPath: "", nodes: [{ name: "a", path: "a", isDirectory: "yes" }] }],
          },
          // Non-canonical child edge: the node's path is not dirPath/name, so
          // it could impersonate a row that was never listed under this parent
          // (and dodge the per-name visibility filter).
          {
            ...validSnapshot,
            listings: [
              { dirPath: "", nodes: [{ name: "README.md", path: ".env", isDirectory: false }] },
            ],
          },
          // Self-cycle with a duplicate edge: `a` listing `a` twice. Each
          // traversal level would double until the depth guard — the
          // canonical-edge rule (a child path is strictly longer than its
          // parent's) is what rules this class out entirely.
          {
            worktreeId: "wt-1",
            rootPath: "",
            listings: [
              { dirPath: "", nodes: [{ name: "a", path: "a", isDirectory: true }] },
              {
                dirPath: "a",
                nodes: [
                  { name: "a", path: "a", isDirectory: true },
                  { name: "a", path: "a", isDirectory: true },
                ],
              },
            ],
          },
          // Duplicate names within one listing → duplicate row paths, and
          // FlatTreeRow.path doubles as the React key.
          {
            ...validSnapshot,
            listings: [
              {
                dirPath: "",
                nodes: [
                  { name: "src", path: "src", isDirectory: true },
                  { name: "src", path: "src", isDirectory: false },
                ],
              },
            ],
          },
          // Traversal-shaped basenames.
          {
            ...validSnapshot,
            listings: [{ dirPath: "", nodes: [{ name: "..", path: "..", isDirectory: true }] }],
          },
          {
            ...validSnapshot,
            listings: [{ dirPath: "", nodes: [{ name: ".", path: ".", isDirectory: true }] }],
          },
          // Control characters survive the canonical-join check alone; the
          // composite path must still pass the character screen.
          {
            ...validSnapshot,
            listings: [
              {
                dirPath: "",
                nodes: [{ name: "bad\u0000name", path: "bad\u0000name", isDirectory: false }],
              },
            ],
          },
          // Drive-qualified basename at the root.
          {
            ...validSnapshot,
            listings: [{ dirPath: "", nodes: [{ name: "C:", path: "C:", isDirectory: true }] }],
          },
          // Unbounded worktree id.
          { ...validSnapshot, worktreeId: "w".repeat(5000) },
        ];
        for (const value of malformed) {
          expect(
            deserialize()({ id: "fb1", browserTreeSnapshot: value }).browserTreeSnapshot,
            `should drop: ${JSON.stringify(value)}`
          ).toBeUndefined();
        }
      });

      it("drops a snapshot missing its own root listing — there is nothing to paint from", () => {
        const rootless = {
          worktreeId: "wt-1",
          rootPath: "",
          listings: [
            { dirPath: "src", nodes: [{ name: "app.ts", path: "src/app.ts", isDirectory: false }] },
          ],
        };
        expect(
          deserialize()({ id: "fb1", browserTreeSnapshot: rootless }).browserTreeSnapshot
        ).toBeUndefined();
      });

      it("drops a snapshot that exceeds the node budget instead of truncating it", () => {
        const oversized = {
          worktreeId: "wt-1",
          rootPath: "",
          listings: [
            {
              dirPath: "",
              nodes: Array.from({ length: 10_001 }, (_, i) => ({
                name: `f-${i}`,
                path: `f-${i}`,
                isDirectory: false,
              })),
            },
          ],
        };
        expect(
          deserialize()({ id: "fb1", browserTreeSnapshot: oversized }).browserTreeSnapshot
        ).toBeUndefined();
      });

      it("keeps an empty root listing — an empty worktree is a real last-known state", () => {
        const empty = { worktreeId: "wt-1", rootPath: "", listings: [{ dirPath: "", nodes: [] }] };
        expect(
          deserialize()({ id: "fb1", browserTreeSnapshot: empty }).browserTreeSnapshot
        ).toEqual(empty);
      });

      it("counts listing keys against the text budget, not just node text", () => {
        // 200 empty listings with ~4k-character keys carry real bytes even
        // with zero nodes — the budget must see them.
        const longDir = "d".repeat(3900);
        const bloatedKeys = {
          worktreeId: "wt-1",
          rootPath: "",
          listings: [
            { dirPath: "", nodes: [] },
            ...Array.from({ length: 200 }, (_, i) => ({
              dirPath: `${longDir}-${i}`,
              nodes: [],
            })),
          ],
        };
        expect(
          deserialize()({ id: "fb1", browserTreeSnapshot: bloatedKeys }).browserTreeSnapshot
        ).toBeUndefined();
      });

      it("drops a snapshot whose aggregate text exceeds the byte budget", () => {
        // Node and listing counts alone don't bound serialized size; a few
        // hundred long paths must trip the text budget instead.
        const longName = "n".repeat(4000);
        const oversizedText = {
          worktreeId: "wt-1",
          rootPath: "",
          listings: [
            {
              dirPath: "",
              nodes: Array.from({ length: 100 }, (_, i) => ({
                name: `${longName}-${i}`,
                path: `${longName}-${i}`,
                isDirectory: false,
              })),
            },
          ],
        };
        expect(
          deserialize()({ id: "fb1", browserTreeSnapshot: oversizedText }).browserTreeSnapshot
        ).toBeUndefined();
      });

      it("round-trips capture → serialize → JSON → sanitize → seed back to the same painted rows", () => {
        // The full carrier chain a real restore takes. A break at any stage —
        // capture shape, serializer omission, sanitizer over-strictness,
        // seed decoding — fails here even if each stage's own tests pass.
        const live = new Map<string, readonly FileTreeNode[]>([
          [
            "",
            [
              { name: "src", path: "src", isDirectory: true, size: 0 },
              { name: "README.md", path: "README.md", isDirectory: false, size: 120 },
            ],
          ],
          ["src", [{ name: "app.ts", path: "src/app.ts", isDirectory: false, size: 99 }]],
        ]);
        const captured = snapshotFromListings(live, "wt-1", "");
        expect(captured).not.toBeNull();

        const panel: FileBrowserPanelData = {
          id: "fb1",
          title: "Files",
          location: "grid",
          kind: "file-browser",
          browserTreeSnapshot: captured!,
        };
        const persisted = JSON.parse(JSON.stringify(serializeFileBrowser(panel)));
        const restoredArgs = deserialize()({ id: "fb1", ...persisted });
        // Spread first, then pin the discriminant: restoredArgs' type carries
        // the open PanelKind union, which must not widen the literal.
        const defaults = createFileBrowserDefaults({
          ...restoredArgs,
          kind: "file-browser",
        });
        expect(defaults.browserTreeSnapshot).toBeDefined();

        const seeded = listingsFromSnapshot(defaults.browserTreeSnapshot!);
        const rows = flattenTree(seeded, new Set(["src"]), new Set());
        expect(rows.map((row) => row.path)).toEqual(
          flattenTree(live, new Set(["src"]), new Set()).map((row) => row.path)
        );
      });
    });
  });

  describe("unknown kind", () => {
    it("returns undefined for unregistered kind", () => {
      expect(getDeserializer("terminal")).toBeUndefined();
      expect(getDeserializer("agent")).toBeUndefined();
      expect(getDeserializer("custom-ext")).toBeUndefined();
    });
  });
});
