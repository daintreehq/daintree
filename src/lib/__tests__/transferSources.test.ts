// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaterializeSource } from "@shared/types/remoteHosts";
import { setRemoteMaterializer } from "@/services/materialize";
import { FILE_DRAG_MIME, encodeFileDragPaths } from "../fileDragPayload";
import {
  materializeTransferSources,
  resolveLocalFileSources,
  resolveTransferSources,
  toMaterializeSource,
} from "../transferSources";

/** The native path the OS would report for each test file; absent means none. */
const nativePaths = new WeakMap<File, string>();

const getDroppedFilePaths = vi.fn((files: readonly File[]) =>
  files.map((file) => nativePaths.get(file) ?? "")
);

function fileAt(name: string, path?: string, content = ""): File {
  const file = new File([content], name);
  if (path !== undefined) nativePaths.set(file, path);
  return file;
}

function transfer(options: { files?: File[]; internal?: string }) {
  return {
    types: [
      ...(options.files ? ["Files"] : []),
      ...(options.internal !== undefined ? [FILE_DRAG_MIME] : []),
    ],
    files: options.files ?? [],
    getData: (type: string) => (type === FILE_DRAG_MIME ? (options.internal ?? "") : ""),
  };
}

beforeEach(() => {
  getDroppedFilePaths.mockClear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { files: { getDroppedFilePaths } },
  });
});

afterEach(() => {
  setRemoteMaterializer(null);
  Reflect.deleteProperty(window, "electron");
});

describe("resolveLocalFileSources", () => {
  it("resolves every file in one bridge call, keeping the OS name and size", () => {
    const a = fileAt(" a.ts", "/Users/test/a.ts", "12345");
    const b = fileAt("b.png", "/Users/test/b.png");

    expect(resolveLocalFileSources([a, b])).toEqual([
      { kind: "local", path: "/Users/test/a.ts", name: " a.ts", size: 5 },
      { kind: "local", path: "/Users/test/b.png", name: "b.png", size: 0 },
    ]);
    expect(getDroppedFilePaths).toHaveBeenCalledTimes(1);
    expect(getDroppedFilePaths).toHaveBeenCalledWith([a, b]);
  });

  it("leaves out a file the OS would not resolve, and keeps the rest in order", () => {
    const sources = resolveLocalFileSources([
      fileAt("a.ts", "/Users/test/a.ts"),
      fileAt("virtual.txt"),
      fileAt("c.ts", "/Users/test/c.ts"),
    ]);

    expect(sources.map((source) => source.path)).toEqual(["/Users/test/a.ts", "/Users/test/c.ts"]);
  });

  it("does not cross the bridge for nothing", () => {
    expect(resolveLocalFileSources([])).toEqual([]);
    expect(getDroppedFilePaths).not.toHaveBeenCalled();
  });
});

describe("resolveTransferSources", () => {
  it("marks an OS drop as local files", () => {
    const sources = resolveTransferSources(
      transfer({ files: [fileAt("a.ts", "/Users/test/a.ts")] })
    );

    expect(sources).toEqual([{ kind: "local", path: "/Users/test/a.ts", name: "a.ts", size: 0 }]);
  });

  it("marks an in-app drag as host files, never asking the OS", () => {
    const sources = resolveTransferSources(
      transfer({ internal: encodeFileDragPaths(["/repo/a.ts", "/repo/b.ts"]) })
    );

    expect(sources).toEqual([
      { kind: "host", path: "/repo/a.ts" },
      { kind: "host", path: "/repo/b.ts" },
    ]);
    expect(getDroppedFilePaths).not.toHaveBeenCalled();
  });

  it("prefers the in-app payload when OS files ride along too", () => {
    const sources = resolveTransferSources(
      transfer({
        files: [fileAt("os.ts", "/Users/test/os.ts")],
        internal: encodeFileDragPaths(["/repo/a.ts"]),
      })
    );

    expect(sources).toEqual([{ kind: "host", path: "/repo/a.ts" }]);
  });

  it("treats a malformed in-app payload as an empty drop, not an OS drop", () => {
    const sources = resolveTransferSources(
      transfer({ files: [fileAt("os.ts", "/Users/test/os.ts")], internal: "not json" })
    );

    expect(sources).toEqual([]);
  });
});

describe("toMaterializeSource", () => {
  it("maps provenance onto the materialize source kinds", () => {
    expect(toMaterializeSource({ kind: "local", path: "/Users/test/a.ts" })).toEqual({
      kind: "local-file",
      path: "/Users/test/a.ts",
    });
    expect(toMaterializeSource({ kind: "host", path: "/repo/a.ts" })).toEqual({
      kind: "host-file",
      path: "/repo/a.ts",
      hostId: "local",
    });
  });
});

describe("materializeTransferSources", () => {
  it("is the identity for local and host files in a local window", async () => {
    const results = await materializeTransferSources([
      { kind: "local", path: "/Users/test/a.ts" },
      { kind: "host", path: "/repo/b.ts" },
    ]);

    expect(results.map((result) => result?.hostPath)).toEqual(["/Users/test/a.ts", "/repo/b.ts"]);
  });

  it("returns null for a source that fails and still resolves the rest", async () => {
    const seen: MaterializeSource[] = [];
    setRemoteMaterializer(async (source) => {
      seen.push(source);
      if (source.kind === "local-file" && source.path.endsWith("bad.ts")) {
        throw new Error("upload refused");
      }
      const path = "path" in source ? source.path : "";
      return { hostPath: `/host/inbox${path}`, displayName: "x", bytes: null };
    });

    const results = await materializeTransferSources([
      { kind: "local", path: "/Users/test/bad.ts" },
      { kind: "local", path: "/Users/test/good.ts" },
    ]);

    expect(results[0]).toBeNull();
    expect(results[1]?.hostPath).toBe("/host/inbox/Users/test/good.ts");
    expect(seen).toHaveLength(2);
  });
});
