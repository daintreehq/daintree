import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusDownloadGate } from "../../../../shared/types/workspace-host.js";
import { startOnlineOnlyProbe, startOnlineOnlyScan } from "../../../utils/onlineOnlyScan.js";
import { ProjectOnlineOnlyService } from "../../ProjectOnlineOnlyService.js";
import { gateGitStatusOnDownload } from "../statusDownloadGate.js";

// Nothing outside a File Provider can set the dataless flag, so the real `find`
// looks for one an owner can. This proves the flag reaches the gate, not how the
// kernel treats a real placeholder.
const FLAG = "nodump";
const chflags = (flag: string, target: string) => execFileSync("chflags", [flag, target]);

vi.mock("../../../../shared/utils/cloudSyncDetection.js", () => ({
  detectCloudSyncService: () => "Dropbox",
}));

describe.runIf(process.platform === "darwin")("the gate over a real .git", () => {
  let root: string;
  let packed: string;
  let service: ProjectOnlineOnlyService;
  let stop: (() => void) | null;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "daintree-gate-"));
    execFileSync("git", ["init", "-q", root]);
    packed = path.join(root, ".git", "ORIG_HEAD");
    writeFileSync(packed, "0000\n");
    service = new ProjectOnlineOnlyService(
      {
        probe: (target, options) => startOnlineOnlyProbe(target, { ...options, flag: FLAG }),
        scan: (target, side, options) =>
          startOnlineOnlyScan(target, side, { ...options, flag: FLAG }),
      },
      () => false
    );
    stop = null;
  });

  afterEach(() => {
    stop?.();
    service.dispose();
    chflags("dump", packed);
    rmSync(root, { recursive: true, force: true });
  });

  const gatesInto = (applied: StatusDownloadGate[]) =>
    gateGitStatusOnDownload(
      root,
      "p1",
      (gate) => applied.push(gate),
      () => service
    );

  it("holds while .git has a flagged file and opens by itself once it's gone", async () => {
    chflags(FLAG, packed);
    const applied: StatusDownloadGate[] = [];
    stop = gatesInto(applied);

    await vi.waitFor(() => expect(applied.at(-1)).toBe("held"), { timeout: 5_000 });

    chflags("dump", packed);
    await vi.waitFor(() => expect(applied.at(-1)).toBe("open"), { timeout: 10_000 });
  }, 20_000);

  it("opens without ever holding when everything is downloaded", async () => {
    const applied: StatusDownloadGate[] = [];
    stop = gatesInto(applied);

    await vi.waitFor(() => expect(applied.at(-1)).toBe("open"), { timeout: 5_000 });

    expect(applied).toEqual(["pending", "open"]);
  }, 10_000);
});
