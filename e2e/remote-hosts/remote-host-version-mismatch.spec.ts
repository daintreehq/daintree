import { test, expect, type Page } from "@playwright/test";
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
 * A Host on another build: the same checkout launched from an app folder whose
 * package.json names another version, so `app.getVersion()` differs and the
 * handshake refuses the link. The Shell must say so in terms of both builds,
 * stop dialling, and connect normally once the Host runs its build again.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const HOST_NAME = "e2e-host";
const OTHER_VERSION = "0.0.1-e2e-other-build";

interface Run {
  root: string;
  sshd: PrivateSshd;
  wrapper: SshWrapper;
  otherBuildRoot: string;
  hostUserData: string;
  shellUserData: string;
  hostProject: { dir: string; name: string; cleanup: () => void };
  localProject: { dir: string; name: string; cleanup: () => void };
  a: AppContext;
  b: AppContext;
  hostId: string;
}

const run = { hostId: "" } as unknown as Run;

interface HostRow {
  descriptor: { id: string };
  connection: {
    status: string;
    mismatch?: { kind: string; local: unknown; remote: unknown };
    remote?: { version: string };
  };
}

async function hostRow(page: Page): Promise<HostRow | undefined> {
  const list = (await page.evaluate(() =>
    window.electron.remoteHosts.list()
  )) as unknown as HostRow[];
  return list.find((h) => h.descriptor.id === run.hostId);
}

/** This checkout under another version: every entry linked, package.json rewritten. */
async function makeOtherBuildRoot(parent: string): Promise<string> {
  const dir = path.join(parent, "other-build");
  await fs.mkdir(dir);
  for (const entry of await fs.readdir(ROOT)) {
    if (entry === "package.json" || entry === ".git") continue;
    await fs.symlink(path.join(ROOT, entry), path.join(dir, entry));
  }
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  pkg.version = OTHER_VERSION;
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  return dir;
}

async function startHost(appRoot?: string): Promise<AppContext> {
  const ctx = await launchApp({
    userDataDir: run.hostUserData,
    env: { HOME: run.sshd.home },
    alongside: true,
    ...(appRoot ? { appRoot } : {}),
  });
  await ctx.window.evaluate(() =>
    window.electron.hostMode.setEnabled({ enabled: true, startAtLogin: false })
  );
  await expect
    .poll(
      async () => (await ctx.window.evaluate(() => window.electron.hostMode.getStatus())).listening,
      {
        timeout: 30_000,
        message: "Host mode never started listening",
      }
    )
    .toBe(true);
  return ctx;
}

/** Link attempts the Shell made: ssh invocations that aren't master control commands. */
async function dialAttempts(): Promise<number> {
  const log = await run.wrapper.invocations();
  return log.split("\n").filter((line) => line.trim() && !line.includes(" -O ")).length;
}

test.describe.serial("Remote hosts: a Host on another build", () => {
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
    run.root = await makeShortTempRoot();
    run.sshd = await startPrivateSshd(run.root);
    run.wrapper = await writeSshWrapper(run.root, run.sshd.configPath);
    run.otherBuildRoot = await makeOtherBuildRoot(run.root);
    run.hostUserData = path.join(run.sshd.home, "Library", "Application Support", "Daintree");
    run.shellUserData = path.join(run.root, "shell");
    await fs.mkdir(run.hostUserData, { recursive: true, mode: 0o700 });
    await fs.mkdir(run.shellUserData, { recursive: true, mode: 0o700 });
    const hostFixture = createFixtureRepo({ name: "rh-host" });
    const localFixture = createFixtureRepo({ name: "rh-shell" });
    run.hostProject = { ...hostFixture, name: path.basename(hostFixture.dir) };
    run.localProject = { ...localFixture, name: path.basename(localFixture.dir) };

    run.a = await startHost(run.otherBuildRoot);
    expect(await run.a.app.evaluate(({ app }) => app.getVersion())).toBe(OTHER_VERSION);
    run.a.window = await openAndOnboardProject(run.a.app, run.a.window, run.hostProject.dir);

    run.b = await launchApp({
      userDataDir: run.shellUserData,
      env: {
        DAINTREE_SSH: run.wrapper.path,
        PATH: `${run.wrapper.binDir}:${process.env.PATH ?? ""}`,
      },
      alongside: true,
    });
    run.b.window = await openAndOnboardProject(run.b.app, run.b.window, run.localProject.dir);
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

  test("1. the Shell refuses the link, naming both builds, and stops dialling", async () => {
    const page = run.b.window;
    const added = (await page.evaluate(
      ({ name, target }) =>
        window.electron.remoteHosts.add({ name, connection: { kind: "ssh", target } }),
      { name: HOST_NAME, target: SSH_ALIAS }
    )) as { descriptor?: { id: string }; id?: string };
    run.hostId = added.descriptor?.id ?? added.id!;
    await page.evaluate((hostId) => window.electron.remoteHosts.connect({ hostId }), run.hostId);
    await expect
      .poll(async () => (await hostRow(page))?.connection.status, { timeout: 60_000 })
      .toBe("version-mismatch");
    const row = (await hostRow(page))!;
    const shellVersion = await run.b.app.evaluate(({ app }) => app.getVersion());
    expect(row.connection.mismatch).toMatchObject({
      kind: "version",
      local: shellVersion,
      remote: OTHER_VERSION,
    });
    expect(row.connection.remote?.version).toBe(OTHER_VERSION);

    // A mismatch doesn't back off and try again: nothing will change until
    // someone updates one side.
    const attempts = await dialAttempts();
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    expect(await dialAttempts()).toBe(attempts);
    expect((await hostRow(page))?.connection.status).toBe("version-mismatch");

    // The Host is fine: still listening, nobody attached.
    expect(
      (await run.a.window.evaluate(() => window.electron.hostMode.getStatus())).listening
    ).toBe(true);
  });

  test("2. once the Host runs this build again, connecting works", async () => {
    await closeApp(run.a.app);
    run.a = await startHost();
    expect(await run.a.app.evaluate(({ app }) => app.getVersion())).not.toBe(OTHER_VERSION);
    const page = run.b.window;
    await page.evaluate((hostId) => window.electron.remoteHosts.connect({ hostId }), run.hostId);
    await expect
      .poll(async () => (await hostRow(page))?.connection.status, { timeout: 60_000 })
      .toBe("connected");
    const projects = (await page.evaluate(
      (hostId) => window.electron.remoteHosts.listHostProjects({ hostId }),
      run.hostId
    )) as Array<{ name: string }>;
    expect(projects.map((p) => p.name)).toContain(run.hostProject.name);
  });
});
