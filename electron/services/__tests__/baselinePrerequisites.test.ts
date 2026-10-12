import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import type { AgentInstallBlock } from "../../../shared/config/agentRegistry.js";
import type { PrerequisiteSpec } from "../../../shared/types/ipc.js";
import { buildBaselinePrerequisites, getBaselinePrerequisites } from "../baselinePrerequisites.js";
import { isBlockExecutable } from "../AgentInstallService.js";
import { resetLinuxDistroFamilyCache, type LinuxDistroFamily } from "../../utils/linuxDistro.js";

const FAMILIES: LinuxDistroFamily[] = ["debian", "fedora", "rhel", "arch", "suse"];

/** The package managers each family's hints may drive. */
const MANAGERS_FOR: Record<LinuxDistroFamily, string[]> = {
  debian: ["apt", "apt-get"],
  fedora: ["dnf"],
  rhel: ["dnf"],
  arch: ["pacman"],
  suse: ["zypper"],
};
const ALL_MANAGERS = ["apt", "apt-get", "dnf", "yum", "pacman", "zypper"];

function linuxBlocks(specs: PrerequisiteSpec[], tool: string): AgentInstallBlock[] {
  return specs.find((s) => s.tool === tool)?.installBlocks?.linux ?? [];
}

function managersIn(command: string): string[] {
  return command.split(/[\s&|;()]+/).filter((token) => ALL_MANAGERS.includes(token));
}

describe("buildBaselinePrerequisites", () => {
  it.each(FAMILIES)("installs git with %s's own package manager", (family) => {
    const [block] = linuxBlocks(buildBaselinePrerequisites(family), "git");
    const managers = managersIn(block?.commands?.[0] ?? "");

    expect(managers.length).toBeGreaterThan(0);
    for (const manager of managers) expect(MANAGERS_FOR[family]).toContain(manager);
  });

  it.each(FAMILIES)("never hands %s another family's package manager", (family) => {
    const specs = buildBaselinePrerequisites(family);
    const commands = specs.flatMap((spec) =>
      (spec.installBlocks?.linux ?? []).flatMap((block) => block.commands ?? [])
    );

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      for (const manager of managersIn(command)) expect(MANAGERS_FOR[family]).toContain(manager);
    }
  });

  it.each(FAMILIES)(
    "gives %s a Linux install hint for git, Node.js and the GitHub CLI",
    (family) => {
      const specs = buildBaselinePrerequisites(family);
      for (const tool of ["git", "node", "gh"]) {
        expect(linuxBlocks(specs, tool).some((block) => (block.commands?.length ?? 0) > 0)).toBe(
          true
        );
      }
    }
  );

  it("gives an unrecognised distro guidance with no command in it", () => {
    // A command for some other distro's package manager is a hint that cannot
    // run here; with none, the banner falls back to the install guide.
    const specs = buildBaselinePrerequisites(null);
    for (const tool of ["git", "node", "gh"]) {
      const blocks = linuxBlocks(specs, tool);
      expect(blocks.length).toBeGreaterThan(0);
      expect(
        blocks.every((block) => !block.commands?.length && (block.steps?.length ?? 0) > 0)
      ).toBe(true);
    }
    expect(specs.every((spec) => spec.installUrl)).toBe(true);
  });

  it("only overrides the generic npm hint where npm is packaged separately", () => {
    // NodeSource bundles npm, so apt and the enterprise line keep the generic
    // "included with Node.js" guidance; the others name the npm package.
    for (const family of [...FAMILIES, null]) {
      const npm = buildBaselinePrerequisites(family).find((s) => s.tool === "npm")!;
      expect(npm.installBlocks?.generic?.length).toBeGreaterThan(0);
      const separate = family === "fedora" || family === "arch" || family === "suse";
      expect(npm.installBlocks?.linux !== undefined).toBe(separate);
    }
  });

  it("keeps every Linux hint copy-paste only, since each needs sudo", () => {
    for (const family of [...FAMILIES, null]) {
      for (const spec of buildBaselinePrerequisites(family)) {
        for (const block of spec.installBlocks?.linux ?? []) {
          expect(isBlockExecutable(block)).toBe(false);
        }
      }
    }
  });

  it("leaves the macOS, Windows and generic hints the same on every distro", () => {
    const strip = (specs: PrerequisiteSpec[]) =>
      specs.map((spec) => {
        const { linux: _linux, ...rest } = spec.installBlocks ?? {};
        return { ...spec, installBlocks: rest };
      });
    const reference = strip(buildBaselinePrerequisites(null));
    for (const family of FAMILIES) {
      expect(strip(buildBaselinePrerequisites(family))).toEqual(reference);
    }
  });
});

describe("getBaselinePrerequisites", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    vi.restoreAllMocks();
    resetLinuxDistroFamilyCache();
  });

  function osRelease(content: string | null) {
    resetLinuxDistroFamilyCache();
    return vi.spyOn(fs, "readFileSync").mockImplementation(((filePath: fs.PathOrFileDescriptor) => {
      if (content !== null && filePath === "/etc/os-release") return content;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }) as typeof fs.readFileSync);
  }

  it("uses the running distro's hints on Linux", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    osRelease("ID=arch\n");

    expect(getBaselinePrerequisites()).toEqual(buildBaselinePrerequisites("arch"));
  });

  it("falls back to distro-neutral guidance when os-release is unreadable", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    osRelease(null);

    expect(getBaselinePrerequisites()).toEqual(buildBaselinePrerequisites(null));
  });

  it("does not read os-release off Linux", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const read = osRelease("ID=fedora\n");

    getBaselinePrerequisites();

    expect(read).not.toHaveBeenCalled();
  });
});
