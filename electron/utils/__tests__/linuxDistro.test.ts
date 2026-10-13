import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import {
  classifyLinuxDistro,
  getLinuxDistroFamily,
  parseOsRelease,
  readLinuxDistroFamily,
  resetLinuxDistroFamilyCache,
  type LinuxDistroFamily,
} from "../linuxDistro.js";

// Trimmed from the os-release files these systems ship.
const OS_RELEASE: Record<string, string> = {
  fedora41: [
    'NAME="Fedora Linux"',
    'VERSION="41 (Container Image)"',
    "ID=fedora",
    "VERSION_ID=41",
    'PRETTY_NAME="Fedora Linux 41 (Container Image)"',
  ].join("\n"),
  arch: ['NAME="Arch Linux"', 'PRETTY_NAME="Arch Linux"', "ID=arch", "BUILD_ID=rolling"].join("\n"),
  debian12: ['PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"', 'VERSION_ID="12"', "ID=debian"].join(
    "\n"
  ),
  ubuntu2204: ['NAME="Ubuntu"', 'VERSION_ID="22.04"', "ID=ubuntu", "ID_LIKE=debian"].join("\n"),
  mint: ['NAME="Linux Mint"', "ID=linuxmint", 'ID_LIKE="ubuntu debian"'].join("\n"),
  rocky9: ['NAME="Rocky Linux"', 'ID="rocky"', 'ID_LIKE="rhel centos fedora"'].join("\n"),
  centosStream9: ['NAME="CentOS Stream"', 'ID="centos"', 'ID_LIKE="rhel fedora"'].join("\n"),
  rhel9: ['NAME="Red Hat Enterprise Linux"', 'ID="rhel"', 'ID_LIKE="fedora"'].join("\n"),
  oracle9: ['NAME="Oracle Linux Server"', 'ID="ol"', 'ID_LIKE="fedora"'].join("\n"),
  amazon2023: ['NAME="Amazon Linux"', 'ID="amzn"', 'ID_LIKE="fedora"'].join("\n"),
  manjaro: ['NAME="Manjaro Linux"', "ID=manjaro", "ID_LIKE=arch"].join("\n"),
  tumbleweed: [
    'NAME="openSUSE Tumbleweed"',
    'ID="opensuse-tumbleweed"',
    'ID_LIKE="opensuse suse"',
  ].join("\n"),
  leap: ['NAME="openSUSE Leap"', 'ID="opensuse-leap"', 'ID_LIKE="suse opensuse"'].join("\n"),
  sles: ['NAME="SLES"', 'ID="sles"', 'ID_LIKE="suse"'].join("\n"),
  alpine: ['NAME="Alpine Linux"', "ID=alpine", "VERSION_ID=3.20.0"].join("\n"),
  nixos: ["NAME=NixOS", "ID=nixos"].join("\n"),
};

describe("parseOsRelease", () => {
  it("reads unquoted, double-quoted and single-quoted values", () => {
    expect(parseOsRelease("ID=fedora\nNAME=\"Fedora Linux\"\nVARIANT='Container Image'")).toEqual({
      ID: "fedora",
      NAME: "Fedora Linux",
      VARIANT: "Container Image",
    });
  });

  it("unescapes the characters os-release allows inside double quotes", () => {
    expect(parseOsRelease('PRETTY_NAME="say \\"hi\\" \\$HOME \\\\ \\`x\\`"').PRETTY_NAME).toBe(
      'say "hi" $HOME \\ `x`'
    );
  });

  it("skips comments, blank and malformed lines, and tolerates CRLF", () => {
    expect(parseOsRelease("# comment\r\n\r\nnot a field\r\nID=arch\r\n  \r\n")).toEqual({
      ID: "arch",
    });
  });
});

describe("classifyLinuxDistro", () => {
  const expected: Array<[keyof typeof OS_RELEASE, LinuxDistroFamily | null]> = [
    ["fedora41", "fedora"],
    ["arch", "arch"],
    ["debian12", "debian"],
    ["ubuntu2204", "debian"],
    ["mint", "debian"],
    ["rocky9", "rhel"],
    ["centosStream9", "rhel"],
    ["rhel9", "rhel"],
    ["oracle9", "rhel"],
    ["amazon2023", "rhel"],
    ["manjaro", "arch"],
    ["tumbleweed", "suse"],
    ["leap", "suse"],
    ["sles", "suse"],
    ["alpine", null],
    ["nixos", null],
  ];

  it.each(expected)("classifies %s as %s", (fixture, family) => {
    expect(classifyLinuxDistro(parseOsRelease(OS_RELEASE[fixture]))).toBe(family);
  });

  it("never resolves an ID or ID_LIKE to an inherited object property", () => {
    expect(classifyLinuxDistro({ ID: "constructor" })).toBeNull();
    expect(classifyLinuxDistro({ ID: "toString", ID_LIKE: "__proto__ hasOwnProperty" })).toBeNull();
  });

  it("lets ID win over ID_LIKE", () => {
    // An enterprise rebuild that only claims `fedora` must not get Fedora's DNF5 commands.
    expect(classifyLinuxDistro({ ID: "ol", ID_LIKE: "fedora" })).toBe("rhel");
  });

  it("takes the first recognised ID_LIKE token, closest relative first", () => {
    expect(classifyLinuxDistro({ ID: "example", ID_LIKE: "rhel centos fedora" })).toBe("rhel");
    expect(classifyLinuxDistro({ ID: "example", ID_LIKE: "fedora" })).toBe("fedora");
    expect(classifyLinuxDistro({ ID: "example", ID_LIKE: "somethingelse arch" })).toBe("arch");
  });

  it("is case-insensitive and treats missing fields as unknown", () => {
    expect(classifyLinuxDistro({ ID: "Fedora" })).toBe("fedora");
    expect(classifyLinuxDistro({})).toBeNull();
    expect(classifyLinuxDistro({ ID: "", ID_LIKE: "  " })).toBeNull();
  });
});

describe("readLinuxDistroFamily", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetLinuxDistroFamilyCache();
  });

  function reader(files: Record<string, string>) {
    return vi.fn((filePath: string) => {
      const content = files[filePath];
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
      }
      return content;
    });
  }

  it("prefers /etc/os-release", () => {
    const read = reader({
      "/etc/os-release": OS_RELEASE.fedora41,
      "/usr/lib/os-release": OS_RELEASE.arch,
    });
    expect(readLinuxDistroFamily(read)).toBe("fedora");
  });

  it("falls back to /usr/lib/os-release when /etc has none", () => {
    expect(readLinuxDistroFamily(reader({ "/usr/lib/os-release": OS_RELEASE.arch }))).toBe("arch");
  });

  it("fails soft to unknown when neither file can be read", () => {
    expect(readLinuxDistroFamily(reader({}))).toBeNull();
  });

  it("reads the file once per process", () => {
    resetLinuxDistroFamilyCache();
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(((
      filePath: fs.PathOrFileDescriptor
    ) => {
      if (filePath === "/etc/os-release") return OS_RELEASE.tumbleweed;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }) as typeof fs.readFileSync);

    expect(getLinuxDistroFamily()).toBe("suse");
    expect(getLinuxDistroFamily()).toBe("suse");
    expect(read).toHaveBeenCalledTimes(1);
  });
});
