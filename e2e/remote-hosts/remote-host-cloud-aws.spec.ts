import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo, removePathSync } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { openSettings } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { makeShortTempRoot, startPrivateSshd, type PrivateSshd } from "../helpers/privateSshd";
import {
  FAKE_AWS_ACCESS_KEY_ID,
  FAKE_AWS_ACCOUNT,
  FAKE_AWS_SECRET,
  startFakeEc2,
  type FakeEc2,
} from "../helpers/fakeEc2";

/**
 * AWS EC2 cloud hosts end to end, against a fake of the EC2 and STS APIs
 * whose instances are a private sshd on this Mac in front of a real Host app
 * (App A, Host mode on). App B, the Shell, is driven through its own UI:
 * connect an AWS account (first refused for a missing permission), create an
 * instance in another region than the credentials' own, connect over real
 * ssh with the host key pinned from the console output, stop it, start it
 * again and delete it.
 *
 * Production routes name the instance's public address, port 22 and the
 * image's `ubuntu` user; `DAINTREE_SSH` points at wrappers that send every
 * ssh and ssh-keyscan to the private sshd as the local user instead, leaving
 * the route, its pinned key and its strict checking exactly as written.
 * Screenshots go to `.tmp/cloud-aws-shots/` (or DAINTREE_SHOT_DIR).
 */

const HOST_NAME = "aws-e2e";
const HOME_REGION = "us-east-2";
const MACHINE_REGION = "eu-west-1";

interface Run {
  root: string;
  sshd: PrivateSshd;
  ec2: FakeEc2;
  hostUserData: string;
  shellUserData: string;
  hostProject: { dir: string; name: string; cleanup: () => void };
  localProject: { dir: string; name: string; cleanup: () => void };
  a: AppContext;
  b: AppContext;
  logs: { a: string[]; b: string[] };
  hostId: string;
  shotDir: string;
  shot: number;
}

const run = { logs: { a: [], b: [] }, hostId: "", shot: 0 } as unknown as Run;

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

async function shoot(page: Page, name: string): Promise<void> {
  run.shot += 1;
  const file = path.join(run.shotDir, `${String(run.shot).padStart(2, "0")}-${name}.png`);
  await page
    .evaluate(() =>
      Promise.race([
        Promise.all(
          document.getAnimations().map((animation) => animation.finished.catch(() => {}))
        ),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ])
    )
    .catch(() => {});
  await page.screenshot({ path: file, animations: "disabled" });
}

async function cloudHost(page: Page) {
  const snapshot = await page.evaluate(() => window.electron.cloudHosts.getSnapshot());
  return snapshot.hosts.find((entry) => entry.hostId === run.hostId) ?? null;
}

async function linkStatus(page: Page): Promise<string | undefined> {
  const entries = await page.evaluate(() => window.electron.remoteHosts.list());
  return entries.find((entry) => entry.descriptor.id === run.hostId)?.connection.status;
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

/** ssh and ssh-keyscan that reach the private sshd whatever address, port and user a route names. */
async function writeSshWrappers(dir: string, port: number): Promise<string> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const user = os.userInfo().username;
  const ssh = path.join(dir, "ssh");
  // Options given on the command line win over the route's config file.
  await fs.writeFile(
    ssh,
    `#!/bin/sh\nexec /usr/bin/ssh -o HostName=127.0.0.1 -o Port=${port} -o User=${user} "$@"\n`,
    { mode: 0o755 }
  );
  await fs.writeFile(
    path.join(dir, "ssh-keyscan"),
    [
      "#!/bin/sh",
      'types="ed25519,ecdsa,rsa"; timeout=10',
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      '    -t) types="$2"; shift 2 ;;',
      '    -T) timeout="$2"; shift 2 ;;',
      "    -p) shift 2 ;;",
      "    *) shift ;;",
      "  esac",
      "done",
      `exec /usr/bin/ssh-keyscan -T "$timeout" -p ${port} -t "$types" 127.0.0.1`,
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  return ssh;
}

test.describe.serial("Cloud hosts: an AWS EC2 instance as a Remote Host", () => {
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
    run.root = await makeShortTempRoot("dsa-");
    run.shotDir =
      process.env.DAINTREE_SHOT_DIR ?? path.resolve(process.cwd(), ".tmp/cloud-aws-shots");
    await fs.mkdir(run.shotDir, { recursive: true });
    run.sshd = await startPrivateSshd(run.root);
    run.ec2 = await startFakeEc2({ sshdRoot: run.root });
    const ssh = await writeSshWrappers(path.join(run.root, "bin"), run.sshd.port);
    run.hostUserData = path.join(run.sshd.home, "Library", "Application Support", "Daintree");
    run.shellUserData = path.join(run.root, "shell");
    await fs.mkdir(run.hostUserData, { recursive: true, mode: 0o700 });
    await fs.mkdir(run.shellUserData, { recursive: true, mode: 0o700 });

    const hostFixture = createFixtureRepo({ name: "aws-host" });
    const localFixture = createFixtureRepo({ name: "aws-shell" });
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
        {
          timeout: 30_000,
        }
      )
      .toBe(true);

    run.b = await launchApp({
      userDataDir: run.shellUserData,
      env: { DAINTREE_AWS_API_URL: run.ec2.url, DAINTREE_SSH: ssh },
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
    const file = `${run.root}-cloud-aws-diagnostics.log`;
    await fs
      .writeFile(
        file,
        [
          `# ${info.title}`,
          `## EC2 requests\n${JSON.stringify(run.ec2?.requests ?? [], null, 2)}`,
          `## Shell console\n${run.logs.b.join("\n")}`,
          `## Host console\n${run.logs.a.join("\n")}`,
          `## sshd log\n${await fs.readFile(run.sshd?.logPath ?? "", "utf8").catch(() => "(none)")}`,
        ].join("\n\n")
      )
      .catch(() => {});
    console.log(`[cloud aws e2e] diagnostics: ${file}`);
  });

  test.afterAll(async () => {
    try {
      if (run.b?.app) await closeApp(run.b.app);
    } finally {
      if (run.a?.app) await closeApp(run.a.app);
      await run.ec2?.stop();
      await run.sshd?.stop();
      run.hostProject?.cleanup();
      run.localProject?.cleanup();
      if (run.root) removePathSync(run.root);
    }
  });

  test("1. connects an AWS account, after naming the permission its keys were missing", async () => {
    const page = run.b.window;
    await openSettings(page);
    await page.locator(SEL.remoteHosts.settingsTab).click();
    const section = page.locator('[id="hosts-cloud-providers"]');
    await section.getByTestId("cloud-connect-account").click();
    await page.getByRole("menuitem", { name: "AWS" }).click();
    const dialog = page.getByTestId("connect-cloud-account-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("cloud-account-credential-accessKeyId").fill(FAKE_AWS_ACCESS_KEY_ID);
    await dialog.getByTestId("cloud-account-credential-secretAccessKey").fill(FAKE_AWS_SECRET);
    await dialog.getByTestId("cloud-account-credential-region").fill(HOME_REGION);

    run.ec2.denied.add("RunInstances");
    await dialog.getByRole("button", { name: "Check credentials" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Missing: ec2:RunInstances");
    await shoot(page, "connect-aws-missing-permission");
    // Every probe went to the home region, and none of them was a real call.
    const probes = run.ec2.requests.filter((r) => r.service === "ec2");
    expect(new Set(probes.map((r) => r.region))).toEqual(new Set([HOME_REGION]));
    expect(run.ec2.calls("RunInstances")).toHaveLength(0);

    run.ec2.denied.clear();
    await dialog.getByRole("button", { name: "Check credentials" }).click();
    await expect(
      dialog.getByRole("radio", { name: `AWS account ${FAKE_AWS_ACCOUNT}` })
    ).toBeChecked();
    await shoot(page, "connect-aws-checked");
    await dialog.getByRole("button", { name: "Connect account" }).click();
    await expect(dialog).toBeHidden();
    await expect(section).toContainText(`arn:aws:iam::${FAKE_AWS_ACCOUNT}:user/e2e`);
    await expect(section).toContainText(`ending ${FAKE_AWS_ACCESS_KEY_ID.slice(-4)}`);
    await shoot(page, "settings-aws-account-connected");

    const snapshot = JSON.stringify(
      await page.evaluate(() => window.electron.cloudHosts.getSnapshot())
    );
    expect(snapshot).not.toContain(FAKE_AWS_SECRET);
    const config = await fs.readFile(path.join(run.shellUserData, "config.json"), "utf8");
    expect(config).not.toContain(FAKE_AWS_SECRET);
  });

  test("2. creates an instance in another region and connects over ssh, its key pinned from the console", async () => {
    const page = run.b.window;
    await page.getByRole("button", { name: "Add host", exact: true }).first().click();
    const addHost = page.locator(SEL.remoteHosts.addHostDialog);
    await addHost.getByRole("button", { name: "Create a cloud machine instead" }).click();
    const dialog = page.getByTestId("add-cloud-host-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("add-cloud-host-name").fill(HOST_NAME);
    await expect(dialog.getByTestId("add-cloud-host-location")).toContainText(HOME_REGION);
    await dialog.getByTestId("add-cloud-host-location").click();
    await page.getByRole("option", { name: new RegExp(MACHINE_REGION) }).click();
    await expect(dialog.getByTestId("add-cloud-host-image")).toContainText("Ubuntu 24.04 LTS");
    await dialog.getByRole("radio", { name: /^t3\.medium/ }).check();
    const review = dialog.getByTestId("add-cloud-host-review");
    await expect(review).toContainText(`AWS account ${FAKE_AWS_ACCOUNT}`);
    await expect(review).toContainText("still billed for storage");
    await shoot(page, "add-aws-host-form");
    expect(run.ec2.calls("RunInstances")).toHaveLength(0);

    await dialog.getByRole("button", { name: "Create and connect" }).click();
    const setup = page.locator(SEL.remoteHosts.addHostDialog);
    await expect(setup).toContainText(/Host mode\s*Listening/, { timeout: 120_000 });
    await shoot(page, "aws-host-setup-check");

    const launches = run.ec2.calls("RunInstances");
    expect(launches).toHaveLength(1);
    const launch = launches[0]!;
    expect(launch.region).toBe(MACHINE_REGION);
    expect(launch.params.InstanceType).toBe("t3.medium");
    expect(launch.params.ImageId).toMatch(/^ami-/);
    expect(launch.params.ClientToken).toBeTruthy();
    expect(launch.params["MetadataOptions.HttpTokens"]).toBe("required");
    const [instance] = [...run.ec2.instances.values()];
    expect(instance!.tags).toMatchObject({ Name: HOST_NAME, daintree: "1" });
    expect(instance!.tags["daintree-binding"]).toBeTruthy();
    expect(instance!.userData).toMatch(/^#cloud-config\nssh_authorized_keys:\n {2}- "ssh-ed25519 /);
    expect(instance!.userData).not.toMatch(/PRIVATE/);

    const hosts = await page.evaluate(() => window.electron.remoteHosts.list());
    const entry = hosts.find((h) => h.descriptor.name === HOST_NAME);
    expect(entry?.descriptor.connection.kind).toBe("cloud");
    run.hostId = entry!.descriptor.id;

    const close = setup.getByRole("button", { name: /^(Done|Close|Cancel)$/ }).first();
    if (await close.isVisible().catch(() => false)) await close.click();
    await page.evaluate((id) => window.electron.remoteHosts.connect({ hostId: id }), run.hostId);
    await expect.poll(() => linkStatus(page), { timeout: 60_000 }).toBe("connected");

    // The route names what EC2 reported, and pins the key the console printed: nobody was asked.
    expect((await cloudHost(page))?.hostKeyReview).toBeNull();
    const machines = path.join(run.shellUserData, "rh", "cloud", "machines");
    const [bindingDir] = await fs.readdir(machines);
    const sshConfig = await fs.readFile(path.join(machines, bindingDir!, "config"), "utf8");
    expect(sshConfig).toContain("HostName 203.0.113.20");
    expect(sshConfig).toContain("Port 22");
    expect(sshConfig).toContain("User ubuntu");
    expect(sshConfig).toContain("StrictHostKeyChecking yes");
    const knownHosts = await fs.readFile(path.join(machines, bindingDir!, "known_hosts"), "utf8");
    const hostKey = (await fs.readFile(path.join(run.root, "hostkey.pub"), "utf8"))
      .split(" ")
      .slice(0, 2)
      .join(" ");
    expect(knownHosts.trim()).toBe(`dtc-${bindingDir} ${hostKey}`);
    expect(run.ec2.calls("GetConsoleOutput").length).toBeGreaterThan(0);
    await shoot(page, "aws-host-connected");
  });

  test("3. the host menu stops the instance, saying only compute billing ends", async () => {
    const page = run.b.window;
    await closeSettings(page);
    await page.locator(SEL.remoteHosts.hostChip).click();
    await page.getByTestId("host-chip-cloud-machines").click();
    const stopItem = page.locator(`[data-cloud-machine-host-id="${run.hostId}"]`);
    await expect(stopItem).toContainText(`Stop ${HOST_NAME}`);
    await stopItem.click();
    const confirm = confirmDialog(page, `Stop '${HOST_NAME}'?`);
    await expect(confirm).toContainText("billing for its compute stops");
    await expect(confirm).toContainText("The disk is still billed for storage while it's stopped.");
    await shoot(page, "aws-stop-confirm");
    await confirm.getByRole("button", { name: "Stop machine" }).click();
    await expect
      .poll(async () => (await cloudHost(page))?.machine, { timeout: 60_000 })
      .toBe("stopped");
    expect(await linkStatus(page)).not.toBe("connected");
    const stops = run.ec2.calls("StopInstances");
    expect(stops).toHaveLength(1);
    expect(stops[0]!.region).toBe(MACHINE_REGION);
    expect(stops[0]!.params.Force).toBeUndefined();
  });

  test("4. starting it again reconnects, with the key it trusted", async () => {
    const page = run.b.window;
    await page.evaluate((id) => window.electron.cloudHosts.startHost({ hostId: id }), run.hostId);
    expect((await cloudHost(page))?.machine).toBe("running");
    expect(run.ec2.calls("StartInstances")).toHaveLength(1);
    await page.evaluate(
      (id) => window.electron.remoteHosts.connect({ hostId: id, restart: true }),
      run.hostId
    );
    await expect.poll(() => linkStatus(page), { timeout: 60_000 }).toBe("connected");
    expect((await cloudHost(page))?.hostKeyReview).toBeNull();
    await shoot(page, "aws-host-restarted");
  });

  test("5. removing the host can terminate its instance, after its name is typed", async () => {
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
    await expect(dialog).toContainText(`Remove '${HOST_NAME}'?`);
    await dialog.getByRole("radio", { name: "Delete the machine too" }).check();
    await dialog.getByLabel(`Type ${HOST_NAME} to confirm`).fill(HOST_NAME);
    expect(run.ec2.calls("TerminateInstances")).toHaveLength(0);
    await shoot(page, "aws-remove-delete");
    await dialog.getByRole("button", { name: "Delete machine" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    const terminations = run.ec2.calls("TerminateInstances");
    expect(terminations).toHaveLength(1);
    expect(terminations[0]!.region).toBe(MACHINE_REGION);
    const hosts = await page.evaluate(() => window.electron.remoteHosts.list());
    expect(hosts.find((h) => h.descriptor.id === run.hostId)).toBeUndefined();
  });
});
