import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLinuxPackageUpdater, runLinuxPackageInstall } from "../linuxPackageUpdateInstall.js";

// Shaped like electron-updater's DebUpdater: methods on the prototype, and a
// doInstall that retries `apt-get install -f` after any failed `dpkg -i`.
class FakeDebUpdater {
  readonly commands: string[][] = [];
  constructor(private readonly exitCodes: number[]) {}

  runCommandWithSudoIfNeeded(commandWithArgs: string[]): string {
    this.commands.push(commandWithArgs);
    const code = this.exitCodes.shift() ?? 0;
    if (code !== 0) throw new Error(`Command pkexec exited with code ${code}`);
    return "";
  }

  doInstall(_options: unknown): boolean {
    const run = this.runCommandWithSudoIfNeeded.bind(this);
    try {
      try {
        run(["dpkg", "-i", "/cache/daintree.deb"]);
      } catch {
        run(["apt-get", "install", "-f", "-y"]);
      }
    } catch {
      return false;
    }
    return true;
  }

  quitAndInstall(): void {
    this.doInstall({ isForceRunAfter: true });
  }
}

describe("runLinuxPackageInstall", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("reports an install whose package went in", () => {
    const updater = new FakeDebUpdater([0]);
    expect(runLinuxPackageInstall(updater, () => updater.quitAndInstall())).toBe("installed");
    expect(updater.commands).toEqual([["dpkg", "-i", "/cache/daintree.deb"]]);
  });

  it.each([
    [126, "the password dialog was dismissed"],
    [127, "no authentication agent answered"],
  ])("runs no second privileged command after pkexec exits %i (%s)", (code) => {
    const updater = new FakeDebUpdater([code, 0]);
    expect(runLinuxPackageInstall(updater, () => updater.quitAndInstall())).toBe("failed");
    expect(updater.commands).toEqual([["dpkg", "-i", "/cache/daintree.deb"]]);
  });

  it("keeps the updater's own retry for a dpkg failure that was not a refused prompt", () => {
    const updater = new FakeDebUpdater([1, 0]);
    expect(runLinuxPackageInstall(updater, () => updater.quitAndInstall())).toBe("installed");
    expect(updater.commands).toEqual([
      ["dpkg", "-i", "/cache/daintree.deb"],
      ["apt-get", "install", "-f", "-y"],
    ]);
  });

  it("leaves the updater's own methods in place afterwards, even when install throws", () => {
    const updater = new FakeDebUpdater([0]);
    expect(() =>
      runLinuxPackageInstall(updater, () => {
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(Object.hasOwn(updater, "runCommandWithSudoIfNeeded")).toBe(false);
    expect(Object.hasOwn(updater, "doInstall")).toBe(false);

    runLinuxPackageInstall(updater, () => updater.quitAndInstall());
    expect(Object.hasOwn(updater, "runCommandWithSudoIfNeeded")).toBe(false);
    expect(Object.hasOwn(updater, "doInstall")).toBe(false);
  });

  it("runs any other updater untouched and reports nothing", () => {
    let ran = false;
    const appImageUpdater = { doInstall: () => true };
    expect(runLinuxPackageInstall(appImageUpdater, () => (ran = true))).toBeNull();
    expect(ran).toBe(true);
    expect(isLinuxPackageUpdater(appImageUpdater)).toBe(false);
  });

  it("treats no updater as a Linux package updater off Linux", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    expect(isLinuxPackageUpdater(new FakeDebUpdater([]))).toBe(false);
  });
});
