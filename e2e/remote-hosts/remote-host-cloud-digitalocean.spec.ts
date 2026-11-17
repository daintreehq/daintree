import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo, removePathSync } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { openSettings } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { makeShortTempRoot, startPrivateSshd, type PrivateSshd } from "../helpers/privateSshd";
import {
  FAKE_DO_TEAM,
  FAKE_DO_TOKEN,
  startFakeDigitalOcean,
  writeDropletSshWrappers,
  type FakeDigitalOcean,
} from "../helpers/fakeDigitalOcean";

/**
 * A DigitalOcean Droplet as a cloud host, against a fake DigitalOcean API
 * whose one "Droplet" is a private sshd on this Mac in front of a real Host
 * app (App A, Host mode on). App B, the Shell, connects a team token, creates
 * a Droplet from a region, image and size with the account's key, confirms
 * the host key the Droplet presents (no API vouches for one), connects over
 * real ssh, stops it with the copy that says it still bills in full, starts
 * it, and deletes it.
 *
 * DigitalOcean's sshd is port 22 as `daintree`; the Shell's ssh is a wrapper
 * that adds the private port and this Mac's user, leaving the route Daintree
 * writes as a real Droplet gets it.
 */

const HOST_NAME = "droplet-e2e";

interface Run {
  root: string;
  sshd: PrivateSshd;
  api: FakeDigitalOcean;
  hostUserData: string;
  shellUserData: string;
  hostProject: { dir: string; name: string; cleanup: () => void };
  localProject: { dir: string; name: string; cleanup: () => void };
  a: AppContext;
  b: AppContext;
  logs: { a: string[]; b: string[] };
  hostId: string;
}

const run = { logs: { a: [], b: [] }, hostId: "" } as unknown as Run;

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

async function cloudHost(page: Page) {
  const snapshot = await page.evaluate(() => window.electron.cloudHosts.getSnapshot());
  return snapshot.hosts.find((entry) => entry.hostId === run.hostId) ?? null;
}

async function linkStatus(page: Page): Promise<string | undefined> {
  const entries = await page.evaluate(() => window.electron.remoteHosts.list());
  return entries.find((entry) => entry.descriptor.id === run.hostId)?.connection.status;
}

function calls(method: string, pathPrefix: string) {
  return run.api.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix));
}

function confirmDialog(page: Page, title: string) {
  return page.locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: title });
}

async function closeSettings(page: Page) {
  const heading = page.locator(SEL.settings.heading);
  if (!(await heading.isVisible().catch(() => false))) return;
  await page.keyboard.press("Escape");
  await expect(heading).toBeHidden({ timeout: 10_000 });
}

async function openHostDetails(page: Page) {
  await openSettings(page);
  await page.locator(SEL.remoteHosts.settingsTab).click();
  await page
    .locator('[id="hosts-list"]')
    .getByRole("button", { name: `Details for ${HOST_NAME}` })
    .click();
  const section = page.locator('[id="host-cloud-machine"]');
  await expect(section).toBeVisible();
  return section;
}

/** The fingerprint `ssh-keygen -l` prints for the private sshd's own host key. */
async function sshdFingerprint(): Promise<string> {
  const { stdout } = await promisify(execFile)("ssh-keygen", [
    "-l",
    "-f",
    path.join(run.root, "hostkey.pub"),
  ]);
  return stdout.split(" ")[1]!;
}

test.describe.serial("Cloud hosts: a DigitalOcean Droplet as a Remote Host", () => {
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
    run.root = await makeShortTempRoot("dsd-");
    run.sshd = await startPrivateSshd(run.root);
    run.api = await startFakeDigitalOcean({ sshdRoot: run.root });
    const ssh = await writeDropletSshWrappers(run.root, run.sshd.port);
    run.hostUserData = path.join(run.sshd.home, "Library", "Application Support", "Daintree");
    run.shellUserData = path.join(run.root, "shell");
    await fs.mkdir(run.hostUserData, { recursive: true, mode: 0o700 });
    await fs.mkdir(run.shellUserData, { recursive: true, mode: 0o700 });

    const hostFixture = createFixtureRepo({ name: "droplet-host" });
    const localFixture = createFixtureRepo({ name: "droplet-shell" });
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
        DAINTREE_DIGITALOCEAN_API_URL: run.api.url,
        // Boat too, at an address that answers nothing: no step here may reach a real provider.
        DAINTREE_BOAT_API_URL: "http://127.0.0.1:9/api/v1",
        DAINTREE_SSH: ssh,
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
    const file = `${run.root}-cloud-diagnostics.log`;
    await fs
      .writeFile(
        file,
        [
          `# ${info.title}`,
          `## DigitalOcean requests\n${JSON.stringify(run.api?.requests ?? [], null, 2)}`,
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
      await run.api?.stop();
      await run.sshd?.stop();
      run.hostProject?.cleanup();
      run.localProject?.cleanup();
      if (run.root) removePathSync(run.root);
    }
  });

  test("1. connects a DigitalOcean team with a token that is checked before it's saved", async () => {
    const page = run.b.window;
    await openSettings(page);
    await page.locator(SEL.remoteHosts.settingsTab).click();
    const section = page.locator('[id="hosts-cloud-providers"]');
    await section.getByTestId("cloud-connect-account").click();
    await page.getByRole("menuitem", { name: "DigitalOcean" }).click();
    const dialog = page.getByTestId("connect-cloud-account-dialog");
    await expect(dialog).toContainText("Personal access token");

    await dialog.getByTestId("cloud-account-api-key").fill("dop_v1_wrong");
    await dialog.getByRole("button", { name: "Check key" }).click();
    await expect(dialog.getByRole("alert")).toContainText("didn't accept");
    expect(calls("GET", "/droplets")).toHaveLength(0);

    await dialog.getByTestId("cloud-account-api-key").fill(FAKE_DO_TOKEN);
    await dialog.getByRole("button", { name: "Check key" }).click();
    await expect(dialog.getByRole("radio", { name: FAKE_DO_TEAM.name })).toBeChecked();
    await dialog.getByRole("button", { name: "Connect account" }).click();
    await expect(dialog).toBeHidden();
    await expect(section).toContainText("DigitalOcean");
    await expect(section).toContainText(`Key ending ${FAKE_DO_TOKEN.slice(-4)}`);

    // Checked twice (once in the dialog, once again on save), and able to read Droplets each time.
    expect(calls("GET", "/droplets?per_page=1").length).toBeGreaterThanOrEqual(2);
    const snapshot = JSON.stringify(
      await page.evaluate(() => window.electron.cloudHosts.getSnapshot())
    );
    expect(snapshot).not.toContain(FAKE_DO_TOKEN);
    await closeSettings(page);
  });

  test("2. creates a Droplet from a region, image and size with the account's key", async () => {
    const page = run.b.window;
    await page.getByRole("button", { name: "Add host", exact: true }).first().click();
    const addHost = page.locator(SEL.remoteHosts.addHostDialog);
    await addHost.getByRole("button", { name: "Create a cloud machine instead" }).click();
    const dialog = page.getByTestId("add-cloud-host-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("add-cloud-host-name").fill(HOST_NAME);
    await expect(dialog.getByTestId("add-cloud-host-location")).toContainText("New York 3");
    await expect(dialog.getByTestId("add-cloud-host-image")).toContainText("Ubuntu 24.04");
    // Too small for a Host, so not offered; the cheapest that fits comes first.
    await expect(dialog.getByRole("radio", { name: /s-1vcpu-1gb/ })).toHaveCount(0);
    await dialog.getByRole("radio", { name: /s-2vcpu-4gb/ }).check();
    await expect(dialog.getByTestId("add-cloud-host-review")).toContainText("$0.036 an hour");
    await expect(dialog.getByTestId("add-cloud-host-review")).toContainText(
      "bills a stopped Droplet in full"
    );
    await dialog.getByRole("button", { name: "Create and connect" }).click();

    await expect
      .poll(
        async () => {
          const hosts = await page.evaluate(() => window.electron.remoteHosts.list());
          return hosts.find((h) => h.descriptor.name === HOST_NAME)?.descriptor.id ?? "";
        },
        { timeout: 30_000 }
      )
      .not.toBe("");
    const hosts = await page.evaluate(() => window.electron.remoteHosts.list());
    run.hostId = hosts.find((h) => h.descriptor.name === HOST_NAME)!.descriptor.id;

    const creates = calls("POST", "/droplets").filter((r) => r.path === "/droplets");
    expect(creates).toHaveLength(1);
    const body = creates[0]!.body as {
      name: string;
      region: string;
      image: string;
      size: string;
      ssh_keys: number[];
      tags: string[];
      user_data: string;
    };
    expect(body).toMatchObject({
      name: HOST_NAME,
      region: "nyc3",
      image: "ubuntu-24-04-x64",
      size: "s-2vcpu-4gb",
    });
    // The account's key, registered once and named by id; its blob also reaches the login user.
    const registered = calls("POST", "/account/keys");
    expect(registered).toHaveLength(1);
    const publicKey = (registered[0]!.body as { public_key: string }).public_key;
    expect(publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+$/);
    expect(body.ssh_keys).toEqual([...run.api.keys.keys()]);
    expect(body.user_data).toContain(publicKey.split(" ")[1]);
    expect(body.tags).toContain("daintree:1");
    expect(body.tags.some((tag) => tag.startsWith("daintree-binding:cb_"))).toBe(true);
    expect(JSON.stringify(body)).not.toContain(FAKE_DO_TOKEN);

    // No API vouches for the Droplet's host key: it waits for the person, and nothing connects.
    await expect
      .poll(async () => (await cloudHost(page))?.hostKeyReview?.reason ?? null, {
        timeout: 90_000,
      })
      .toBe("first-connect");
    expect((await cloudHost(page))?.hostKeyReview?.fingerprint).toBe(await sshdFingerprint());
    expect(await linkStatus(page)).not.toBe("connected");
    const setup = page.locator(SEL.remoteHosts.addHostDialog);
    const close = setup.getByRole("button", { name: /^(Done|Close|Cancel)$/ }).first();
    if (await close.isVisible().catch(() => false)) await close.click();
  });

  test("3. the person confirms the host key, then it connects over real ssh with that key pinned", async () => {
    const page = run.b.window;
    const section = await openHostDetails(page);
    await expect(section).toContainText("Confirm host key");
    await expect(section).toContainText(await sshdFingerprint());
    await section.getByRole("button", { name: "Trust this key" }).click();
    await expect(section).not.toContainText("Confirm host key");

    await page.evaluate((id) => window.electron.remoteHosts.connect({ hostId: id }), run.hostId);
    await expect.poll(() => linkStatus(page), { timeout: 90_000 }).toBe("connected");

    // The route is a Droplet's own: user daintree on port 22, its key pinned.
    const machines = path.join(run.shellUserData, "rh", "cloud", "machines");
    const [bindingDir] = await fs.readdir(machines);
    const sshConfig = await fs.readFile(path.join(machines, bindingDir!, "config"), "utf8");
    expect(sshConfig).toContain("User daintree");
    expect(sshConfig).toContain("Port 22");
    expect(sshConfig).toContain("StrictHostKeyChecking yes");
    const knownHosts = await fs.readFile(path.join(machines, bindingDir!, "known_hosts"), "utf8");
    const hostKey = (await fs.readFile(path.join(run.root, "hostkey.pub"), "utf8"))
      .split(" ")
      .slice(0, 2)
      .join(" ");
    expect(knownHosts.trim()).toBe(`dtc-${bindingDir} ${hostKey}`);
    await closeSettings(page);
  });

  test("4. Stop says a stopped Droplet still bills in full, and shuts it down gracefully", async () => {
    const page = run.b.window;
    await page.locator(SEL.remoteHosts.hostChip).click();
    await page.getByTestId("host-chip-cloud-machines").click();
    await page.locator(`[data-cloud-machine-host-id="${run.hostId}"]`).click();
    const confirm = confirmDialog(page, `Stop '${HOST_NAME}'?`);
    await expect(confirm).toContainText(
      "DigitalOcean bills a stopped Droplet in full until it's deleted. To stop paying for it, remove the host and delete its machine."
    );
    await confirm.getByRole("button", { name: "Stop machine" }).click();
    await expect
      .poll(async () => (await cloudHost(page))?.machine, { timeout: 60_000 })
      .toBe("stopped");
    const powerActions = calls("POST", "/droplets/").map((r) => (r.body as { type?: string }).type);
    expect(powerActions).toContain("shutdown");
    expect(powerActions).not.toContain("power_off");
    expect(await linkStatus(page)).not.toBe("connected");
  });

  test("5. Start powers it on, and it reconnects with the key already trusted", async () => {
    const page = run.b.window;
    await page.evaluate((id) => window.electron.cloudHosts.startHost({ hostId: id }), run.hostId);
    await expect
      .poll(async () => (await cloudHost(page))?.machine, { timeout: 60_000 })
      .toBe("running");
    expect(calls("POST", "/droplets/").map((r) => (r.body as { type?: string }).type)).toContain(
      "power_on"
    );
    await page.evaluate(
      (id) => window.electron.remoteHosts.connect({ hostId: id, restart: true }),
      run.hostId
    );
    await expect.poll(() => linkStatus(page), { timeout: 60_000 }).toBe("connected");
    expect((await cloudHost(page))?.hostKeyReview).toBeNull();
  });

  test("6. removing the host can delete the Droplet, which ends its bill", async () => {
    const page = run.b.window;
    await openSettings(page);
    await page.locator(SEL.remoteHosts.settingsTab).click();
    await page
      .locator('[id="hosts-list"]')
      .getByRole("button", { name: `Remove ${HOST_NAME} from this device` })
      .click();
    const dialog = page
      .locator('[role="dialog"], [role="alertdialog"]')
      .filter({ has: page.getByTestId("remove-cloud-host-choice") });
    await dialog.getByRole("radio", { name: "Delete the machine too" }).check();
    await dialog.getByLabel(`Type ${HOST_NAME} to confirm`).fill(HOST_NAME);
    await dialog.getByRole("button", { name: "Delete machine" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    expect(run.api.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    expect(run.api.droplets.size).toBe(0);
    // The account key stays: other Droplets on the team may still use it.
    expect(run.api.keys.size).toBe(1);
    const hosts = await page.evaluate(() => window.electron.remoteHosts.list());
    expect(hosts.find((h) => h.descriptor.id === run.hostId)).toBeUndefined();
  });
});
