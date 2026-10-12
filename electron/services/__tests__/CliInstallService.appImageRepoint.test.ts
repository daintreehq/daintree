import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ dir: "" }));

vi.mock("electron", () => ({
  app: { isPackaged: true, getAppPath: () => "/repo" },
}));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const homedir = () => home.dir;
  return { ...actual, default: { ...actual, homedir }, homedir };
});

const originalPlatform = process.platform;

// Real files in a temp HOME and XDG_DATA_HOME. The service's own install() is
// never called here: it tries /usr/local/bin first, which is writable on some
// machines and must not be touched by a test.
describe("CliInstallService — following a moved AppImage", () => {
  let root: string;
  let wrapperPath: string;
  let localBin: string;

  async function load() {
    vi.resetModules();
    return import("../CliInstallService.js");
  }

  /** What install() leaves behind for an AppImage: the wrapper, linked from ~/.local/bin. */
  async function installedFor(image: string, how: "link" | "copy" = "link") {
    const service = await load();
    fs.writeFileSync(image, "old image");
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.writeFileSync(wrapperPath, service.generateAppImageWrapper(image), { mode: 0o755 });
    fs.mkdirSync(path.dirname(localBin), { recursive: true });
    if (how === "link") fs.symlinkSync(wrapperPath, localBin);
    else fs.copyFileSync(wrapperPath, localBin);
    return service;
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-cli-repoint-")));
    home.dir = path.join(root, "home");
    fs.mkdirSync(home.dir, { recursive: true });
    process.env.XDG_DATA_HOME = path.join(root, "data");
    wrapperPath = path.join(root, "data", "daintree", "daintree-cli.sh");
    localBin = path.join(home.dir, ".local", "bin", "daintree");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    delete process.env.XDG_DATA_HOME;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("points the daintree command at the renamed image once the old one is gone", async () => {
    const oldImage = path.join(root, "Daintree-1.2.0.AppImage");
    const newImage = path.join(root, "Daintree-1.3.0.AppImage");
    const service = await installedFor(oldImage);
    // What electron-updater does on install: delete the old image, move the new one in.
    fs.rmSync(oldImage);
    fs.writeFileSync(newImage, "new image");

    expect(service.repointAppImageWrapper(newImage)).toBe(true);

    const wrapper = fs.readFileSync(wrapperPath, "utf8");
    expect(service.appImageOfWrapper(wrapper)).toBe(newImage);
    expect(wrapper).not.toContain(oldImage);
    expect(fs.statSync(wrapperPath).mode & 0o777).toBe(0o755);
    // The installed command is a link to the wrapper, so it follows too.
    expect(fs.lstatSync(localBin).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(localBin)).toBe(wrapperPath);
  });

  it("leaves a wrapper that names another image which still exists", async () => {
    const stable = path.join(root, "Daintree-1.2.0.AppImage");
    const other = path.join(root, "Daintree-nightly.AppImage");
    const service = await installedFor(stable);
    fs.writeFileSync(other, "another install");
    const before = fs.readFileSync(wrapperPath, "utf8");

    expect(service.repointAppImageWrapper(other)).toBe(false);
    expect(fs.readFileSync(wrapperPath, "utf8")).toBe(before);
  });

  it("leaves a wrapper whose image is missing from somewhere the updater never renames to", async () => {
    const service = await load();
    const elsewhere = path.join(root, "usb", "Daintree-1.2.0.AppImage");
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.writeFileSync(wrapperPath, service.generateAppImageWrapper(elsewhere));
    const before = fs.readFileSync(wrapperPath, "utf8");

    // A drive that isn't mounted looks like a deleted image; only a rename in
    // the image's own folder is the updater's.
    expect(service.repointAppImageWrapper(path.join(root, "Daintree-1.3.0.AppImage"))).toBe(false);
    expect(fs.readFileSync(wrapperPath, "utf8")).toBe(before);
  });

  it("follows a rename from a wrapper an older build wrote", async () => {
    const oldImage = path.join(root, "Daintree-1.2.0.AppImage");
    const newImage = path.join(root, "Daintree-1.3.0.AppImage");
    const service = await installedFor(oldImage);
    // Before #11410 the wrapper passed --cli-path and its value as two words.
    fs.writeFileSync(
      wrapperPath,
      fs
        .readFileSync(wrapperPath, "utf8")
        .replace('--cli-path="$ABSOLUTE_PATH"', '--cli-path "$ABSOLUTE_PATH"')
    );
    fs.rmSync(oldImage);

    expect(service.repointAppImageWrapper(newImage)).toBe(true);
    expect(fs.readFileSync(wrapperPath, "utf8")).toBe(service.generateAppImageWrapper(newImage));
  });

  it("creates nothing when the CLI was never installed", async () => {
    const service = await load();

    expect(service.repointAppImageWrapper(path.join(root, "Daintree-1.3.0.AppImage"))).toBe(false);
    expect(fs.existsSync(wrapperPath)).toBe(false);
  });

  it("never rewrites a file at the wrapper path that Daintree didn't write", async () => {
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.writeFileSync(wrapperPath, "#!/bin/sh\nexec '/somewhere/else' \"$@\"\n");
    const service = await load();

    expect(service.repointAppImageWrapper(path.join(root, "Daintree-1.3.0.AppImage"))).toBe(false);
    expect(fs.readFileSync(wrapperPath, "utf8")).toContain("/somewhere/else");
  });

  it("refreshes an install that had to copy the wrapper instead of linking it", async () => {
    const oldImage = path.join(root, "Daintree-1.2.0.AppImage");
    const newImage = path.join(root, "Daintree-1.3.0.AppImage");
    const service = await installedFor(oldImage, "copy");
    fs.rmSync(oldImage);

    expect(service.repointAppImageWrapper(newImage)).toBe(true);

    expect(fs.lstatSync(localBin).isSymbolicLink()).toBe(false);
    expect(service.appImageOfWrapper(fs.readFileSync(localBin, "utf8"))).toBe(newImage);
  });

  // `daintree --version` on an AppImage install read "--version" as a directory.
  it("answers the CLI flags like the packaged script, with the version written in", async () => {
    const service = await load();
    const wrapper = path.join(root, "daintree-cli.sh");
    fs.writeFileSync(
      wrapper,
      service.generateAppImageWrapper("/nonexistent/Daintree.AppImage", "1.2.3"),
      {
        mode: 0o755,
      }
    );
    const run = (...args: string[]) => spawnSync("bash", [wrapper, ...args], { encoding: "utf8" });

    expect(run("--version").stdout.trim()).toBe("daintree 1.2.3");
    expect(run("-v").stdout.trim()).toBe("daintree 1.2.3");
    expect(run("--help").stdout).toContain("Usage: daintree [directory]");
    const status = run("--status");
    expect(["Daintree is running", "Daintree is not running"]).toContain(status.stdout.trim());
    const notDir = run(path.join(root, "missing"));
    expect(notDir.status).toBe(1);
    expect(notDir.stderr).toContain("is not a directory");
  });

  it.runIf(process.platform === "linux")(
    "answers --status from the app's own binary, not a shell naming the wrapper",
    async () => {
      const service = await load();
      const wrapper = path.join(root, "bin", "daintree");
      fs.mkdirSync(path.dirname(wrapper), { recursive: true });
      fs.writeFileSync(
        wrapper,
        service.generateAppImageWrapper("/nonexistent/x.AppImage", "1.2.3"),
        {
          mode: 0o755,
        }
      );
      const realRunning = spawnSync(
        "bash",
        ["-c", 'for p in $(pgrep -x daintree); do readlink "/proc/$p/exe"; done'],
        { encoding: "utf8" }
      ).stdout.includes("/daintree");
      if (!realRunning) {
        const viaShell = spawnSync("bash", ["-c", `${wrapper} --status; :`], { encoding: "utf8" });
        expect(viaShell.stdout.trim()).toBe("Daintree is not running");
      }
      const binary = path.join(root, "app", "daintree");
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      const sleeper = spawnSync("bash", ["-c", "command -v sleep"], {
        encoding: "utf8",
      }).stdout.trim();
      fs.copyFileSync(sleeper, binary);
      fs.chmodSync(binary, 0o755);
      const { spawn } = await import("node:child_process");
      const app = spawn(binary, ["30"], { stdio: "ignore" });
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(spawnSync("bash", [wrapper, "--status"], { encoding: "utf8" }).stdout.trim()).toBe(
          "Daintree is running"
        );
      } finally {
        app.kill("SIGKILL");
      }
    }
  );

  // An update installed on quit repoints the wrapper before the new version
  // has ever run, so the version comes from the update, not this process.
  it("writes the update's version when repointing during an install", async () => {
    const oldImage = path.join(root, "Daintree-1.2.0.AppImage");
    const newImage = path.join(root, "Daintree-1.3.0.AppImage");
    const service = await installedFor(oldImage);
    fs.rmSync(oldImage);
    fs.writeFileSync(newImage, "new image");

    expect(service.repointAppImageWrapper(newImage, "1.3.0")).toBe(true);
    expect(fs.readFileSync(wrapperPath, "utf8")).toContain('echo "daintree 1.3.0"');
  });

  it("keeps its launch line readable after the flags were added", async () => {
    const service = await load();
    const image = path.join(root, "Daintree-1.2.0.AppImage");
    expect(service.appImageOfWrapper(service.generateAppImageWrapper(image, "1.2.0"))).toBe(image);
  });

  it("reads back a path the wrapper had to shell-escape", async () => {
    const service = await load();
    const image = path.join(root, "it's a 'quoted' Daintree-1.2.0.AppImage");

    expect(service.appImageOfWrapper(service.generateAppImageWrapper(image))).toBe(image);
  });
});
