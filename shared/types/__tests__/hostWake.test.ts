import { describe, expect, it } from "vitest";
import {
  isOnWakeLan,
  normalizeHostWake,
  parseWakeLan,
  parseWakeMac,
  readWakeLan,
  wakeLanBroadcast,
} from "../hostWake.js";

describe("parseWakeMac", () => {
  it.each([
    ["AA:BB:CC:DD:EE:F0", "aa:bb:cc:dd:ee:f0"],
    ["0a-1b-2c-3d-4e-5f", "0a:1b:2c:3d:4e:5f"],
    ["3c22.fb12.3456", "3c:22:fb:12:34:56"],
    [" 001122334455 ", "00:11:22:33:44:55"],
  ])("reads %s", (text, mac) => {
    expect(parseWakeMac(text)).toBe(mac);
  });

  it.each([
    ["mixed separators", "aa:bb-cc:dd:ee:f0"],
    ["too short", "aa:bb:cc:dd:ee"],
    ["not hex", "gg:bb:cc:dd:ee:f0"],
    ["all zero", "00:00:00:00:00:00"],
    ["broadcast", "ff:ff:ff:ff:ff:ff"],
    ["multicast", "01:00:5e:00:00:01"],
  ])("refuses %s", (_why, text) => {
    expect(parseWakeMac(text)).toBeNull();
  });
});

describe("the wake's LAN", () => {
  it("holds a CIDR to its network address", () => {
    expect(parseWakeLan("192.168.1.77/24")).toBe("192.168.1.0/24");
    expect(parseWakeLan("10.20.30.40/12")).toBe("10.16.0.0/12");
  });

  it("refuses what has no broadcast address or isn't IPv4", () => {
    for (const text of [
      "192.168.1.0/31",
      "192.168.1.0/32",
      "10.0.0.0/7",
      "192.168.1.0",
      "fe80::/64",
    ]) {
      expect(parseWakeLan(text)).toBeNull();
    }
    expect(parseWakeLan("192.168.256.0/24")).toBeNull();
  });

  it("broadcasts to the LAN's last address", () => {
    expect(wakeLanBroadcast(readWakeLan("192.168.1.0/24")!)).toBe("192.168.1.255");
    expect(wakeLanBroadcast(readWakeLan("172.16.4.0/22")!)).toBe("172.16.7.255");
  });

  it("counts an address as on the LAN only with the same prefix", () => {
    const lan = readWakeLan("192.168.1.0/24")!;
    expect(isOnWakeLan(lan, "192.168.1.20", "255.255.255.0")).toBe(true);
    expect(isOnWakeLan(lan, "192.168.2.20", "255.255.255.0")).toBe(false);
    // On a wider network, the LAN's broadcast address wouldn't be this machine's.
    expect(isOnWakeLan(lan, "192.168.1.20", "255.255.0.0")).toBe(false);
  });
});

describe("normalizeHostWake", () => {
  it("normalizes both parts together", () => {
    expect(normalizeHostWake({ mac: "AA-BB-CC-DD-EE-F0", lan: "192.168.1.9/24" })).toEqual({
      mac: "aa:bb:cc:dd:ee:f0",
      lan: "192.168.1.0/24",
    });
  });

  it("is none when either part isn't usable", () => {
    expect(normalizeHostWake({ mac: "aa:bb:cc:dd:ee:f0" })).toBeNull();
    expect(normalizeHostWake({ mac: "nope", lan: "192.168.1.0/24" })).toBeNull();
    expect(normalizeHostWake("aa:bb:cc:dd:ee:f0")).toBeNull();
    expect(normalizeHostWake(null)).toBeNull();
  });
});
