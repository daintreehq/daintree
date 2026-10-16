import { describe, expect, it, vi } from "vitest";

// A bare system hostname that a remote `studio.local` must never be mistaken for.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, hostname: () => "studio" } };
});
import { sshConnection, sshTargetOf, wslConnection } from "../../../../shared/types/remoteHosts.js";
import type { CommandResult, CommandRunner } from "../commandRunner.js";
import {
  discoverHosts,
  discoverWslDistros,
  machineKey,
  parseAvahiBrowse,
  parseDnsSdBrowse,
  parseDnsSdLookup,
  parseTailscaleStatus,
} from "../discovery.js";

const ok = (stdout: string): CommandResult => ({
  code: 0,
  stdout,
  stderr: "",
  spawnError: null,
  timedOut: false,
});
const missing: CommandResult = {
  code: null,
  stdout: "",
  stderr: "",
  spawnError: "spawn ENOENT",
  timedOut: false,
};

const TAILSCALE_MAP = JSON.stringify({
  Version: "1.70.0",
  BackendState: "Running",
  Self: { HostName: "greg-mbp", DNSName: "greg-mbp.tail1234.ts.net.", OS: "macOS", Online: true },
  Peer: {
    "nodekey:a": {
      HostName: "studio-03",
      DNSName: "studio-03.tail1234.ts.net.",
      OS: "macOS",
      Online: true,
      TailscaleIPs: ["100.64.0.3"],
    },
    "nodekey:b": {
      HostName: "bigbox",
      DNSName: "bigbox.tail1234.ts.net.",
      OS: "linux",
      Online: true,
      TailscaleIPs: ["100.64.0.4"],
    },
    "nodekey:c": {
      HostName: "sleepy",
      DNSName: "sleepy.tail1234.ts.net.",
      OS: "linux",
      Online: false,
    },
    "nodekey:d": {
      HostName: "gaming-pc",
      DNSName: "gaming-pc.tail1234.ts.net.",
      OS: "windows",
      Online: true,
    },
    "nodekey:e": { HostName: "phone", DNSName: "phone.tail1234.ts.net.", OS: "iOS", Online: true },
  },
});

describe("parseTailscaleStatus", () => {
  it("keeps online macOS and Linux peers and never lists this machine", () => {
    const peers = parseTailscaleStatus(TAILSCALE_MAP);
    expect(peers).toEqual([
      {
        name: "studio-03",
        sshTarget: "studio-03.tail1234.ts.net",
        source: "tailscale",
        platform: "darwin",
        online: true,
        aliases: ["studio-03.tail1234.ts.net", "100.64.0.3"],
      },
      {
        name: "bigbox",
        sshTarget: "bigbox.tail1234.ts.net",
        source: "tailscale",
        platform: "linux",
        online: true,
        aliases: ["bigbox.tail1234.ts.net", "100.64.0.4"],
      },
    ]);
  });

  it("accepts the other shapes releases print: peer arrays, lower-case OS, no MagicDNS", () => {
    const text = JSON.stringify({
      Peer: [
        { HostName: "box", OS: "LINUX", Online: true, TailscaleIPs: ["100.64.0.9"] },
        { HostName: "mac", DNSName: "mac.example.ts.net", OS: "darwin", Online: true },
      ],
    });
    expect(parseTailscaleStatus(text)).toEqual([
      {
        name: "box",
        sshTarget: "100.64.0.9",
        source: "tailscale",
        platform: "linux",
        online: true,
        aliases: ["100.64.0.9"],
      },
      {
        name: "mac",
        sshTarget: "mac.example.ts.net",
        source: "tailscale",
        platform: "darwin",
        online: true,
        aliases: ["mac.example.ts.net"],
      },
    ]);
  });

  it("returns nothing for no peers, a null Peer or output that isn't JSON", () => {
    expect(parseTailscaleStatus(JSON.stringify({ Self: {}, Peer: null }))).toEqual([]);
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin" }))).toEqual([]);
    expect(parseTailscaleStatus("failed to connect to local tailscaled")).toEqual([]);
  });
});

describe("parseAvahiBrowse", () => {
  it("reads resolved lines, unescapes names and uses the TXT user and platform", () => {
    const text = [
      "+;eth0;IPv4;studio\\03203;_daintree._tcp;local",
      '=;eth0;IPv4;studio\\03203;_daintree._tcp;local;studio-03.local;192.168.1.5;22;"platform=linux" "user=greg" "version=1.0.0"',
      "=;eth0;IPv6;bare;_daintree._tcp;local;bare.local;fe80::1;22;",
    ].join("\n");
    expect(parseAvahiBrowse(text)).toEqual([
      {
        name: "studio 03",
        sshTarget: "greg@studio-03.local",
        source: "bonjour",
        platform: "linux",
        online: true,
        aliases: ["192.168.1.5"],
      },
      {
        name: "bare",
        sshTarget: "bare.local",
        source: "bonjour",
        platform: null,
        online: true,
        aliases: ["fe80::1"],
      },
    ]);
  });
});

describe("dns-sd parsing", () => {
  it("lists instances added and not removed since", () => {
    const text = [
      "Browsing for _daintree._tcp",
      "DATE: ---Fri 25 Sep 2026---",
      "14:36:35.926  ...STARTING...",
      "Timestamp     A/R    Flags  if Domain               Service Type         Instance Name",
      "14:36:36.001  Add        3   4 local.               _daintree._tcp.      studio 03",
      "14:36:36.002  Add        2   4 local.               _daintree._tcp.      gone",
      "14:36:37.000  Rmv        0   4 local.               _daintree._tcp.      gone",
    ].join("\r\n");
    expect(parseDnsSdBrowse(text)).toEqual([{ instance: "studio 03", domain: "local." }]);
  });

  it("reads lines whose hour is space-padded, as dns-sd prints them before 10:00", () => {
    const text = [
      "Browsing for _daintree._tcp",
      "DATE: ---Sun 11 Oct 2026---",
      " 7:37:59.921  ...STARTING...",
      "Timestamp     A/R    Flags  if Domain               Service Type         Instance Name",
      " 7:37:59.921  Add        3  18 local.               _daintree._tcp.      studio-01",
      " 7:37:59.921  Add        2  18 local.               _daintree._tcp.      studio-02",
    ].join("\n");
    expect(parseDnsSdBrowse(text)).toEqual([
      { instance: "studio-01", domain: "local." },
      { instance: "studio-02", domain: "local." },
    ]);
  });

  it("keeps only the service type it was asked for", () => {
    const text = [
      " 7:37:41.752  Add        3  18 local.               _ssh._tcp.           studio-04",
      " 7:37:41.752  Add        3  18 local.               _daintree._tcp.      studio-01",
    ].join("\n");
    expect(parseDnsSdBrowse(text, "_ssh._tcp")).toEqual([
      { instance: "studio-04", domain: "local." },
    ]);
  });

  it("reads the host and TXT record from a lookup", () => {
    const text = [
      "Lookup studio 03._daintree._tcp.local",
      "14:36:36.100  studio\\03203._daintree._tcp.local. can be reached at studio-03.local.:22 (interface 4) Flags: 1",
      " platform=darwin version=1.0.0",
    ].join("\n");
    expect(parseDnsSdLookup(text)).toEqual({
      host: "studio-03.local.",
      port: 22,
      txt: { platform: "darwin", version: "1.0.0" },
    });
    expect(parseDnsSdLookup("nothing resolved")).toBeNull();
  });
});

describe("discoverHosts", () => {
  it("lists the tailnet and the LAN, never merging machines by a shared first name label", async () => {
    const calls: string[] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "tailscale") return ok(TAILSCALE_MAP);
      if (command === "dns-sd" && args[0] === "-B") {
        return ok(
          [
            "14:36:36.001  Add        3   4 local.               _daintree._tcp.      studio-03",
            "14:36:36.001  Add        3   4 local.               _daintree._tcp.      lanbox",
          ].join("\n")
        );
      }
      if (command === "dns-sd" && args[0] === "-L") {
        return ok(
          `x ${args[1]}._daintree._tcp.local. can be reached at ${args[1]}.local.:22 (interface 4)\n platform=linux`
        );
      }
      return missing;
    };
    const hosts = await discoverHosts({
      run,
      platform: "darwin",
      knownConnections: [{ kind: "ssh", target: "greg@bigbox.tail1234.ts.net" }],
    });
    // studio-03.local may or may not be the tailnet's studio-03: nothing vouches for it.
    // greg's account on bigbox is added; the row names no account, so it warns rather than blocks.
    expect(
      hosts.map((h) => [
        h.name,
        sshTargetOf(h.connection),
        h.source,
        h.alreadyAdded,
        !!h.knownMachine,
      ])
    ).toEqual([
      ["studio-03", "studio-03.tail1234.ts.net", "tailscale", false, false],
      ["bigbox", "bigbox.tail1234.ts.net", "tailscale", false, true],
      ["studio-03", "studio-03.local", "bonjour", false, false],
      ["lanbox", "lanbox.local", "bonjour", false, false],
    ]);
    expect(calls.some((c) => c.startsWith("avahi-browse"))).toBe(false);
  });

  it("lists Remote Login machines, prefers the Daintree advert and never offers this machine", async () => {
    const browse: Record<string, string[]> = {
      "_daintree._tcp": ["studio-01", "this-mac"],
      "_ssh._tcp": ["studio-01", "studio-03", "this-mac"],
    };
    const run: CommandRunner = async (command, args) => {
      if (command !== "dns-sd") return missing;
      const type = args[0] === "-B" ? args[1]! : args[2]!;
      if (args[0] === "-B") {
        return ok(
          (browse[type] ?? [])
            .map(
              (name) => ` 7:37:41.752  Add        3  18 local.               ${type}.      ${name}`
            )
            .join("\n")
        );
      }
      const txt = type === "_daintree._tcp" ? "\n txtvers=1 platform=darwin" : "";
      return ok(
        ` 7:38:01.926  ${args[1]}.${type}.local. can be reached at ${args[1]}.local.:22 (interface 18)${txt}`
      );
    };
    const hosts = await discoverHosts({
      run,
      platform: "darwin",
      knownConnections: [],
      localHostNames: ["this-mac.local"],
    });
    expect(hosts.map((h) => [sshTargetOf(h.connection), h.platform])).toEqual([
      ["studio-01.local", "darwin"],
      ["studio-03.local", null],
    ]);
  });

  it("skips adverts on another ssh port, which a bare target can't reach", async () => {
    const run: CommandRunner = async (command, args) => {
      if (command !== "dns-sd") return missing;
      if (args[0] === "-B") {
        return ok(
          args[1] === "_ssh._tcp"
            ? [
                " 7:37:41.752  Add        3  18 local.               _ssh._tcp.           odd-port",
                " 7:37:41.752  Add        3  18 local.               _ssh._tcp.           plain",
              ].join("\n")
            : ""
        );
      }
      const port = args[1] === "odd-port" ? 2222 : 22;
      return ok(
        ` 7:38:01.926  ${args[1]}._ssh._tcp.local. can be reached at ${args[1]}.local.:${port} (interface 18)`
      );
    };
    const hosts = await discoverHosts({
      run,
      platform: "darwin",
      knownConnections: [],
      localHostNames: [],
    });
    expect(hosts.map((h) => sshTargetOf(h.connection))).toEqual(["plain.local"]);
    expect(
      parseAvahiBrowse("=;eth0;IPv4;box;_ssh._tcp;local;box.local;192.168.1.9;2222;").map(
        (c) => c.sshTarget
      )
    ).toEqual([]);
  });

  it("hides this Mac by its Bonjour name, never a remote machine sharing its system hostname", async () => {
    const run: CommandRunner = async (command, args) => {
      if (command === "scutil") return ok("laptop\n");
      if (command !== "dns-sd") return missing;
      if (args[0] === "-B") {
        return ok(
          args[1] === "_ssh._tcp"
            ? [
                " 7:37:41.752  Add        3  18 local.               _ssh._tcp.           laptop",
                " 7:37:41.752  Add        3  18 local.               _ssh._tcp.           studio",
              ].join("\n")
            : ""
        );
      }
      return ok(
        ` 7:38:01.926  ${args[1]}._ssh._tcp.local. can be reached at ${args[1]}.local.:22 (interface 18)`
      );
    };
    const hosts = await discoverHosts({ run, platform: "darwin", knownConnections: [] });
    const targets = hosts.map((h) => sshTargetOf(h.connection));
    expect(targets).not.toContain("laptop.local");
    expect(targets).toContain("studio.local");
  });

  it("keeps whole IP addresses apart and matches known hosts by an address the tailnet vouches for", async () => {
    const status = JSON.stringify({
      Peer: [
        { HostName: "a", OS: "linux", Online: true, TailscaleIPs: ["100.64.0.3"] },
        { HostName: "b", OS: "linux", Online: true, TailscaleIPs: ["100.64.0.9"] },
        {
          HostName: "c",
          DNSName: "c.tail1234.ts.net.",
          OS: "linux",
          Online: true,
          TailscaleIPs: ["100.64.0.12"],
        },
      ],
    });
    const run: CommandRunner = async (command) => (command === "tailscale" ? ok(status) : missing);
    const hosts = await discoverHosts({
      run,
      platform: "linux",
      knownConnections: [
        { kind: "ssh", target: "greg@100.64.0.3" },
        { kind: "ssh", target: "greg@100.64.0.12" },
      ],
    });
    expect(hosts.map((h) => [sshTargetOf(h.connection), h.alreadyAdded, !!h.knownMachine])).toEqual(
      [
        ["100.64.0.3", false, true],
        ["100.64.0.9", false, false],
        ["c.tail1234.ts.net", false, true],
      ]
    );
    expect(machineKey("greg@100.64.0.3")).toBe("100.64.0.3");
    expect(machineKey("Studio.Local.")).toBe("studio.local");
  });

  it("marks only the exact account added, matching the host part case-insensitively", async () => {
    const status = JSON.stringify({
      Peer: [{ HostName: "a", OS: "linux", Online: true, TailscaleIPs: ["100.64.0.3"] }],
    });
    const run: CommandRunner = async (command) => (command === "tailscale" ? ok(status) : missing);
    const added = await discoverHosts({
      run,
      platform: "linux",
      knownConnections: [{ kind: "ssh", target: "100.64.0.3" }],
    });
    expect(added.map((h) => [h.alreadyAdded, !!h.knownMachine])).toEqual([[true, true]]);
  });

  it("merges a LAN advert with a tailnet peer only on a shared address", async () => {
    const status = JSON.stringify({
      Peer: [
        {
          HostName: "box",
          DNSName: "box.ts.net.",
          OS: "linux",
          Online: true,
          TailscaleIPs: ["100.64.0.4"],
        },
      ],
    });
    const avahiArgs: Array<readonly string[]> = [];
    const run: CommandRunner = async (command, args) => {
      if (command === "tailscale") return ok(status);
      if (command === "avahi-browse") {
        avahiArgs.push(args);
        return ok(
          [
            '=;eth0;IPv4;box;_daintree._tcp;local;box.local;100.64.0.4;22;"platform=linux"',
            '=;eth0;IPv4;box;_daintree._tcp;local;box-2.local;192.168.1.9;22;"platform=linux"',
          ].join("\n")
        );
      }
      return missing;
    };
    const hosts = await discoverHosts({ run, platform: "linux", knownConnections: [] });
    expect(hosts.map((h) => sshTargetOf(h.connection))).toEqual(["box.ts.net", "box-2.local"]);
    // avahi leaves out this machine's own services itself.
    expect(avahiArgs.every((args) => args[0] === "-rptl")).toBe(true);
  });

  it("falls back to the macOS app's bundled CLI and survives every tool being absent", async () => {
    const tried: string[] = [];
    const run: CommandRunner = async (command) => {
      tried.push(command);
      return missing;
    };
    expect(await discoverHosts({ run, platform: "linux", knownConnections: [] })).toEqual([]);
    expect(tried).toContain("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    expect(tried).toContain("avahi-browse");
  });
});

describe("discoverWslDistros", () => {
  const listed = [
    { name: "FedoraLinux-44", isDefault: false, version: 2, state: "Stopped" },
    { name: "docker-desktop", isDefault: false, version: 2, state: "Running" },
    { name: "Legacy", isDefault: false, version: 1, state: "Stopped" },
    { name: "Ubuntu-24.04", isDefault: true, version: 2, state: "Stopped" },
  ];

  it("lists this PC's distros as WSL hosts, the default first, without Docker Desktop's", async () => {
    const hosts = await discoverWslDistros({
      knownConnections: [wslConnection("fedoralinux-44"), sshConnection("FedoraLinux-44")],
      list: async () => listed,
    });
    expect(
      hosts.map((h) => [h.name, h.connection, h.source, h.platform, h.alreadyAdded, h.wsl])
    ).toEqual([
      [
        "Ubuntu-24.04",
        wslConnection("Ubuntu-24.04"),
        "wsl",
        "linux",
        false,
        { version: 2, isDefault: true },
      ],
      [
        "FedoraLinux-44",
        wslConnection("FedoraLinux-44"),
        "wsl",
        "linux",
        true,
        { version: 2, isDefault: false },
      ],
      ["Legacy", wslConnection("Legacy"), "wsl", "linux", false, { version: 1, isDefault: false }],
    ]);
  });

  it("is empty when WSL is missing, has no distros, or the listing fails", async () => {
    expect(await discoverWslDistros({ knownConnections: [], list: async () => null })).toEqual([]);
    expect(await discoverWslDistros({ knownConnections: [], list: async () => [] })).toEqual([]);
    expect(
      await discoverWslDistros({
        knownConnections: [],
        list: () => Promise.reject(new Error("boom")),
      })
    ).toEqual([]);
  });
});
