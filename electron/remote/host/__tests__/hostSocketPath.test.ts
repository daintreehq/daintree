import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SocketPathTooLongError,
  assertSocketPathFits,
  hostSocketLocation,
  remoteHostSocketLocation,
  startsOnConnectForInit,
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

  it("keeps a Linux host with no init system under the home's cache, where its record lasts", () => {
    expect(
      hostSocketLocation({
        platform: "linux",
        uid: 1000,
        home: "/home/node",
        startsOnConnect: true,
      })
    ).toEqual({
      dir: "/home/node/.cache/daintree/run",
      socketPath: "/home/node/.cache/daintree/run/host.sock",
      discoveryPath: "/home/node/.cache/daintree/run/host.json",
    });
    expect(
      hostSocketLocation({
        platform: "linux",
        uid: 1000,
        home: "/home/node",
        dirName: "daintree-dev",
        startsOnConnect: true,
      }).dir
    ).toBe("/home/node/.cache/daintree-dev/run");
    // Told it starts on connect without a home, it keeps the runtime directory.
    expect(hostSocketLocation({ platform: "linux", uid: 1000, startsOnConnect: true }).dir).toBe(
      "/run/user/1000/daintree"
    );
    expect(
      remoteHostSocketLocation({
        platform: "linux",
        uid: 1000,
        home: "/home/node",
        startsOnConnect: true,
      }).discoveryPath
    ).toBe("/home/node/.cache/daintree/run/host.json");
  });

  it("starts on connect only where PID 1 was read and isn't systemd", () => {
    expect(startsOnConnectForInit("systemd\n")).toBe(false);
    expect(startsOnConnectForInit("docker-init\n")).toBe(true);
    expect(startsOnConnectForInit("init")).toBe(true);
    expect(startsOnConnectForInit("")).toBe(false);
    expect(startsOnConnectForInit(null)).toBe(false);
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

  // The schema the hand-written parser replaced (#17022): every Host and Shell
  // already in the field reads discovery files by it, so the two must agree.
  const zodSchema = z.object({
    version: z.literal(1),
    socketPath: z.string().min(1).max(1024),
    token: z.string().regex(/^[0-9a-f]{64}$/),
    pid: z.number().int().min(0),
    startedAt: z.string().min(1).max(64).optional(),
    command: z.array(z.string().min(1).max(4096)).min(1).max(4).optional(),
  });
  const viaZod = (value: unknown) => {
    const parsed = zodSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
  const emoji = "\u{1F600}";

  // Each fixture says whether the old schema accepts it, so a name that no
  // longer matches its fixture fails instead of agreeing on a rejection.
  it.each([
    ["the minimal file", good, true],
    ["every field", { ...good, startedAt: "Wed Oct 22", command: ["/opt/Daintree", "/app"] }, true],
    ["unknown keys", { ...good, extra: true, nested: { a: 1 } }, true],
    ["a missing socket path", { ...good, socketPath: undefined }, false],
    ["an empty socket path", { ...good, socketPath: "" }, false],
    ["a one-character socket path", { ...good, socketPath: "s" }, true],
    ["a socket path at its limit", { ...good, socketPath: "s".repeat(1024) }, true],
    ["a socket path past its limit", { ...good, socketPath: "s".repeat(1025) }, false],
    [
      "a socket path at its limit in code points",
      { ...good, socketPath: emoji.repeat(1024) },
      true,
    ],
    [
      "a socket path past its limit in code points",
      { ...good, socketPath: emoji.repeat(1025) },
      false,
    ],
    ["an uppercase token", { ...good, token: "A".repeat(64) }, false],
    ["a 63-character token", { ...good, token: "a".repeat(63) }, false],
    ["a numeric token", { ...good, token: 1 }, false],
    ["a string version", { ...good, version: "1" }, false],
    ["pid zero", { ...good, pid: 0 }, true],
    ["a negative pid", { ...good, pid: -1 }, false],
    ["a fractional pid", { ...good, pid: 1.5 }, false],
    ["an unsafe pid", { ...good, pid: 2 ** 60 }, false],
    ["the largest safe pid", { ...good, pid: Number.MAX_SAFE_INTEGER }, true],
    ["a string pid", { ...good, pid: "9" }, false],
    ["a null startedAt", { ...good, startedAt: null }, false],
    ["an empty startedAt", { ...good, startedAt: "" }, false],
    ["a one-character startedAt", { ...good, startedAt: "x" }, true],
    ["a startedAt at its limit", { ...good, startedAt: "x".repeat(64) }, true],
    ["a startedAt past its limit", { ...good, startedAt: "x".repeat(65) }, false],
    ["a startedAt of 64 code points", { ...good, startedAt: emoji.repeat(64) }, true],
    ["a startedAt of 65 code points", { ...good, startedAt: emoji.repeat(65) }, false],
    ["a startedAt with a lone surrogate", { ...good, startedAt: "\ud83d" }, true],
    ["a null command", { ...good, command: null }, false],
    ["an empty command", { ...good, command: [] }, false],
    ["a command of one part", { ...good, command: ["a"] }, true],
    ["a command of four parts", { ...good, command: ["a", "b", "c", "d"] }, true],
    ["a command of five parts", { ...good, command: ["a", "b", "c", "d", "e"] }, false],
    ["a command with an empty part", { ...good, command: ["a", ""] }, false],
    ["a command with a numeric part", { ...good, command: ["a", 1] }, false],
    ["a command part at its limit", { ...good, command: ["p".repeat(4096)] }, true],
    ["a command part past its limit", { ...good, command: ["p".repeat(4097)] }, false],
    ["a string command", { ...good, command: "/opt/Daintree" }, false],
    ["an array", [good], false],
    ["null", null, false],
    ["a number", 1, false],
  ] as const)("agrees with the zod schema it replaced on %s", (_label, value, accepted) => {
    const text = JSON.stringify(value);
    const expected = viaZod(JSON.parse(text));
    expect(expected !== null).toBe(accepted);
    expect(parseDiscoveryInfo(text)).toEqual(expected);
  });

  it("compares tokens without accepting empty or different-length values", () => {
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abd", "abc")).toBe(false);
    expect(tokensEqual("ab", "abc")).toBe(false);
    expect(tokensEqual("", "")).toBe(false);
  });
});

describe("discovery file start time", () => {
  const base = {
    version: 1,
    socketPath: "/run/user/1000/daintree-host/host.sock",
    token: "a".repeat(64),
    pid: 4242,
  };

  it("keeps startedAt and accepts files from hosts that wrote none", () => {
    expect(
      parseDiscoveryInfo(JSON.stringify({ ...base, startedAt: "Wed Oct 22 10:00:00 2026" }))
    ).toEqual({
      ...base,
      startedAt: "Wed Oct 22 10:00:00 2026",
    });
    expect(parseDiscoveryInfo(JSON.stringify(base))).toEqual(base);
  });
});
