import { describe, expect, it } from "vitest";
import {
  PLUGIN_FS_READ_FILES_MAX_TOTAL_BYTES,
  runReadFiles,
  validateReadFilesCall,
  type ReadOneOutcome,
} from "../pluginFsReadFiles.js";

const MiB = 1024 * 1024;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runReadFiles", () => {
  it("spends the budget in request order, not completion order", async () => {
    const call = validateReadFilesCall("p", ["/slow-big", "/fast-small"], undefined);
    const results = await runReadFiles(call, async (filePath, limit): Promise<ReadOneOutcome> => {
      const size = filePath === "/slow-big" ? 6 * MiB : 4 * MiB;
      if (filePath === "/slow-big") await delay(20);
      if (size > limit) return { status: "too-large" };
      return { status: "ok", bytes: Buffer.alloc(size, 0x61) };
    });
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: false, error: { code: "RESULT_TOO_LARGE" } });
  });

  it("charges decoded text, which can outgrow the bytes it came from", async () => {
    const size = Math.floor(PLUGIN_FS_READ_FILES_MAX_TOTAL_BYTES / 2);
    const call = validateReadFilesCall("p", ["/invalid-utf8"], undefined);
    // 0xff is not UTF-8: each byte decodes to a 3-byte U+FFFD.
    const [result] = await runReadFiles(call, async () => ({
      status: "ok",
      bytes: Buffer.alloc(size, 0xff),
    }));
    expect(result).toMatchObject({ ok: false, error: { code: "RESULT_TOO_LARGE" } });
  });

  it("rejects when the signal aborts while the last read is in flight", async () => {
    const controller = new AbortController();
    const call = validateReadFilesCall("p", ["/a"], { signal: controller.signal });
    const promise = runReadFiles(call, async () => {
      controller.abort();
      return { status: "ok", bytes: Buffer.from("a") };
    });
    await expect(promise).rejects.toThrow();
  });

  it("keeps a read failure to its own entry and never leaves an unhandled rejection", async () => {
    const call = validateReadFilesCall("p", ["/slow", "/fails"], undefined);
    const results = await runReadFiles(call, async (filePath) => {
      if (filePath === "/fails") {
        throw Object.assign(new Error("ENOENT: gone"), { code: "ENOENT" });
      }
      await delay(20);
      return { status: "ok", bytes: Buffer.from("ok") };
    });
    expect(results[0]).toMatchObject({ ok: true, content: "ok" });
    expect(results[1]).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});
