import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  formatSshEndpoint,
  hostKeyFingerprint,
  isSafeSshUser,
  normalizeHostKey,
  parseSshEndpoint,
} from "../sshEndpoint.js";

describe("parseSshEndpoint", () => {
  it.each([
    ["203.0.113.10", { host: "203.0.113.10", port: 22 }],
    ["203.0.113.10:22001", { host: "203.0.113.10", port: 22001 }],
    ["machine.on.boat.dev", { host: "machine.on.boat.dev", port: 22 }],
    ["machine.on.boat.dev:2222", { host: "machine.on.boat.dev", port: 2222 }],
    ["2001:db8::1", { host: "2001:db8::1", port: 22 }],
    ["[2001:db8::1]", { host: "2001:db8::1", port: 22 }],
    ["[2001:db8::1]:2200", { host: "2001:db8::1", port: 2200 }],
  ])("%s", (input, expected) => {
    expect(parseSshEndpoint(input)).toEqual(expected);
  });

  it.each([
    [null],
    [""],
    ["203.0.113.10:0"],
    ["203.0.113.10:65536"],
    ["203.0.113.10:22:1"],
    ["[2001:db8::1"],
    ["[not-ipv6]:22"],
    ["-oProxyCommand=evil"],
    ["host name"],
    ["host:port"],
  ])("refuses %s", (input) => {
    expect(parseSshEndpoint(input)).toBeNull();
  });

  it("formats IPv6 with brackets and leaves the default port off", () => {
    expect(formatSshEndpoint({ host: "2001:db8::1", port: 2200 })).toBe("[2001:db8::1]:2200");
    expect(formatSshEndpoint({ host: "203.0.113.10", port: 22 })).toBe("203.0.113.10");
  });
});

describe("normalizeHostKey", () => {
  const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

  it("drops the comment and keeps type and blob", () => {
    expect(normalizeHostKey(`${key} root@machine`)).toBe(key);
  });

  it("refuses anything that isn't a public key", () => {
    expect(normalizeHostKey("ssh-ed25519")).toBeNull();
    expect(normalizeHostKey("ssh-dss AAAAB3NzaC1kc3MAAACBAP")).toBeNull();
    expect(normalizeHostKey(`${key}\nevil-line`)).toBeNull();
  });

  it("fingerprints the key's own bytes, as ssh-keygen -l does", () => {
    const other =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBbGv0zLPUbyM1z6Bk3e2vFkZ9dQ8JxZ7l3q9e6cY0aB";
    const expected = `SHA256:${crypto
      .createHash("sha256")
      .update(Buffer.from(key.split(" ")[1], "base64"))
      .digest("base64")
      .replace(/=+$/, "")}`;
    expect(hostKeyFingerprint(key)).toBe(expected);
    expect(hostKeyFingerprint(other)).not.toBe(expected);
  });

  it("refuses a blob too short to be a key", () => {
    expect(normalizeHostKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5")).toBeNull();
  });
});

describe("isSafeSshUser", () => {
  it("accepts ordinary names and refuses option-shaped ones", () => {
    expect(isSafeSshUser("user")).toBe(true);
    expect(isSafeSshUser("-oProxyCommand")).toBe(false);
    expect(isSafeSshUser("a b")).toBe(false);
  });
});
