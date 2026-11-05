import { describe, expect, it } from "vitest";
import {
  FOLDER_UPLOAD_MAX_ARCHIVE_BYTES,
  FOLDER_UPLOAD_MAX_DEPTH,
  FOLDER_UPLOAD_MAX_FOLDERS,
  FOLDER_UPLOAD_MAX_NAME_BYTES,
  FOLDER_UPLOAD_MAX_PATH_BYTES,
} from "../../types/folderUpload.js";
import { FOLDER_UPLOAD_MAX_BYTES, FOLDER_UPLOAD_MAX_FILES } from "../../types/remoteHosts.js";
import {
  FolderUploadTally,
  checkFolderUploadEntryPath,
  checkFolderUploadRootName,
  checkFolderUploadTotals,
  utf8ByteLength,
  type FolderUploadEntry,
} from "../folderUpload.js";

const file = (path: string): FolderUploadEntry => ({ path, kind: "file" });
const folder = (path: string): FolderUploadEntry => ({ path, kind: "folder" });

/** A root-prefixed path `depth` components below the root. */
function deepPath(depth: number): string {
  return ["Root", ...Array.from({ length: depth }, (_, i) => `d${i}`)].join("/");
}

describe("utf8ByteLength", () => {
  it.each([
    ["ASCII", "abc", 3],
    ["two-byte", "é", 2],
    ["three-byte", "日", 3],
    ["an astral character, one code point in two units", "😀", 4],
    ["a lone surrogate, as its replacement", "\ud800", 3],
  ])("counts %s", (_label, text, bytes) => {
    expect(utf8ByteLength(text)).toBe(bytes);
  });
});

describe("checkFolderUploadRootName", () => {
  it.each([
    ["", "empty-name"],
    [".", "dot-name"],
    ["..", "dot-name"],
    ["a/b", "separator"],
    ["a\\b", "separator"],
    ["C:", "drive-letter"],
    ["c:folder", "drive-letter"],
    ["tab\there", "control-character"],
    ["nul\u0000", "control-character"],
    ["del\u007f", "control-character"],
    ["c1\u0085", "control-character"],
    ["half\ud83d", "malformed-unicode"],
    ["\udc00tail", "malformed-unicode"],
  ])("refuses %j as %s", (name, problem) => {
    expect(checkFolderUploadRootName(name)).toEqual({ kind: "path", problem, path: name });
  });

  it.each([
    ".git",
    ".env",
    "-leading-dash",
    "has spaces ",
    "a..b",
    "aux",
    "CON",
    "time 10:00",
    "trailing.",
    "日本語",
    "emoji 😀",
  ])("keeps %j, which macOS and Linux hosts hold", (name) => {
    expect(checkFolderUploadRootName(name)).toBeNull();
  });

  it("holds a name to its UTF-8 bytes, not its length", () => {
    expect(checkFolderUploadRootName("a".repeat(FOLDER_UPLOAD_MAX_NAME_BYTES))).toBeNull();
    expect(checkFolderUploadRootName("é".repeat(128))).toEqual({
      kind: "limit",
      limit: "name-bytes",
      maximum: FOLDER_UPLOAD_MAX_NAME_BYTES,
      actual: 256,
      paths: ["é".repeat(128)],
    });
  });
});

describe("checkFolderUploadEntryPath", () => {
  it.each([
    [file("Root/a.txt")],
    [file("Root/.git/HEAD")],
    [file("Root/.env")],
    [folder("Root/")],
    [folder("Root/empty/")],
    [file("Root/C:x")],
    [file("Root/a..b/c")],
  ])("accepts %j", (entry) => {
    expect(checkFolderUploadEntryPath("Root", entry)).toBeNull();
  });

  it.each([
    ["an empty path", file(""), "empty-name"],
    ["an absolute path", file("/etc/passwd"), "absolute"],
    ["an absolute folder", folder("/"), "absolute"],
    ["a drive-letter path", file("C:/Windows/win.ini"), "drive-letter"],
    ["a drive-relative path", file("C:Root/a"), "drive-letter"],
    ["a UNC path", file("\\\\server\\share\\a"), "separator"],
    ["a backslash traversal", file("Root\\..\\..\\etc"), "separator"],
    ["a parent traversal", file("Root/../etc/passwd"), "dot-name"],
    ["a traversal at the end", folder("Root/a/../"), "dot-name"],
    ["a current-folder component", file("Root/./a"), "dot-name"],
    ["an empty component", file("Root//a"), "empty-name"],
    ["a doubled trailing slash", folder("Root/a//"), "empty-name"],
    ["a NUL", file("Root/a\u0000.txt"), "control-character"],
    ["a newline", file("Root/a\nb"), "control-character"],
    ["a lone surrogate", file("Root/\ud800"), "malformed-unicode"],
    ["another root", file("Other/a.txt"), "outside-root"],
    ["a root that differs only by case", file("root/a.txt"), "outside-root"],
    ["a file where the root is", file("Root"), "outside-root"],
    ["a folder without its slash", folder("Root/a"), "entry-form"],
    ["a file with a trailing slash", file("Root/a/"), "entry-form"],
  ])("refuses %s", (_label, entry, problem) => {
    expect(checkFolderUploadEntryPath("Root", entry)).toEqual({
      kind: "path",
      problem,
      path: entry.path,
    });
  });

  it("allows the deepest path and refuses one level more", () => {
    expect(checkFolderUploadEntryPath("Root", file(deepPath(FOLDER_UPLOAD_MAX_DEPTH)))).toBeNull();
    expect(
      checkFolderUploadEntryPath("Root", folder(`${deepPath(FOLDER_UPLOAD_MAX_DEPTH)}/`))
    ).toBeNull();
    const tooDeep = file(deepPath(FOLDER_UPLOAD_MAX_DEPTH + 1));
    expect(checkFolderUploadEntryPath("Root", tooDeep)).toEqual({
      kind: "limit",
      limit: "depth",
      maximum: FOLDER_UPLOAD_MAX_DEPTH,
      actual: FOLDER_UPLOAD_MAX_DEPTH + 1,
      paths: [tooDeep.path],
    });
  });

  it("allows the longest name and refuses one byte more, in UTF-8", () => {
    expect(
      checkFolderUploadEntryPath("Root", file(`Root/${"a".repeat(FOLDER_UPLOAD_MAX_NAME_BYTES)}`))
    ).toBeNull();
    // 85 three-byte characters are 255 bytes; one more ASCII byte crosses it.
    const long = file(`Root/${"日".repeat(85)}a`);
    expect(checkFolderUploadEntryPath("Root", long)).toEqual({
      kind: "limit",
      limit: "name-bytes",
      maximum: FOLDER_UPLOAD_MAX_NAME_BYTES,
      actual: FOLDER_UPLOAD_MAX_NAME_BYTES + 1,
      paths: [long.path],
    });
  });

  it("allows the longest path and refuses one byte more, not counting a folder's slash", () => {
    const filler = (bytes: number) => {
      const parts: string[] = [];
      while (bytes > 0) {
        const take = Math.min(200, bytes);
        parts.push("a".repeat(take));
        bytes -= take + 1;
      }
      return parts.join("/");
    };
    // "Root/" is five bytes; the rest makes up the budget exactly.
    const longest = `Root/${filler(FOLDER_UPLOAD_MAX_PATH_BYTES - 5)}`;
    expect(utf8ByteLength(longest)).toBe(FOLDER_UPLOAD_MAX_PATH_BYTES);
    expect(checkFolderUploadEntryPath("Root", file(longest))).toBeNull();
    expect(checkFolderUploadEntryPath("Root", folder(`${longest}/`))).toBeNull();
    expect(checkFolderUploadEntryPath("Root", file(`${longest}b`))).toEqual({
      kind: "limit",
      limit: "path-bytes",
      maximum: FOLDER_UPLOAD_MAX_PATH_BYTES,
      actual: FOLDER_UPLOAD_MAX_PATH_BYTES + 1,
      paths: [`${longest}b`],
    });
  });
});

describe("checkFolderUploadTotals", () => {
  const within = { fileCount: 0, folderCount: 0, totalBytes: 0 };

  it.each([
    ["files", "fileCount", FOLDER_UPLOAD_MAX_FILES],
    ["folders", "folderCount", FOLDER_UPLOAD_MAX_FOLDERS],
    ["bytes", "totalBytes", FOLDER_UPLOAD_MAX_BYTES],
  ] as const)("allows %s at the limit and refuses one past it", (limit, field, maximum) => {
    expect(checkFolderUploadTotals({ ...within, [field]: maximum })).toBeNull();
    expect(checkFolderUploadTotals({ ...within, [field]: maximum + 1 })).toEqual({
      kind: "limit",
      limit,
      maximum,
      actual: maximum + 1,
      paths: [],
    });
  });

  it("checks the archive's size only when it is given", () => {
    expect(
      checkFolderUploadTotals({ ...within, archiveBytes: FOLDER_UPLOAD_MAX_ARCHIVE_BYTES })
    ).toBeNull();
    expect(
      checkFolderUploadTotals({ ...within, archiveBytes: FOLDER_UPLOAD_MAX_ARCHIVE_BYTES + 1 })
    ).toMatchObject({ limit: "archive-bytes", actual: FOLDER_UPLOAD_MAX_ARCHIVE_BYTES + 1 });
  });

  it("reports what was counted, never clamped", () => {
    expect(checkFolderUploadTotals({ ...within, fileCount: 12_345 })).toMatchObject({
      actual: 12_345,
    });
  });
});

describe("FolderUploadTally", () => {
  function tally(entries: FolderUploadEntry[]): FolderUploadTally {
    const t = new FolderUploadTally("Root");
    for (const entry of entries) expect(t.add(entry)).toBeNull();
    return t;
  }

  it("counts files, folders below the root and content bytes", () => {
    const t = tally([folder("Root/"), folder("Root/empty/"), folder("Root/src/")]);
    expect(t.add({ ...file("Root/src/a.ts"), bytes: 10 })).toBeNull();
    expect(t.add({ ...file("Root/.env"), bytes: 5 })).toBeNull();
    expect(t.add({ ...file("Root/zero"), bytes: 0 })).toBeNull();
    expect(t.totals).toEqual({ fileCount: 3, folderCount: 2, totalBytes: 15 });
  });

  it("counts a folder met first as a parent once, when its own entry comes later", () => {
    const t = tally([file("Root/a/b/c.txt"), folder("Root/a/"), folder("Root/a/b/")]);
    expect(t.totals).toEqual({ fileCount: 1, folderCount: 2, totalBytes: 0 });
  });

  it.each([
    ["case", [file("Root/README.md"), file("Root/readme.md")], ["Root/README.md", "Root/readme.md"]],
    [
      "Unicode normalization",
      [file("Root/caf\u00e9"), file("Root/cafe\u0301")],
      ["Root/caf\u00e9", "Root/cafe\u0301"],
    ],
    ["compatibility folding", [file("Root/ﬁle"), file("Root/file")], ["Root/ﬁle", "Root/file"]],
    ["a file and a folder", [file("Root/a"), folder("Root/A/")], ["Root/a", "Root/A/"]],
    ["a folder and a file", [folder("Root/A/"), file("Root/a")], ["Root/A/", "Root/a"]],
    [
      "a file and another entry's parent",
      [file("Root/a"), file("Root/A/x.txt")],
      ["Root/a", "Root/A/"],
    ],
    [
      "a parent and a later file",
      [file("Root/A/x.txt"), file("Root/a")],
      ["Root/A/", "Root/a"],
    ],
    [
      "parents that fold together",
      [file("Root/Src/x.ts"), file("Root/src/y.ts")],
      ["Root/Src/", "Root/src/"],
    ],
    [
      "a file used as a parent under the same spelling",
      [file("Root/a"), file("Root/a/x")],
      ["Root/a", "Root/a/"],
    ],
    ["the same file twice", [file("Root/a"), file("Root/a")], ["Root/a", "Root/a"]],
    ["the same folder twice", [folder("Root/a/"), folder("Root/a/")], ["Root/a/", "Root/a/"]],
    ["the root twice", [folder("Root/"), folder("Root/")], ["Root/", "Root/"]],
  ])("refuses names that clash by %s, naming the pair", (_label, entries, paths) => {
    const t = new FolderUploadTally("Root");
    const [first, second] = entries;
    expect(t.add(first!)).toBeNull();
    const before = t.totals;
    expect(t.add(second!)).toEqual({ kind: "clash", paths });
    expect(t.totals).toEqual(before);
  });

  it("keeps names apart that differ by more than case", () => {
    tally([file("Root/a"), file("Root/b"), file("Root/x/a"), folder("Root/a.d/")]);
  });

  it("refuses a bad path before it reaches the names", () => {
    const t = new FolderUploadTally("Root");
    expect(t.add(file("Root/../a"))).toMatchObject({ kind: "path", problem: "dot-name" });
    expect(t.add(file("Root/a"))).toBeNull();
  });

  it("refuses at one past the file limit, reporting the count reached", () => {
    const t = new FolderUploadTally("Root");
    for (let i = 0; i < FOLDER_UPLOAD_MAX_FILES; i++) {
      expect(t.add(file(`Root/f${i}`))).toBeNull();
    }
    expect(t.add(file("Root/one-more"))).toEqual({
      kind: "limit",
      limit: "files",
      maximum: FOLDER_UPLOAD_MAX_FILES,
      actual: FOLDER_UPLOAD_MAX_FILES + 1,
      paths: [],
    });
    expect(t.totals.fileCount).toBe(FOLDER_UPLOAD_MAX_FILES + 1);
  });

  it("refuses at one past the byte limit", () => {
    const t = new FolderUploadTally("Root");
    expect(t.add({ ...file("Root/big"), bytes: FOLDER_UPLOAD_MAX_BYTES })).toBeNull();
    expect(t.add({ ...file("Root/one"), bytes: 1 })).toMatchObject({
      limit: "bytes",
      actual: FOLDER_UPLOAD_MAX_BYTES + 1,
    });
  });

  it("refuses at one past the folder limit, the root not counted", () => {
    const t = new FolderUploadTally("Root");
    expect(t.add(folder("Root/"))).toBeNull();
    for (let i = 0; i < FOLDER_UPLOAD_MAX_FOLDERS; i++) {
      expect(t.add(folder(`Root/d${i}/`))).toBeNull();
    }
    expect(t.add(folder("Root/one-more/"))).toMatchObject({
      limit: "folders",
      actual: FOLDER_UPLOAD_MAX_FOLDERS + 1,
    });
  });
});
