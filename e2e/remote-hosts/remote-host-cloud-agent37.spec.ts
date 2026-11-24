import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo, removePathSync } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { openSettings } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { makeShortTempRoot, startPrivateSshd, type PrivateSshd } from "../helpers/privateSshd";
import {
  FAKE_AGENT37_KEY,
  startFakeAgent37,
  writeFakeAgent37Cli,
  type FakeAgent37,
} from "../helpers/fakeAgent37";

/**
 * Cloud hosts on Agent 37, end to end, against a fake of its API whose one
 * "instance" is a private sshd on this Mac in front of a real Host app (App
 * A, Host mode on). Unlike Boat, Agent 37 has no SSH address: the Shell (App
 * B) reaches the instance only through `ProxyCommand agent37 tunnel %h`, here
 * a fake `agent37` first on its PATH, and it pins no host key. Driven through
 * the Shell's own UI: connect an account from the provider menu, create an
 * instance (its key registered first), connect over that tunnel, stop it, see
 * an instance Agent 37 put to sleep read as asleep and stay asleep through a
 * reconnect, start it again, add one that already existed, and delete one.
 */

const HOST_NAME = "agent37-e2e";
const IMPORTED_NAME = "agent37-existing";

interface Run {
  root: string;
  sshd: PrivateSshd;
  agent37: FakeAgent37;
  hostUserData: string;
  shellUserData: string;
  hostProject: { dir: string; name: string; cleanup: () => void };
  localProject: { dir: string; name: string; cleanup: () => void };
  a: AppContext;
  b: AppContext;
  logs: { a: string[]; b: string[] };
  hostId: string;
  instanceId: string;
  /** Where the fake `agent37` is, which the generated route must run. */
  cliPath: string;
}

const run = { logs: { a: [], b: [] }, hostId: "", instanceId: "" } as unknown as Run;

function captureLogs(app: ElectronApplication, sink: string[]): void {
  const tap = (page: Page) =>
    page.on("console", (msg) => sink.push(`[${page.url()}] ${msg.type()}: ${msg.text()}`));
  for (const page of app.windows()) tap(page);
  app.on("window", tap);
  try {
    const proc = app.process();
    proc.stdout?.on("data", (chunk: Buffer) =>
      sink.push(`[main:out] ${chunk.toString().trimEnd()}`)
    );
    proc.stderr?.on("data", (chunk: Buffer) =>
      sink.push(`[main:err] ${chunk.toString().trimEnd()}`)
    );
  } catch {
    // Already gone.
  }
}

async function cloudHost(page: Page, hostId = run.hostId) {
  const snapshot = await page.evaluate(() => window.electron.cloudHosts.getSnapshot());
  return snapshot.hosts.find((entry) => entry.hostId === hostId) ?? null;
}

async function linkState(page: Page, hostId = run.hostId) {
  const entries = await page.evaluate(() => window.electron.remoteHosts.list());
  return entries.find((entry) => entry.descriptor.id === hostId)?.connection as
    { status?: string; detail?: string | null; stoppedRetrying?: boolean } | undefined;
}

function calls(method: string, pathPattern: RegExp) {
  return run.agent37.requests.filter((r) => r.method === method && pathPattern.test(r.path));
}

async function closeSettings(page: Page) {
  const heading = page.locator(SEL.settings.heading);
  if (!(await heading.isVisible().catch(() => false))) return;
  await page.keyboard.press("Escape");
  await expect(heading).toBeHidden({ timeout: 10_000 });
}

async function openHostsSettings(page: Page) {
  await openSettings(page);
  await page.locator(SEL.remoteHosts.settingsTab).click();
}

/** Add host's own setup steps, once the machine runs: the check over ssh finds Host mode on. */
async function expectSetupFindsHost(page: Page) {
  const setup = page.locator(SEL.remoteHosts.addHostDialog);
  await expect(setup).toContainText(/Host mode\s*Listening/, { timeout: 90_000 });
  const close = setup.getByRole("button", { name: /^(Done|Close|Cancel)$/ }).first();
  if (await close.isVisible().catch(() => false)) await close.click();
}

test.describe.serial("Cloud hosts: an Agent 37 instance as a Remote Host", () => {
  test.beforeAll(async () => {
    test.info().annotations.push({
      type: "platform-skip",
      description:
        "The private sshd, /usr/bin/nc and the host's socket location are macOS-only here",
    });
    test.skip(
      !(process.platform === "darwin" && existsSync("/usr/sbin/sshd") && existsSync("/usr/bin/nc")),
      "Needs macOS, /usr/sbin/sshd and /usr/bin/nc"
    );
    test.setTimeout(300_000);
    run.root = await makeShortTempRoot("dsa-");
    run.sshd = await startPrivateSshd(run.root);
    run.agent37 = await startFakeAgent37({ sshdRoot: run.root });
    const cli = await writeFakeAgent37Cli(run.root, {
      apiUrl: run.agent37.url,
      sshdPort: run.sshd.port,
    });
    run.cliPath = path.join(cli.binDir, "agent37");
    run.hostUserData = path.join(run.sshd.home, "Library", "Application Support", "Daintree");
    run.shellUserData = path.join(run.root, "shell");
    await fs.mkdir(run.hostUserData, { recursive: true, mode: 0o700 });
    await fs.mkdir(run.shellUserData, { recursive: true, mode: 0o700 });

    const hostFixture = createFixtureRepo({ name: "agent37-host" });
    const localFixture = createFixtureRepo({ name: "agent37-shell" });
    run.hostProject = { ...hostFixture, name: path.basename(hostFixture.dir) };
    run.localProject = { ...localFixture, name: path.basename(localFixture.dir) };

    run.a = await launchApp({
      userDataDir: run.hostUserData,
      env: { HOME: run.sshd.home },
      alongside: true,
    });
    captureLogs(run.a.app, run.logs.a);
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
        DAINTREE_AGENT37_API_URL: run.agent37.url,
        DAINTREE_SSH: cli.sshPath,
        PATH: `${cli.binDir}:${process.env.PATH ?? ""}`,
      },
      alongside: true,
    });
    captureLogs(run.b.app, run.logs.b);
    await run.b.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1400, 950);
    });
    run.b.window = await openAndOnboardProject(run.b.app, run.b.window, run.localProject.dir);
  });

  test.afterEach(async () => {
    const info = test.info();
    if (info.status === info.expectedStatus) return;
    const file = `${run.root}-cloud-agent37-diagnostics.log`;
    await fs
      .writeFile(
        file,
        [
          `# ${info.title}`,
          `## Agent 37 requests\n${JSON.stringify(run.agent37?.requests ?? [], null, 2)}`,
          `## Tunnels\n${(run.agent37?.tunnels ?? []).join("\n")}`,
          `## Shell console\n${run.logs.b.join("\n")}`,
          `## Host console\n${run.logs.a.join("\n")}`,
          `## sshd log\n${await fs.readFile(run.sshd?.logPath ?? "", "utf8").catch(() => "(none)")}`,
        ].join("\n\n")
      )
      .catch(() => {});
    console.log(`[cloud e2e] diagnostics: ${file}`);
  });

  test.afterAll(async () => {
    try {
      if (run.b?.app) await closeApp(run.b.app);
    } finally {
      if (run.a?.app) await closeApp(run.a.app);
      await run.agent37?.stop();
      await run.sshd?.stop();
      run.hostProject?.cleanup();
      run.localProject?.cleanup();
      if (run.root) removePathSync(run.root);
    }
  });

  test("1. connects an Agent 37 account from the provider menu, checking the key before it's saved", async () => {
    const page = run.b.window;
    await openHostsSettings(page);
    const section = page.locator('[id="hosts-cloud-providers"]');
    // Two providers: the connect button is a choice first.
    await section.getByTestId("cloud-connect-account").click();
    await page.getByRole("menuitem", { name: "Agent 37" }).click();
    const dialog = page.getByTestId("connect-cloud-account-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("cloud-account-api-key").fill("sk_live_wrong-agent37-e2e-0000");
    await dialog.getByRole("button", { name: "Check key" }).click();
    await expect(dialog.getByRole("alert")).toContainText("didn't accept");

    await dialog.getByTestId("cloud-account-api-key").fill(FAKE_AGENT37_KEY);
    await dialog.getByRole("button", { name: "Check key" }).click();
    await expect(dialog.getByRole("radio", { name: "Workspace" })).toBeChecked();
    await expect(dialog).toContainText("The workspace this key belongs to");
    await dialog.getByRole("button", { name: "Connect account" }).click();
    await expect(dialog).toBeHidden();
    await expect(section).toContainText("Agent 37");
    await expect(section).toContainText(`Key ending ${FAKE_AGENT37_KEY.slice(-4)}`);

    // Checked against the workspace's wallet; the key never left main for the page.
    expect(calls("GET", /^\/billing$/).length).toBeGreaterThan(0);
    const snapshot = JSON.stringify(
      await page.evaluate(() => window.electron.cloudHosts.getSnapshot())
    );
    expect(snapshot).not.toContain(FAKE_AGENT37_KEY);
    const config = await fs.readFile(path.join(run.shellUserData, "config.json"), "utf8");
    expect(config).not.toContain(FAKE_AGENT37_KEY);
  });

  test("2. creates an instance from Add host, its key registered first, and connects through the tunnel", async () => {
    const page = run.b.window;
    await page.getByRole("button", { name: "Add host", exact: true }).first().click();
    const addHost = page.locator(SEL.remoteHosts.addHostDialog);
    await addHost.getByRole("button", { name: "Create a cloud machine instead" }).click();
    const dialog = page.getByTestId("add-cloud-host-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("add-cloud-host-name").fill(HOST_NAME);
    await expect(dialog.getByRole("radio", { name: /^Small/ })).toBeChecked();
    // Agent 37 sleeps it rather than asking for a lifetime.
    await expect(dialog.getByTestId("add-cloud-host-lifetime")).toHaveCount(0);
    await expect(dialog.getByTestId("add-cloud-host-review")).toContainText(
      "It sleeps by itself after 30 minutes without activity."
    );
    expect(calls("POST", /^\/instances$/)).toHaveLength(0);

    await dialog.getByRole("button", { name: "Create and connect" }).click();
    await expect(page.getByTestId("add-cloud-host-progress")).toBeVisible();
    await expectSetupFindsHost(page);

    const keys = calls("POST", /^\/ssh-keys$/);
    const creates = calls("POST", /^\/instances$/);
    expect(creates).toHaveLength(1);
    expect(keys.length).toBeGreaterThan(0);
    // The key was registered, and answered, before the create was asked for.
    expect(run.agent37.requests.indexOf(keys[0]!)).toBeLessThan(
      run.agent37.requests.indexOf(creates[0]!)
    );
    expect((keys[0]!.body as { public_key: string }).public_key).toMatch(/^ssh-ed25519 /);
    expect(JSON.stringify(keys[0]!.body)).not.toMatch(/PRIVATE/);
    expect(creates[0]!.body).toMatchObject({
      template: "agent37-base",
      type: "default",
      resources: { cpu: 2, memory: 4, disk: 12 },
      name: HOST_NAME,
      auto_sleep: true,
      // The host's own idle time, which its Idle after starts at (#17916).
      idle_timeout_seconds: 1800,
      metadata: { daintree: "1" },
    });

    const hosts = await page.evaluate(() => window.electron.remoteHosts.list());
    const entry = hosts.find((h) => h.descriptor.name === HOST_NAME);
    expect(entry?.descriptor.connection.kind).toBe("cloud");
    run.hostId = entry!.descriptor.id;
    run.instanceId = (await cloudHost(page))!.resourceId!;

    await page.evaluate((id) => window.electron.remoteHosts.connect({ hostId: id }), run.hostId);
    await expect
      .poll(async () => (await linkState(page))?.status, { timeout: 60_000 })
      .toBe("connected");
    expect(run.agent37.tunnels).toContain(`${run.instanceId}.agent37.app`);

    // The route names the instance for the tunnel, as node, and pins no key.
    const machines = path.join(run.shellUserData, "rh", "cloud", "machines");
    const [bindingDir] = await fs.readdir(machines);
    const sshConfig = await fs.readFile(path.join(machines, bindingDir!, "config"), "utf8");
    expect(sshConfig).toContain(`HostName ${run.instanceId}.agent37.app`);
    expect(sshConfig).toContain("User node");
    expect(sshConfig).toContain(`ProxyCommand "${run.cliPath}" "tunnel" "%h"`);
    expect(sshConfig).toContain("StrictHostKeyChecking no");
    expect(existsSync(path.join(machines, bindingDir!, "known_hosts"))).toBe(false);
  });

  test("3. stopping lets go of the link, and a reconnect opens no tunnel and starts nothing", async () => {
    const page = run.b.window;
    await page.evaluate((id) => window.electron.cloudHosts.stopHost({ hostId: id }), run.hostId);
    await expect
      .poll(async () => (await cloudHost(page))?.machine, { timeout: 60_000 })
      .toBe("stopped");
    expect((await linkState(page))?.status).not.toBe("connected");
    expect(calls("POST", /\/stop$/)).toHaveLength(1);

    const tunnelsBefore = run.agent37.tunnels.length;
    await page.evaluate((id) => window.electron.remoteHosts.connect({ hostId: id }), run.hostId);
    await expect
      .poll(async () => (await linkState(page))?.status, { timeout: 30_000 })
      .toBe("unreachable");
    const state = await linkState(page);
    expect(state?.detail ?? "").toContain("stopped");
    expect(state?.stoppedRetrying).toBe(true);
    expect(run.agent37.tunnels).toHaveLength(tunnelsBefore);
    expect(calls("POST", /\/start$/)).toHaveLength(0);
  });

  test("4. Settings starts the instance from its row, and the host reconnects", async () => {
    const page = run.b.window;
    await openHostsSettings(page);
    const list = page.locator('[id="hosts-list"]');
    await expect(list).toContainText("Machine stopped");
    await expect(list).toContainText("Agent 37");
    await list.getByRole("button", { name: `Start ${HOST_NAME}` }).click();
    await expect
      .poll(async () => (await cloudHost(page))?.machine, { timeout: 60_000 })
      .toBe("running");
    expect(calls("POST", /\/start$/)).toHaveLength(1);
    await page.evaluate(
      (id) => window.electron.remoteHosts.connect({ hostId: id, restart: true }),
      run.hostId
    );
    await expect
      .poll(async () => (await linkState(page))?.status, { timeout: 60_000 })
      .toBe("connected");
    await closeSettings(page);
  });

  test("5. an instance Agent 37 put to sleep reads as asleep, and a reconnect doesn't wake it", async () => {
    const page = run.b.window;
    // Agent 37 sleeps an instance only once nothing moves through it.
    await page.evaluate((id) => window.electron.remoteHosts.disconnect({ hostId: id }), run.hostId);
    run.agent37.sleep(run.instanceId);
    await page.evaluate((id) => window.electron.cloudHosts.refreshHost({ hostId: id }), run.hostId);
    await expect.poll(async () => (await cloudHost(page))?.asleep).toBe(true);
    expect((await cloudHost(page))?.machine).toBe("stopped");

    await openHostsSettings(page);
    await expect(page.locator('[id="hosts-list"]')).toContainText("Machine asleep");
    await closeSettings(page);

    const tunnelsBefore = run.agent37.tunnels.length;
    const startsBefore = calls("POST", /\/start$/).length;
    await page.evaluate((id) => window.electron.remoteHosts.connect({ hostId: id }), run.hostId);
    await expect
      .poll(async () => (await linkState(page))?.status, { timeout: 30_000 })
      .toBe("unreachable");
    const asleepState = await linkState(page);
    expect(asleepState?.detail ?? "").toContain("asleep");
    expect(asleepState?.stoppedRetrying).toBe(true);
    expect(run.agent37.tunnels).toHaveLength(tunnelsBefore);
    expect(calls("POST", /\/start$/)).toHaveLength(startsBefore);
    expect(run.agent37.instances.get(run.instanceId)?.status).toBe("sleeping");

    // A person's Start wakes it.
    await page.evaluate((id) => window.electron.cloudHosts.startHost({ hostId: id }), run.hostId);
    await expect
      .poll(async () => (await cloudHost(page))?.machine, { timeout: 60_000 })
      .toBe("running");
    expect((await cloudHost(page))?.asleep).toBe(false);
    await page.evaluate(
      (id) => window.electron.remoteHosts.connect({ hostId: id, restart: true }),
      run.hostId
    );
    await expect
      .poll(async () => (await linkState(page))?.status, { timeout: 60_000 })
      .toBe("connected");
  });

  test("6. adds an instance that already exists, creating and starting nothing", async () => {
    const page = run.b.window;
    const existing = run.agent37.seed({
      name: IMPORTED_NAME,
      resources: { cpu: 2, memory: 4, disk: 6 },
    });
    const createsBefore = calls("POST", /^\/instances$/).length;
    await openHostsSettings(page);
    await page.getByTestId("hosts-add-host").click();
    await page
      .locator(SEL.remoteHosts.addHostDialog)
      .getByRole("button", { name: "Create a cloud machine instead" })
      .click();
    const dialog = page.getByTestId("add-cloud-host-dialog");
    await dialog.getByRole("radio", { name: "Existing machine" }).click();
    await dialog.getByRole("radio", { name: new RegExp(`^${IMPORTED_NAME}`) }).check();
    await expect(dialog.getByTestId("add-cloud-host-import-note")).toContainText(
      "Adding it doesn't start it or change whether Agent 37 puts it to sleep when idle."
    );
    await dialog.getByRole("button", { name: "Add machine" }).click();
    await expectSetupFindsHost(page);

    expect(calls("POST", /^\/instances$/)).toHaveLength(createsBefore);
    expect(calls("POST", new RegExp(`^/instances/${existing.id}/start$`))).toHaveLength(0);
    expect(run.agent37.tunnels).toContain(`${existing.id}.agent37.app`);
    const hosts = await page.evaluate(() => window.electron.remoteHosts.list());
    const imported = hosts.find((h) => h.descriptor.name === IMPORTED_NAME);
    expect(imported?.descriptor.connection.kind).toBe("cloud");
    // Sleeping is off on this one: it runs until it's stopped.
    expect((await cloudHost(page, imported!.descriptor.id))?.lifetime).toEqual({ kind: "none" });
  });

  test("7. removing the created host can delete its instance, after its name is typed", async () => {
    const page = run.b.window;
    await openHostsSettings(page);
    await page
      .locator('[id="hosts-list"]')
      .getByRole("button", { name: `Remove ${HOST_NAME} from this device` })
      .click();
    const dialog = page
      .locator('[role="dialog"], [role="alertdialog"]')
      .filter({ has: page.getByTestId("remove-cloud-host-choice") });
    await expect(dialog).toContainText(`Remove '${HOST_NAME}'?`);
    await expect(dialog.getByTestId("remove-cloud-host-choice")).toContainText(
      "Keep it on Agent 37"
    );
    await dialog.getByRole("radio", { name: "Delete the machine too" }).check();
    const deleteButton = dialog.getByRole("button", { name: "Delete machine" });
    await expect(deleteButton).toHaveAttribute("aria-disabled", "true");
    expect(run.agent37.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    await dialog.getByLabel(`Type ${HOST_NAME} to confirm`).fill(HOST_NAME);
    await expect(deleteButton).not.toHaveAttribute("aria-disabled", "true");
    await deleteButton.click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    const deletes = run.agent37.requests.filter((r) => r.method === "DELETE");
    expect(deletes.map((r) => r.path)).toEqual([`/instances/${run.instanceId}`]);
    expect(run.agent37.instances.has(run.instanceId)).toBe(false);
    const hosts = await page.evaluate(() => window.electron.remoteHosts.list());
    expect(hosts.find((h) => h.descriptor.id === run.hostId)).toBeUndefined();
    // The workspace keeps Daintree's key: it opens every instance there, the added one included.
    expect(calls("DELETE", /^\/ssh-keys/)).toHaveLength(0);
  });
});
