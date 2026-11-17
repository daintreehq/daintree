import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  vi.unstubAllEnvs();
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
    expect(splitConfigLine("Include \"dir with space/*\" 'b' c\\ d")).toEqual({
      keyword: "include",
      args: ["dir with space/*", "b", "c d"],
    });
    expect(splitConfigLine("Host a#b")).toEqual({ keyword: "host", args: ["a#b"] });
    expect(splitConfigLine("Include peers.conf\r")).toEqual({
      keyword: "include",
      args: ["peers.conf"],
    });
  });

  it("splits the keyword as readconf's strdelim does", () => {
    expect(splitConfigLine('"Include" peers.conf')).toEqual({
      keyword: "include",
      args: ["peers.conf"],
    });
    // The quoted part joins the word: this is HostName, not a Host line.
    expect(splitConfigLine('Host"Name" db')).toEqual({ keyword: "hostname", args: ["db"] });
    expect(splitConfigLine("=Include peers.conf")).toEqual({
      keyword: "include",
      args: ["peers.conf"],
    });
    expect(splitConfigLine("Include\rpeers.conf")).toEqual({
      keyword: "include",
      args: ["peers.conf"],
    });
    // A C string ends at its first NUL; a byte-order mark is part of the keyword.
    expect(splitConfigLine(`Include peers.conf${String.fromCharCode(0)}junk`)).toEqual({
      keyword: "include",
      args: ["peers.conf"],
    });
    expect(splitConfigLine(`${String.fromCharCode(0xfeff)}Host ghost`)?.keyword).not.toBe("host");
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
    expect(matchHostPattern("work-dbx", "work-d?")).toBe(false);
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
        "Host box !box",
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

  it("reads bracket classes, escapes and an explicit leading dot as glob(3) does", async () => {
    write("config", "Include conf.d/[0-9]* conf.d/lit\\.conf conf.d/\\.private*\n");
    write("conf.d/1-a", "Host one\n");
    write("conf.d/x-b", "Host letter\n");
    write("conf.d/lit.conf", "Host literal\n");
    write("conf.d/.private-a", "Host private\n");
    expect(await aliases()).toEqual(["one", "literal", "private"]);
  });

  it("expands environment variables and this machine's %-tokens in an Include", async () => {
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), "ssh-config-env-"));
    try {
      writeFileSync(path.join(elsewhere, "env.conf"), "Host from-env\n");
      writeFileSync(path.join(home, "home.conf"), "Host from-home\n");
      vi.stubEnv("DAINTREE_SSH_CONFIG_TEST_DIR", elsewhere);
      write(
        "config",
        "Include ${DAINTREE_SSH_CONFIG_TEST_DIR}/env.conf %d/home.conf hosts/%h.conf\n"
      );
      write("hosts/%h.conf", "Host literal-token\n");
      expect(await aliases()).toEqual(["from-env", "from-home"]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
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

  it("requires every enclosing Host gate down nested Includes", async () => {
    write("config", "Host prod-* !prod-legacy\n  Include outer.conf\n");
    write("outer.conf", "Host *-db\n  Include inner.conf\nHost prod-api\n");
    write("inner.conf", "Host prod-db prod-cache prod-legacy staging-db\n");
    expect(await aliases()).toEqual(["prod-db", "prod-api"]);
  });

  it("keeps the including block's gate after a child changes its own", async () => {
    write("config", "Host work-*\n  Include a.conf\n  Include b.conf\n");
    write("a.conf", "Host other\n");
    write("b.conf", "Include c.conf\nHost work-b nonwork\n");
    write("c.conf", "Host work-c outside\n");
    expect(await aliases()).toEqual(["work-c", "work-b"]);
  });

  it("skips Includes under a Match it would have to evaluate, but not under Match all", async () => {
    write(
      "config",
      [
        'Match exec "touch /tmp/never"',
        "  Include matched.conf",
        "Match final all",
        "  Include final.conf",
        "Host after-match",
        "Match all",
        "  Include tools.conf",
      ].join("\n")
    );
    write("matched.conf", "Host behind-match\n");
    write("final.conf", "Host behind-final\n");
    write("tools.conf", "Host from-a-tool\n");
    expect(await aliases()).toEqual(["after-match", "from-a-tool"]);
  });

  it("keeps an Include under a Host line ssh would refuse out of the list", async () => {
    write("config", 'Host "broken\n  Include x.conf\nHost ""\n  Include x.conf\nHost fine\n');
    write("x.conf", "Host hidden\n");
    expect(await aliases()).toEqual(["fine"]);
  });

  it("stops at a file that includes itself", async () => {
    write("config", "Include loop.conf\n");
    write("loop.conf", "Host looped\nInclude loop.conf\n");
    expect(await aliases()).toEqual(["looped"]);
  });

  it("returns nothing once cancelled or past its deadline", async () => {
    write("config", "Host a\n");
    const abort = new AbortController();
    abort.abort();
    expect(await listSshConfigAliases({ home, signal: abort.signal })).toEqual([]);
    expect(await listSshConfigAliases({ home, deadlineMs: -1 })).toEqual([]);
  });
});

describe("sshConfigStamp", () => {
  const roots = () => [{ path: path.join(sshDir, "config") }];
  const stamp = () => sshConfigStamp(roots(), { home });

  it("stays put while nothing changes and moves when an included file's bytes do", async () => {
    write("config", "Host studio\n  Include studio.conf\n");
    write("studio.conf", "HostName a.example\n");
    const first = await stamp();
    expect(await stamp()).toBe(first);
    // Same size, so only the bytes tell it apart within one timestamp tick.
    write("studio.conf", "HostName b.example\n");
    expect(await stamp()).not.toBe(first);
  });

  it("moves when a new file matches an Include glob", async () => {
    write("config", "Include config.d/*\n");
    write("config.d/a", "Host a\n");
    const first = await stamp();
    expect(await stamp()).toBe(first);
    write("config.d/b", "Host b\n");
    expect(await stamp()).not.toBe(first);
  });

  it("covers Includes under any Match, since ssh may read them", async () => {
    write("config", 'Match exec "true"\n  Include matched.conf\n');
    write("matched.conf", "HostName a.example\n");
    const first = await stamp();
    expect(await stamp()).toBe(first);
    write("matched.conf", "HostName b.example.org\n");
    expect(await stamp()).not.toBe(first);
  });

  it("never repeats a stamp it can't vouch for", async () => {
    const twice = async () => [await stamp(), await stamp()];
    // An Include naming the destination.
    write("config", "Include hosts/%h.conf\n");
    let [a, b] = await twice();
    expect(a).not.toBe(b);
    // A character class this doesn't read.
    write("config", "Include conf.d/[[:digit:]]*\n");
    [a, b] = await twice();
    expect(a).not.toBe(b);
    // A loop, which ssh refuses at its depth limit.
    write("config", "Include config\n");
    [a, b] = await twice();
    expect(a).not.toBe(b);

    write("config", "Host a\n");
    const abort = new AbortController();
    abort.abort();
    a = await sshConfigStamp(roots(), { home, signal: abort.signal });
    b = await sshConfigStamp(roots(), { home, deadlineMs: -1 });
    expect(a).not.toBe(b);
    expect(a).not.toBe(await stamp());
  });
});
