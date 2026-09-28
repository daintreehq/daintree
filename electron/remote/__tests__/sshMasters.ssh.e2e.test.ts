import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSshMaster,
  closeSshMasters,
  controlPathFor,
  SshTransport,
} from "../client/sshTransport.js";
import {
  listProcesses,
  makeShortTempRoot,
  SSH_ALIAS,
  startPrivateSshd,
  type PrivateSshd,
} from "./harness/privateSshd.js";

const ENABLED = process.env.DAINTREE_SSH_E2E === "1";
const TEST_TIMEOUT_MS = 60_000;
// The same sshd under a second name: ssh's %C differs, so the shared `cm-%C`
// template expands into a second master socket.
const SECOND_ALIAS = "daintree-e2e-second";

let root: string | null = null;
let sshd: PrivateSshd | null = null;
let clientDir: string;

async function masterPid(alias: string): Promise<number | null> {
  const result = await sshd!.runSsh([
    "-o",
    `ControlPath=${controlPathFor(clientDir, alias)}`,
    "-O",
    "check",
    alias,
  ]);
  if (result.code !== 0) return null;
  const match = /pid=(\d+)/.exec(result.stderr + result.stdout);
  return match ? Number(match[1]) : null;
}

async function masterGone(alias: string, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((await masterPid(alias)) !== null) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label} to exit`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Leaves a master behind for `alias`: the probe starts it, the missing Host fails the open. */
async function openWithoutHost(alias: string): Promise<void> {
  const transport = new SshTransport({ target: alias, clientDir, spawn: sshd!.spawnSsh });
  await expect(transport.open(new AbortController().signal)).rejects.toBeDefined();
}

describe.skipIf(!ENABLED)(
  "SSH masters for two hosts sharing the %C control path (skipped unless DAINTREE_SSH_E2E=1)",
  () => {
    beforeAll(async () => {
      root = await makeShortTempRoot();
      sshd = await startPrivateSshd(root);
      const config = await fs.readFile(sshd.configPath, "utf8");
      const second = config
        .replace(`Host ${SSH_ALIAS}`, `Host ${SECOND_ALIAS}`)
        .replace("HostName 127.0.0.1", "HostName localhost");
      await fs.writeFile(sshd.configPath, `${config}\n${second}`);
      clientDir = path.join(root, "c");
      await closeSshMasters();
    }, TEST_TIMEOUT_MS);

    afterAll(async () => {
      for (const alias of [SSH_ALIAS, SECOND_ALIAS]) {
        await sshd
          ?.runSsh(
            ["-o", `ControlPath=${controlPathFor(clientDir, alias)}`, "-O", "exit", alias],
            5_000
          )
          .catch(() => {});
      }
      await sshd?.stop();
      if (root) {
        for (const row of await listProcesses().catch(() => [])) {
          if (row.command.includes(root) && row.pid !== process.pid) {
            try {
              process.kill(row.pid, "SIGKILL");
            } catch {
              // Already gone.
            }
          }
        }
        await fs.rm(root, { recursive: true, force: true });
      }
    }, TEST_TIMEOUT_MS);

    it(
      "quitting exits every host's master, and forgetting one host leaves the other registered",
      async () => {
        expect(controlPathFor(clientDir, SSH_ALIAS)).toBe(controlPathFor(clientDir, SECOND_ALIAS));
        expect(controlPathFor(clientDir, SSH_ALIAS)).toContain("%C");

        await openWithoutHost(SSH_ALIAS);
        await openWithoutHost(SECOND_ALIAS);
        const first = await masterPid(SSH_ALIAS);
        const second = await masterPid(SECOND_ALIAS);
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(first).not.toBe(second);

        await closeSshMasters(5_000);
        await masterGone(SSH_ALIAS, "the first master");
        await masterGone(SECOND_ALIAS, "the second master");

        // Forgetting the second host drops only its own registration.
        await openWithoutHost(SSH_ALIAS);
        await openWithoutHost(SECOND_ALIAS);
        await closeSshMaster(sshd!.runCommand, clientDir, SECOND_ALIAS, 5_000);
        await masterGone(SECOND_ALIAS, "the forgotten master");
        expect(await masterPid(SSH_ALIAS)).not.toBeNull();
        await closeSshMasters(5_000);
        await masterGone(SSH_ALIAS, "the remaining master");
      },
      TEST_TIMEOUT_MS
    );
  }
);
