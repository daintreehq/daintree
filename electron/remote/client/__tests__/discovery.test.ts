import { describe, expect, it } from "vitest";
import type { CommandResult, CommandRunner } from "../commandRunner.js";
import {
  discoverHosts,
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
      },
      {
        name: "bigbox",
        sshTarget: "bigbox.tail1234.ts.net",
        source: "tailscale",
        platform: "linux",
        online: true,
      },
    ]);
  });

  it("drops offline peers and Windows, iOS and Android machines", () => {
    const names = parseTailscaleStatus(TAILSCALE_MAP).map((p) => p.name);
    expect(names).not.toContain("sleepy");
    expect(names).not.toContain("gaming-pc");
    expect(names).not.toContain("phone");
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
      },
      {
        name: "mac",
        sshTarget: "mac.example.ts.net",
        source: "tailscale",
        platform: "darwin",
        online: true,
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
      },
      { name: "bare", sshTarget: "bare.local", source: "bonjour", platform: null, online: true },
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

  it("reads the host and TXT record from a lookup", () => {
    const text = [
      "Lookup studio 03._daintree._tcp.local",
      "14:36:36.100  studio\\03203._daintree._tcp.local. can be reached at studio-03.local.:22 (interface 4) Flags: 1",
      " platform=darwin version=1.0.0",
    ].join("\n");
    expect(parseDnsSdLookup(text)).toEqual({
      host: "studio-03.local.",
      txt: { platform: "darwin", version: "1.0.0" },
    });
    expect(parseDnsSdLookup("nothing resolved")).toBeNull();
  });
});

describe("discoverHosts", () => {
  it("merges the tailnet and the LAN, preferring tailnet names, and marks hosts already added", async () => {
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
      knownTargets: ["greg@bigbox.tail1234.ts.net"],
    });
    expect(hosts.map((h) => [h.name, h.sshTarget, h.source, h.alreadyAdded])).toEqual([
      ["studio-03", "studio-03.tail1234.ts.net", "tailscale", false],
      ["bigbox", "bigbox.tail1234.ts.net", "tailscale", true],
      ["lanbox", "lanbox.local", "bonjour", false],
    ]);
    expect(calls.some((c) => c.startsWith("avahi-browse"))).toBe(false);
  });

  it("falls back to the macOS app's bundled CLI and survives every tool being absent", async () => {
    const tried: string[] = [];
    const run: CommandRunner = async (command) => {
      tried.push(command);
      return missing;
    };
    expect(await discoverHosts({ run, platform: "linux", knownTargets: [] })).toEqual([]);
    expect(tried).toContain("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    expect(tried).toContain("avahi-browse");
  });
});
