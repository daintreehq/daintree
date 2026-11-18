import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const concurrently = vi.hoisted(() => vi.fn());
vi.mock("concurrently", () => ({ default: concurrently }));

import { main } from "./dev.mjs";
import { BUILD_READY_FILE } from "./lib/build-ready-gate.mjs";

describe("dev launcher", () => {
  let workDir;
  let readyFile;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-launcher-"));
    readyFile = path.join(workDir, BUILD_READY_FILE);
    fs.mkdirSync(path.dirname(readyFile), { recursive: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("DAINTREE_RESET_DATA", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    concurrently.mockReset();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("removes the last session's ready marker before wait-on can see it", async () => {
    fs.writeFileSync(readyFile, "// build ready 0\n");
    let markerAtLaunch;
    concurrently.mockImplementation(() => {
      markerAtLaunch = fs.existsSync(readyFile);
      return { result: Promise.resolve([]) };
    });

    await main({ readyFile });

    expect(concurrently).toHaveBeenCalledTimes(1);
    expect(markerAtLaunch).toBe(false);
    const electron = concurrently.mock.calls[0][0].find((command) => command.name === "electron");
    expect(electron.command.startsWith(`wait-on ${BUILD_READY_FILE} tcp:`)).toBe(true);
  });
});
