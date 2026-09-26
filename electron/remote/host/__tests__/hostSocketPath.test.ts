import { describe, expect, it } from "vitest";
import {
  SocketPathTooLongError,
  assertSocketPathFits,
  hostSocketLocation,
  remoteHostSocketLocation,
} from "../hostSocketPath.js";
import { parseDiscoveryInfo, tokensEqual } from "../discoveryFile.js";

describe("host socket location", () => {
  it("uses userData on macOS and the uid's runtime dir on Linux", () => {
    expect(
      hostSocketLocation({
        platform: "darwin",
        userDataDir: "/Users/g/Library/Application Support/Daintree",
      })
    ).toEqual({
      dir: "/Users/g/Library/Application Support/Daintree",
      socketPath: "/Users/g/Library/Application Support/Daintree/host.sock",
      discoveryPath: "/Users/g/Library/Application Support/Daintree/host.json",
    });
    expect(hostSocketLocation({ platform: "linux", uid: 1000 })).toEqual({
      dir: "/run/user/1000/daintree",
      socketPath: "/run/user/1000/daintree/host.sock",
      discoveryPath: "/run/user/1000/daintree/host.json",
    });
  });

  it("derives the same paths from a remote probe", () => {
    expect(
      remoteHostSocketLocation({ platform: "darwin", uid: 501, home: "/Users/greg" }).discoveryPath
    ).toBe("/Users/greg/Library/Application Support/Daintree/host.json");
    expect(
      remoteHostSocketLocation({ platform: "linux", uid: 1001, home: "/home/greg" }).socketPath
    ).toBe("/run/user/1001/daintree/host.sock");
  });

  it("enforces the sun_path limit per platform", () => {
    expect(() => assertSocketPathFits(`/${"a".repeat(102)}`, "darwin")).not.toThrow();
    expect(() => assertSocketPathFits(`/${"a".repeat(103)}`, "darwin")).toThrow(
      SocketPathTooLongError
    );
    expect(() => assertSocketPathFits(`/${"a".repeat(106)}`, "linux")).not.toThrow();
    expect(() => assertSocketPathFits(`/${"a".repeat(107)}`, "linux")).toThrow(
      SocketPathTooLongError
    );
  });
});

describe("discovery file parsing", () => {
  const good = {
    version: 1,
    socketPath: "/run/user/1/daintree/host.sock",
    token: "a".repeat(64),
    pid: 9,
  };

  it("accepts a well-formed file and rejects anything else", () => {
    expect(parseDiscoveryInfo(JSON.stringify(good))).toEqual(good);
    expect(parseDiscoveryInfo("not json")).toBeNull();
    expect(parseDiscoveryInfo(JSON.stringify({ ...good, token: "short" }))).toBeNull();
    expect(parseDiscoveryInfo(JSON.stringify({ ...good, version: 2 }))).toBeNull();
    expect(parseDiscoveryInfo(" ".repeat(20_000))).toBeNull();
  });

  it("compares tokens without accepting empty or different-length values", () => {
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abd", "abc")).toBe(false);
    expect(tokensEqual("ab", "abc")).toBe(false);
    expect(tokensEqual("", "")).toBe(false);
  });
});
