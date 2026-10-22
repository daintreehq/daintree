import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatHostModeStatus,
  parseHostModeStatus,
  readHostModeStatusFile,
  writeHostModeStatusFile,
} from "../hostModeStatusFile.js";

const observation = {
  pid: 7,
  enabled: true,
  startAtLogin: true,
  startAtLoginInstalled: true,
  startAtLoginError: null,
  keychain: {
    state: "ok" as const,
    detail: "Keychain answered",
    checked: true,
    checkedAt: 1_700_000_000_000,
  },
};

describe("host-mode.json keychain record", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-hms-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("round-trips when the check last ran", async () => {
    await writeHostModeStatusFile(dir, observation);
    expect(await readHostModeStatusFile(dir)).toEqual(observation);
  });

  it("still reads a file written before checkedAt existed", () => {
    const { checkedAt: _at, ...keychain } = observation.keychain;
    const text = formatHostModeStatus({ ...observation, keychain });
    expect(parseHostModeStatus(text)?.keychain).toEqual(keychain);
  });

  it("reads nothing from a missing or corrupt file", async () => {
    expect(await readHostModeStatusFile(dir)).toBeNull();
    await fs.writeFile(path.join(dir, "host-mode.json"), "{nope");
    expect(await readHostModeStatusFile(dir)).toBeNull();
  });
});
