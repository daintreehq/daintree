import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo, removePathSync } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import {
  SSH_ALIAS,
  listProcesses,
  makeShortTempRoot,
  startPrivateSshd,
  writeSshWrapper,
  type PrivateSshd,
  type SshWrapper,
} from "../helpers/privateSshd";

/**
 * Plugin parity: a plugin installed on the Shell and missing on the Host is
 * listed as such, installed there from the Shell over the link (packed here,
 * staged in chunks, installed by the Host's own installer), and a newer copy
 * on the Shell shows as an update the Host can take the same way.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const PLUGIN_CLI = path.join(ROOT, "packages", "daintree-plugin", "dist", "cli.js");
const PLUGIN_NAME = "e2e-test.parity";
const HOST_NAME = "e2e-host";

interface Run {
  root: string;
  sshd: PrivateSshd;
  wrapper: SshWrapper;
  hostUserData: string;
  shellUserData: string;
  hostProject: { dir: string; name: string; cleanup: () => void };
  localProject: { dir: string; name: string; cleanup: () => void };
  a: AppContext;
  b: AppContext;
  hostId: string;
}

const run = { hostId: "" } as unknown as Run;

interface ParityRow {
  pluginId: string;
  group: string;
  localVersion: string | null;
  hostVersion: string | null;
  action: string | null;
}

/** A plugin with nothing in it but a version, packed with the author CLI. */
async function packProbe(version: string): Promise<string> {
  const dir = path.join(run.root, `probe-${version}`);
  await fs.mkdir(path.join(dir, "main"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      name: PLUGIN_NAME,
      version,
      displayName: "Parity Probe",
      description: "A plugin that only exists to be copied to a host.",
      main: "main/index.js",
      engines: { daintree: ">=0.11.0" },
      capabilities: [],
      contributes: {},
    })
  );
  await fs.writeFile(
    path.join(dir, "main", "index.js"),
    '"use strict";\nexports.activate = function () {};\nexports.deactivate = function () {};\n'
  );
  execFileSync(process.execPath, [PLUGIN_CLI, "package", "--skip-build"], { cwd: dir });
  return path.join(dir, `${PLUGIN_NAME}-${version}.dntr`);
}

async function parityRow(page: Page): Promise<ParityRow | undefined> {
  const rows = (await page.evaluate(
    (hostId) => window.electron.pluginParity.diff({ hostId }),
    run.hostId
  )) as ParityRow[];
  return rows.find((row) => row.pluginId.includes(PLUGIN_NAME));
}

async function installedVersion(page: Page): Promise<string | null> {
  const plugins = (await page.evaluate(() => window.electron.plugin.list())) as Array<{
    manifest?: { name?: string; version?: string };
  }>;
  return plugins.find((p) => p.manifest?.name === PLUGIN_NAME)?.manifest?.version ?? null;
}

async function installOnShell(archive: string): Promise<void> {
  const result = await run.b.window.evaluate(
    (file) => window.electron.plugin.installFromPath(file),
    archive
  );
  expect(result, JSON.stringify(result)).toMatchObject({ status: "installed" });
}

test.describe.serial("Remote hosts: plugin parity between a Shell and its Host", () => {
  test.beforeAll(async () => {
    test.info().annotations.push({
      type: "platform-skip",
      description: "The private sshd and the host's socket location are macOS-only here",
    });
    test.skip(
      !(process.platform === "darwin" && existsSync("/usr/sbin/sshd")),
      "Needs macOS and /usr/sbin/sshd"
    );
    test.setTimeout(300_000);
    // The author CLI is a workspace build, not part of build:e2e.
    if (!existsSync(PLUGIN_CLI)) {
      execFileSync("npm", ["run", "packages:build"], { cwd: ROOT, stdio: "inherit" });
    }
    expect(existsSync(PLUGIN_CLI), "the plugin CLI didn't build").toBe(true);
    run.root = await makeShortTempRoot();
    run.sshd = await startPrivateSshd(run.root);
    run.wrapper = await writeSshWrapper(run.root, run.sshd.configPath);
    run.hostUserData = path.join(run.sshd.home, "Library", "Application Support", "Daintree");
    run.shellUserData = path.join(run.root, "shell");
    await fs.mkdir(run.hostUserData, { recursive: true, mode: 0o700 });
    await fs.mkdir(run.shellUserData, { recursive: true, mode: 0o700 });
    const hostFixture = createFixtureRepo({ name: "rh-host" });
    const localFixture = createFixtureRepo({ name: "rh-shell" });
    run.hostProject = { ...hostFixture, name: path.basename(hostFixture.dir) };
    run.localProject = { ...localFixture, name: path.basename(localFixture.dir) };

    run.a = await launchApp({
      userDataDir: run.hostUserData,
      env: { HOME: run.sshd.home },
      alongside: true,
    });
    run.a.window = await openAndOnboardProject(run.a.app, run.a.window, run.hostProject.dir);
    await run.a.window.evaluate(() =>
      window.electron.hostMode.setEnabled({ enabled: true, startAtLogin: false })
    );
    await expect
      .poll(
        async () =>
          (await run.a.window.evaluate(() => window.electron.hostMode.getStatus())).listening,
        { timeout: 30_000 }
      )
      .toBe(true);

    run.b = await launchApp({
      userDataDir: run.shellUserData,
      env: {
        DAINTREE_SSH: run.wrapper.path,
        PATH: `${run.wrapper.binDir}:${process.env.PATH ?? ""}`,
      },
      alongside: true,
    });
    run.b.window = await openAndOnboardProject(run.b.app, run.b.window, run.localProject.dir);
    const added = (await run.b.window.evaluate(
      ({ name, target }) =>
        window.electron.remoteHosts.add({ name, connection: { kind: "ssh", target } }),
      { name: HOST_NAME, target: SSH_ALIAS }
    )) as { descriptor?: { id: string }; id?: string };
    run.hostId = added.descriptor?.id ?? added.id!;
    await run.b.window.evaluate(
      (hostId) => window.electron.remoteHosts.connect({ hostId }),
      run.hostId
    );
    await expect
      .poll(
        async () => {
          const list = (await run.b.window.evaluate(() =>
            window.electron.remoteHosts.list()
          )) as unknown as Array<{ descriptor: { id: string }; connection: { status: string } }>;
          return list.find((h) => h.descriptor.id === run.hostId)?.connection.status;
        },
        { timeout: 60_000 }
      )
      .toBe("connected");
  });

  test.afterAll(async () => {
    try {
      if (run.b?.app) await closeApp(run.b.app);
      if (run.a?.app) await closeApp(run.a.app).catch(() => undefined);
      await run.sshd?.stop();
      for (const row of await listProcesses().catch(() => [])) {
        if (!run.sshd || !row.command.includes(run.sshd.configPath)) continue;
        try {
          process.kill(row.pid, "SIGKILL");
        } catch {
          // Already gone between the listing and the kill.
        }
      }
    } finally {
      run.hostProject?.cleanup();
      run.localProject?.cleanup();
      if (run.root) removePathSync(run.root);
    }
  });

  test("1. a plugin only the Shell has is listed as missing on the Host", async () => {
    await installOnShell(await packProbe("1.2.3"));
    expect(await installedVersion(run.b.window)).toBe("1.2.3");
    expect(await installedVersion(run.a.window)).toBeNull();
    await expect
      .poll(async () => parityRow(run.b.window), { timeout: 30_000 })
      .toMatchObject({
        group: "only-here",
        localVersion: "1.2.3",
        hostVersion: null,
        action: "install-on-host",
      });
  });

  test("2. the Shell installs it on the Host over the link", async () => {
    const row = (await parityRow(run.b.window))!;
    const started = Date.now();
    await run.b.window.evaluate(
      ({ hostId, pluginId }) => window.electron.pluginParity.installOnHost({ hostId, pluginId }),
      { hostId: run.hostId, pluginId: row.pluginId }
    );
    // It answers once the Host has it, not before.
    expect(await installedVersion(run.a.window)).toBe("1.2.3");
    console.log(`[remote-hosts parity] install on host took ${Date.now() - started} ms`);
    await expect
      .poll(async () => (await parityRow(run.b.window))?.group, { timeout: 30_000 })
      .toBe("same");
  });

  test("3. a newer copy on the Shell is offered as an update, and the Host takes it", async () => {
    await installOnShell(await packProbe("1.2.4"));
    await expect
      .poll(async () => parityRow(run.b.window), { timeout: 30_000 })
      .toMatchObject({
        group: "version-differs",
        localVersion: "1.2.4",
        hostVersion: "1.2.3",
        action: "update-on-host",
      });
    const row = (await parityRow(run.b.window))!;
    await run.b.window.evaluate(
      ({ hostId, pluginId }) => window.electron.pluginParity.updateOnHost({ hostId, pluginId }),
      { hostId: run.hostId, pluginId: row.pluginId }
    );
    expect(await installedVersion(run.a.window)).toBe("1.2.4");
    await expect
      .poll(async () => (await parityRow(run.b.window))?.group, { timeout: 30_000 })
      .toBe("same");
  });
});
