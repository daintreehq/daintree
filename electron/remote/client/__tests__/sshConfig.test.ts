import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hostLineMatches,
  listSshConfigAliases,
  matchHostPattern,
  splitConfigLine,
  sshConfigStamp,
} from "../sshConfig.js";

let home: string;
let sshDir: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "ssh-config-"));
  sshDir = path.join(home, ".ssh");
  mkdirSync(sshDir);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function write(relative: string, text: string): string {
  const file = path.join(sshDir, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

const aliases = () => listSshConfigAliases({ home });

describe("splitConfigLine", () => {
  it("reads keywords in any case, after `=`, with quotes and trailing comments", () => {
    expect(splitConfigLine("HOST=alpha")).toEqual({ keyword: "host", args: ["alpha"] });
    expect(splitConfigLine("  Host  beta gamma  # two boxes\r")).toEqual({
      keyword: "host",
      args: ["beta", "gamma"],
    });
    expect(splitConfigLine("Include \"dir with space/*\" 'b'")).toEqual({
      keyword: "include",
      args: ["dir with space/*", "b"],
    });
    expect(splitConfigLine("Host a#b")).toEqual({ keyword: "host", args: ["a#b"] });
  });

  it("skips blanks and comments, and flags a line ssh would refuse", () => {
    expect(splitConfigLine("")).toBeNull();
    expect(splitConfigLine("   # Host nope")).toBeNull();
    expect(splitConfigLine("Host")).toEqual({ keyword: "host", args: null });
    expect(splitConfigLine('Host "open')).toEqual({ keyword: "host", args: null });
  });
});

describe("Host patterns", () => {
  it("matches * and ? case-sensitively and honours negation", () => {
    expect(matchHostPattern("work-db", "work-*")).toBe(true);
    expect(matchHostPattern("work-db", "w?rk-d?")).toBe(true);
    expect(matchHostPattern("Work-db", "work-*")).toBe(false);
    expect(matchHostPattern("a.b.c", "*.*.c")).toBe(true);
    expect(matchHostPattern("abc", "*x*")).toBe(false);
    expect(hostLineMatches("prod-db", ["prod-*", "!prod-legacy"])).toBe(true);
    expect(hostLineMatches("prod-legacy", ["prod-*", "!prod-legacy"])).toBe(false);
    // A negation alone never matches anything.
    expect(hostLineMatches("other", ["!prod-legacy"])).toBe(false);
  });
});

describe("listSshConfigAliases", () => {
  it("lists literal Host names as written, once each, never patterns", async () => {
    write(
      "config",
      [
        "Host build-box Studio.Local",
        "  HostName 10.0.0.4",
        "  Port 2222",
        "  ProxyJump bastion",
        "Host *.internal dev-? !nope",
        "Host build-box",
        "Host greg@box -oProxyCommand=x",
        "Host *",
        "  ServerAliveInterval 30",
      ].join("\n")
    );
    expect(await aliases()).toEqual(["build-box", "Studio.Local"]);
  });

  it("is empty when the config is missing or isn't a file", async () => {
    expect(await aliases()).toEqual([]);
    mkdirSync(path.join(sshDir, "config"));
    expect(await aliases()).toEqual([]);
  });

  it("follows Includes relative to ~/.ssh, through ~/ and globs in lexical order", async () => {
    write("config", "Include config.d/* ~/extra.conf\nHost top\n");
    write("config.d/20-b", "Host second\n");
    write("config.d/10-a", "Host first\n");
    write("config.d/.hidden", "Host hidden\n");
    writeFileSync(path.join(home, "extra.conf"), "Host extra\n");
    expect(await aliases()).toEqual(["first", "second", "extra", "top"]);
  });

  it("lists an included host only when the Host line above its Include matches it too", async () => {
    write(
      "config",
      ["Host work-*", "  Include work.conf", "Host *", "  Include common.conf"].join("\n")
    );
    write("work.conf", "HostName jump.example\nHost work-db nested-box\n");
    write("common.conf", "Host shared-box\n");
    expect(await aliases()).toEqual(["work-db", "shared-box"]);
  });

  it("carries every enclosing Host gate down nested Includes", async () => {
    write("config", "Host prod-* !prod-legacy\n  Include outer.conf\n");
    write("outer.conf", "Host prod-*\n  Include inner.conf\nHost prod-api\n");
    write("inner.conf", "Host prod-db prod-legacy staging-db\n");
    expect(await aliases()).toEqual(["prod-db", "prod-api"]);
  });

  it("skips Includes under a Match it would have to evaluate, but not under Match all", async () => {
    write(
      "config",
      [
        'Match exec "touch /tmp/never"',
        "  Include matched.conf",
        "Host after-match",
        "Match all",
        "  Include tools.conf",
      ].join("\n")
    );
    write("matched.conf", "Host behind-match\n");
    write("tools.conf", "Host from-a-tool\n");
    expect(await aliases()).toEqual(["after-match", "from-a-tool"]);
  });

  it("keeps an Include under a Host line ssh would refuse out of the list", async () => {
    write("config", 'Host "broken\n  Include x.conf\nHost fine\n');
    write("x.conf", "Host hidden\n");
    expect(await aliases()).toEqual(["fine"]);
  });

  it("stops at a file that includes itself", async () => {
    write("config", "Include loop.conf\n");
    write("loop.conf", "Host looped\nInclude loop.conf\n");
    expect(await aliases()).toEqual(["looped"]);
  });

  it("returns nothing once cancelled", async () => {
    write("config", "Host a\n");
    const abort = new AbortController();
    abort.abort();
    expect(await listSshConfigAliases({ home, signal: abort.signal })).toEqual([]);
  });
});

describe("sshConfigStamp", () => {
  const roots = () => [{ path: path.join(sshDir, "config") }];
  const stamp = () => sshConfigStamp(roots(), { home });

  it("stays put while nothing changes and moves when an included file does", async () => {
    write("config", "Host studio\n  Include studio.conf\n");
    write("studio.conf", "HostName a.example\n");
    const first = await stamp();
    expect(await stamp()).toBe(first);
    write("studio.conf", "HostName b.example.org\n");
    expect(await stamp()).not.toBe(first);
  });

  it("moves when a new file matches an Include glob", async () => {
    write("config", "Include config.d/*\n");
    write("config.d/a", "Host a\n");
    const first = await stamp();
    write("config.d/b", "Host b\n");
    expect(await stamp()).not.toBe(first);
  });

  it("covers Includes under any Match, since ssh may read them", async () => {
    write("config", 'Match exec "true"\n  Include matched.conf\n');
    write("matched.conf", "HostName a.example\n");
    const first = await stamp();
    write("matched.conf", "HostName b.example.org\n");
    expect(await stamp()).not.toBe(first);
  });

  it("never repeats a stamp from a walk cut short", async () => {
    write("config", "Host a\n");
    const abort = new AbortController();
    abort.abort();
    const a = await sshConfigStamp(roots(), { home, signal: abort.signal });
    const b = await sshConfigStamp(roots(), { home, signal: abort.signal });
    expect(a).not.toBe(b);
  });
});
