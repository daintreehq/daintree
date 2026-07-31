import { describe, it, expect } from "vitest";
import {
  FILE_DRAG_MIME,
  decodeFileDragPaths,
  encodeFileDragPaths,
  hasFileDrag,
  hasInternalFileDrag,
} from "../fileDragPayload";

/** What a drop handler actually receives: whatever survived the round trip. */
function roundTrip(paths: readonly string[]): string[] | null {
  return decodeFileDragPaths(encodeFileDragPaths(paths));
}

describe("fileDragPayload", () => {
  // Chromium lowercases custom `dataTransfer` types on the way in, so a
  // constant carrying any uppercase letter would never match what `types`
  // reports back at the drop site.
  it("uses a type string Chromium will hand back unchanged", () => {
    expect(FILE_DRAG_MIME).toBe(FILE_DRAG_MIME.toLowerCase());
  });

  it("round-trips a single path", () => {
    expect(roundTrip(["/repo/src/App.tsx"])).toEqual(["/repo/src/App.tsx"]);
  });

  // The tree is single-select today, so nothing exercises this yet — the
  // transport is shaped for the multi-select follow-up, and order is what
  // decides the order the references are inserted in.
  it("preserves order and duplicates across several paths", () => {
    const paths = ["/repo/b.ts", "/repo/a.ts", "/repo/b.ts"];
    expect(roundTrip(paths)).toEqual(paths);
  });

  it("round-trips paths whose spelling the token formatter has to quote", () => {
    const paths = ["/repo/my notes.md", "/repo/it's here.txt", "/repo/diff:staged"];
    expect(roundTrip(paths)).toEqual(paths);
  });

  it("round-trips Windows drive and UNC paths", () => {
    expect(roundTrip(["C:/repo/src/App.tsx"])).toEqual(["C:/repo/src/App.tsx"]);
    expect(roundTrip(["//server/share/App.tsx"])).toEqual(["//server/share/App.tsx"]);
  });

  // Everything below reaches a drop handler as an attacker-shaped or
  // simply-not-ours string: `getData` returns whatever the drag source wrote,
  // and the type check that got us here only proves the type is present.
  it("rejects malformed JSON", () => {
    expect(decodeFileDragPaths("")).toBeNull();
    expect(decodeFileDragPaths("{")).toBeNull();
    expect(decodeFileDragPaths("/repo/App.tsx")).toBeNull();
  });

  it("rejects JSON that is not an array of paths", () => {
    expect(decodeFileDragPaths(JSON.stringify({ paths: ["/repo/App.tsx"] }))).toBeNull();
    expect(decodeFileDragPaths(JSON.stringify("/repo/App.tsx"))).toBeNull();
    expect(decodeFileDragPaths(JSON.stringify(null))).toBeNull();
    expect(decodeFileDragPaths(JSON.stringify([1, 2]))).toBeNull();
    expect(decodeFileDragPaths(JSON.stringify(["/repo/App.tsx", null]))).toBeNull();
  });

  it("rejects an empty payload rather than reporting an empty drop", () => {
    expect(roundTrip([])).toBeNull();
  });

  // A relative path names nothing the receiving agent could open: its cwd is
  // its own worktree, not the file browser's base path.
  it("rejects relative and empty paths", () => {
    expect(roundTrip(["src/App.tsx"])).toBeNull();
    expect(roundTrip([""])).toBeNull();
    expect(roundTrip(["/repo/App.tsx", "src/App.tsx"])).toBeNull();
  });

  describe("type gates", () => {
    it("recognizes an in-app drag", () => {
      expect(hasInternalFileDrag([FILE_DRAG_MIME])).toBe(true);
      expect(hasInternalFileDrag(["Files"])).toBe(false);
      expect(hasInternalFileDrag([])).toBe(false);
    });

    // The gate every dragenter/dragover handler shares, so the hybrid input
    // and the terminal cannot drift on which drags light up their affordance.
    it("accepts either an OS file drag or an in-app one", () => {
      expect(hasFileDrag(["Files"])).toBe(true);
      expect(hasFileDrag([FILE_DRAG_MIME])).toBe(true);
      expect(hasFileDrag([FILE_DRAG_MIME, "Files"])).toBe(true);
    });

    // Text is the drag every editable surface in the app already accepts on
    // its own terms; claiming it here would hijack ordinary text drops.
    it("ignores a text-only drag", () => {
      expect(hasFileDrag(["text/plain"])).toBe(false);
      expect(hasFileDrag(["text/plain", "text/uri-list"])).toBe(false);
      expect(hasFileDrag([])).toBe(false);
    });
  });
});
