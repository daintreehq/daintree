import { describe, expect, it } from "vitest";
import { AppError } from "../../../utils/errorTypes.js";
import {
  FOLDER_UPLOAD_SINK_PREFIX,
  FolderUploadCancelResultSchema,
  FolderUploadLinkMethod,
  FolderUploadOperationPayloadSchema,
  FolderUploadPreparePayloadSchema,
  FolderUploadPrepareResultSchema,
  FolderUploadProblemSchema,
  FolderUploadStatusSchema,
  classifyFolderUploadCallError,
  folderArchiveMode,
  readFolderArchiveMode,
} from "../folderUploadLinkMethods.js";
import { UPLOAD_SINK_PREFIX, UploadLinkMethod } from "../uploadLinkMethods.js";

const SHA = "ab".repeat(32);
const TOKEN = "0123456789abcdef0123456789abcdef";

const prepare = (extra: Record<string, unknown> = {}) => ({
  endpointId: "endpoint-1",
  opId: "op-1",
  rootName: "Daintree-Audit-2026-11-05",
  archiveBytes: 4_096,
  sha256: SHA,
  fileCount: 3,
  folderCount: 1,
  totalBytes: 1_000,
  ...extra,
});

/** What crossing the link does to a value: JSON out, JSON in. */
const overTheWire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("folder upload wire names", () => {
  it("never reuses a file upload's method or transfer prefix", () => {
    expect(Object.values(FolderUploadLinkMethod)).not.toContain(UploadLinkMethod.PREPARE);
    expect(FOLDER_UPLOAD_SINK_PREFIX.startsWith(UPLOAD_SINK_PREFIX)).toBe(false);
    expect(UPLOAD_SINK_PREFIX.startsWith(FOLDER_UPLOAD_SINK_PREFIX)).toBe(false);
  });
});

describe("FolderUploadPreparePayloadSchema", () => {
  it("round-trips a prepare, and an empty folder with no files", () => {
    for (const payload of [prepare(), prepare({ fileCount: 0, folderCount: 0, totalBytes: 0 })]) {
      const parsed = FolderUploadPreparePayloadSchema.parse(payload);
      expect(FolderUploadPreparePayloadSchema.parse(overTheWire(parsed))).toEqual(payload);
    }
  });

  it.each([
    ["a negative count", { fileCount: -1 }],
    ["a fractional count", { folderCount: 1.5 }],
    ["an unsafe count", { totalBytes: Number.MAX_SAFE_INTEGER + 2 }],
    ["a count that isn't a number", { fileCount: "3" }],
    ["an archive no bigger than its content", { archiveBytes: 1_000 }],
    ["content bytes with no files", { fileCount: 0, totalBytes: 1 }],
    ["an uppercase digest", { sha256: SHA.toUpperCase() }],
    ["a short digest", { sha256: "ab" }],
    ["an empty endpoint", { endpointId: "" }],
    ["an operation id past 128 characters", { opId: "o".repeat(129) }],
    ["a traversing root name", { rootName: ".." }],
    ["a root name with a separator", { rootName: "a/b" }],
    ["a drive-letter root name", { rootName: "C:" }],
    ["a destination, which folders don't take", { destination: { kind: "worktree" } }],
    ["a replace token", { replaceToken: TOKEN }],
  ])("refuses %s", (_label, extra) => {
    expect(FolderUploadPreparePayloadSchema.safeParse(prepare(extra)).success).toBe(false);
  });

  it("leaves a root name over the length limit for the host to refuse by name", () => {
    expect(
      FolderUploadPreparePayloadSchema.safeParse(prepare({ rootName: "é".repeat(200) })).success
    ).toBe(true);
  });

  it("leaves counts over the limits for the host to refuse by name", () => {
    expect(
      FolderUploadPreparePayloadSchema.safeParse(
        prepare({ fileCount: 1_000_000, archiveBytes: 2 ** 40, totalBytes: 2 ** 39 })
      ).success
    ).toBe(true);
  });
});

describe("FolderUploadOperationPayloadSchema", () => {
  it("round-trips the status and cancel payload and refuses anything more", () => {
    const payload = { endpointId: "endpoint-1", opId: "op-1" };
    expect(FolderUploadOperationPayloadSchema.parse(overTheWire(payload))).toEqual(payload);
    expect(FolderUploadOperationPayloadSchema.safeParse({ ...payload, all: true }).success).toBe(
      false
    );
    expect(FolderUploadOperationPayloadSchema.safeParse({ endpointId: "e" }).success).toBe(false);
  });
});

const limitProblem = {
  kind: "limit",
  limit: "files",
  maximum: 5_000,
  actual: 5_001,
  paths: ["Root/node_modules/"],
};

describe("FolderUploadProblemSchema", () => {
  it.each([
    ["a limit", limitProblem],
    ["a limit known only from counts", { ...limitProblem, paths: [] }],
    ["a clash", { kind: "clash", paths: ["Root/README.md", "Root/readme.md"] }],
    ["a path", { kind: "path", problem: "dot-name", path: "Root/../x" }],
  ])("round-trips %s", (_label, problem) => {
    expect(FolderUploadProblemSchema.parse(overTheWire(problem))).toEqual(problem);
  });

  it.each([
    ["an unknown kind", { kind: "mystery" }],
    ["an unknown limit", { ...limitProblem, limit: "colour" }],
    ["a limit that wasn't crossed", { ...limitProblem, actual: 5_000 }],
    ["a negative count", { ...limitProblem, actual: -1 }],
    ["too many paths", { ...limitProblem, paths: Array.from({ length: 11 }, (_, i) => `R/${i}`) }],
    ["a clash of one path", { kind: "clash", paths: ["Root/a"] }],
    ["an unknown path problem", { kind: "path", problem: "spooky", path: "Root/a" }],
  ])("refuses %s", (_label, problem) => {
    expect(FolderUploadProblemSchema.safeParse(problem).success).toBe(false);
  });
});

describe("FolderUploadStatusSchema", () => {
  it.each([
    [{ status: "receiving" }],
    [{ status: "unpacking", filesDone: 0, filesTotal: 0 }],
    [{ status: "unpacking", filesDone: 4_999, filesTotal: 5_000 }],
    [{ status: "done", hostPath: "/tmp/daintree-inbox/files/20261105-101010-abc/Root" }],
    [{ status: "failed", reason: "transfer-failed" }],
    [{ status: "failed", reason: "name-clash", problem: { kind: "clash", paths: ["R/a", "R/A"] } }],
    [{ status: "cancelled" }],
    [{ status: "unknown" }],
  ])("round-trips %j", (status) => {
    expect(FolderUploadStatusSchema.parse(overTheWire(status))).toEqual(status);
  });

  it.each([
    ["an unknown status", { status: "paused" }],
    ["an unknown failure reason", { status: "failed", reason: "gremlins" }],
    ["a refusal reason that is no failure", { status: "failed", reason: "busy" }],
    ["more files done than there are", { status: "unpacking", filesDone: 6, filesTotal: 5 }],
    ["a negative count", { status: "unpacking", filesDone: -1, filesTotal: 5 }],
    ["a fractional count", { status: "unpacking", filesDone: 0.5, filesTotal: 5 }],
    ["an unpacking status without counts", { status: "unpacking" }],
    ["done without a path", { status: "done" }],
    ["done with an empty path", { status: "done", hostPath: "" }],
  ])("refuses %s", (_label, status) => {
    expect(FolderUploadStatusSchema.safeParse(status).success).toBe(false);
  });
});

describe("FolderUploadPrepareResultSchema", () => {
  it.each([
    [{ status: "ready", token: TOKEN }],
    [{ status: "refused", reason: "busy" }],
    [{ status: "refused", reason: "over-limits", problem: limitProblem }],
    [{ status: "receiving" }],
    [{ status: "unpacking", filesDone: 1, filesTotal: 3 }],
    [{ status: "done", hostPath: "/tmp/daintree-inbox/files/x/Root" }],
    [{ status: "failed", reason: "write-failed" }],
    [{ status: "cancelled" }],
  ])("round-trips %j", (result) => {
    expect(FolderUploadPrepareResultSchema.parse(overTheWire(result))).toEqual(result);
  });

  it.each([
    ["an unknown refusal reason", { status: "refused", reason: "too-large" }],
    ["a failure reason as a refusal", { status: "refused", reason: "transfer-failed" }],
    ["a short token", { status: "ready", token: "abc" }],
    ["an uppercase token", { status: "ready", token: TOKEN.toUpperCase() }],
    ["a file upload's duplicate answer", { status: "duplicate", hostPath: "/tmp/x" }],
    // A prepare with no record admits or refuses; it never answers that it doesn't know.
    ["unknown", { status: "unknown" }],
  ])("refuses %s", (_label, result) => {
    expect(FolderUploadPrepareResultSchema.safeParse(result).success).toBe(false);
  });
});

describe("FolderUploadCancelResultSchema", () => {
  it.each([
    [{ status: "cancelled" }],
    [{ status: "done", hostPath: "/tmp/daintree-inbox/files/x/Root" }],
    [{ status: "failed", reason: "unsafe-archive" }],
    [{ status: "unknown" }],
  ])("round-trips %j", (result) => {
    expect(FolderUploadCancelResultSchema.parse(overTheWire(result))).toEqual(result);
  });

  it.each([[{ status: "receiving" }], [{ status: "unpacking", filesDone: 0, filesTotal: 1 }]])(
    "refuses %j: a cancel answers where the operation ended",
    (result) => {
      expect(FolderUploadCancelResultSchema.safeParse(result).success).toBe(false);
    }
  );
});

describe("classifyFolderUploadCallError", () => {
  it("reads UNSUPPORTED, as an older host answers an unknown method, as an outdated host", () => {
    // How the session rebuilds a peer's error: a plain Error carrying the code.
    const rebuilt = Object.assign(new Error("Unknown method: files.folder-upload-prepare"), {
      code: "UNSUPPORTED",
    });
    expect(classifyFolderUploadCallError(rebuilt)).toBe("unsupported");
    expect(classifyFolderUploadCallError(new AppError({ code: "UNSUPPORTED", message: "x" }))).toBe(
      "unsupported"
    );
  });

  it("keeps a host's refusal of the request apart from an outdated host", () => {
    expect(classifyFolderUploadCallError({ code: "VALIDATION", message: "Invalid payload" })).toBe(
      "validation"
    );
  });

  it.each([
    ["a disconnect", { code: "HOST_DISCONNECTED" }],
    ["a rate limit", { code: "RATE_LIMITED" }],
    ["a code that isn't a string", { code: 404 }],
    ["an error with no code", new Error("Unknown method: files.folder-upload-prepare")],
    ["a reply that didn't parse", FolderUploadStatusSchema.safeParse({ status: "new" }).error],
    ["nothing", null],
    ["a string", "UNSUPPORTED"],
  ])("reads %s as an ordinary failure, never an outdated host", (_label, error) => {
    expect(classifyFolderUploadCallError(error)).toBe("other");
  });
});

describe("folder archive modes", () => {
  it("packs the executable bit and nothing else, and reads back what it packed", () => {
    for (const [kind, executable] of [
      ["file", false],
      ["file", true],
      ["folder", false],
    ] as const) {
      expect(readFolderArchiveMode(kind, folderArchiveMode(kind, executable))).toEqual({
        executable,
      });
    }
    expect(folderArchiveMode("file", true)).not.toBe(folderArchiveMode("file", false));
    expect(folderArchiveMode("folder", true)).toBe(folderArchiveMode("folder", false));
  });

  it.each([
    ["a symlink", "file", 0o120777],
    ["a FIFO", "file", 0o010600],
    ["a device", "file", 0o060600],
    ["a folder's mode on a file", "file", 0o040700],
    ["a file's mode on a folder", "folder", 0o100700],
    ["group and other bits", "file", 0o100644],
    ["setuid", "file", 0o104700],
    ["no type", "file", 0o600],
  ] as const)("refuses %s", (_label, kind, mode) => {
    expect(readFolderArchiveMode(kind, mode)).toBeNull();
  });
});
