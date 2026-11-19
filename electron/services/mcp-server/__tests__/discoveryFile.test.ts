import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_DISCOVERY_FILE_NAME, McpDiscoveryFile } from "../discoveryFile.js";

describe("McpDiscoveryFile (#17904)", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-mcp-discovery-"));
    file = path.join(dir, MCP_DISCOVERY_FILE_NAME);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const read = () => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

  it("moves the record with the port, and removes it once nothing serves", () => {
    const published = new McpDiscoveryFile({ dir: () => dir, pid: 4242, stamp: () => "t0" });

    published.publish(45454);
    expect(read()).toEqual({ pid: 4242, port: 45454, startedAt: "t0" });
    published.publish(45460);
    expect(read()).toEqual({ pid: 4242, port: 45460, startedAt: "t0" });
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    published.publish(null);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => published.publish(null)).not.toThrow();
  });

  it("writes nothing it can't tell from a crash's leftover, and leaves what is there alone", () => {
    const leftover = `${JSON.stringify({ pid: 7, port: 45454, startedAt: "old" })}\n`;
    fs.writeFileSync(file, leftover);

    new McpDiscoveryFile({ dir: () => dir, stamp: () => null }).publish(45454);

    expect(fs.readFileSync(file, "utf8")).toBe(leftover);
  });

  it("reads its start time again after a read that failed or threw", () => {
    const answers: Array<() => string | null> = [
      () => null,
      () => {
        throw new Error("ps timed out");
      },
      () => "t1",
    ];
    const stamp = vi.fn(() => answers.shift()!());
    const published = new McpDiscoveryFile({ dir: () => dir, pid: 4242, stamp });

    published.publish(45454);
    expect(() => published.publish(45454)).not.toThrow();
    expect(fs.existsSync(file)).toBe(false);
    published.publish(45454);
    expect(read()).toEqual({ pid: 4242, port: 45454, startedAt: "t1" });
    published.publish(45460);
    expect(stamp).toHaveBeenCalledTimes(3);
  });

  // Root removes and reads whatever the modes say, so these would pass vacuously.
  const asRoot = process.getuid?.() === 0;

  // A record left in place names this live process for a port it let go.
  it.skipIf(process.platform === "win32" || asRoot)(
    "empties a record it can't remove, so no reader trusts it",
    () => {
      const published = new McpDiscoveryFile({ dir: () => dir, pid: 4242, stamp: () => "t0" });
      published.publish(45454);
      fs.chmodSync(dir, 0o500);

      published.publish(null);

      expect(fs.readFileSync(file, "utf8")).toBe("");
    }
  );

  it.skipIf(process.platform === "win32" || asRoot)(
    "leaves alone a record it can't read back, which may not be its own",
    () => {
      const published = new McpDiscoveryFile({ dir: () => dir, pid: 4242, stamp: () => "t0" });
      published.publish(45454);
      fs.rmSync(file);
      fs.writeFileSync(file, "another writer's", { mode: 0o200 });

      published.publish(null);

      fs.chmodSync(file, 0o600);
      expect(fs.readFileSync(file, "utf8")).toBe("another writer's");
    }
  );

  it("never fails the server over a userData directory it can't resolve or write", () => {
    const unresolved = new McpDiscoveryFile({
      dir: () => {
        throw new Error("no userData");
      },
      stamp: () => "t0",
    });
    const missing = new McpDiscoveryFile({ dir: () => path.join(dir, "gone"), stamp: () => "t0" });

    expect(() => unresolved.publish(45454)).not.toThrow();
    expect(() => missing.publish(45454)).not.toThrow();
    expect(() => missing.publish(null)).not.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
