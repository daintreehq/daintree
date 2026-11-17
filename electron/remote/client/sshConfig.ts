import crypto from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isValidSshTarget } from "../../../shared/utils/sshTarget.js";

/**
 * ssh_config read the way OpenSSH's readconf walks it, for two jobs that never
 * run ssh: the aliases Add Host lists, and the files a remembered route depends
 * on. Only `Host`, `Match` and `Include` lines are read. Nothing is resolved and
 * no `Match` is evaluated, since deciding one can mean running its `exec`; that
 * is also why `ssh -G` isn't used here.
 */

/** OpenSSH's READCONF_MAX_DEPTH. */
const MAX_INCLUDE_DEPTH = 16;
const MAX_FILES = 256;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIR_ENTRIES = 4096;
/** A config on a dead mount stops the walk here rather than holding up a dial or the dialog. */
const WALK_DEADLINE_MS = 2_000;
/** More than a list can usefully show; the rest can still be typed. */
const MAX_ALIASES = 500;

export interface SshConfigRoot {
  path: string;
  /** The system config: its relative Includes live in /etc/ssh, and `~` is refused there. */
  system?: boolean;
}

export interface SshConfigWalkOptions {
  /** This user's home; the system's unless given. */
  home?: string;
  signal?: AbortSignal;
  deadlineMs?: number;
}

/** The files system ssh reads when no `-F` is given. */
export function defaultSshConfigRoots(home: string = os.homedir()): SshConfigRoot[] {
  return [
    { path: path.join(home, ".ssh", "config") },
    { path: "/etc/ssh/ssh_config", system: true },
  ];
}

export interface ConfigLine {
  keyword: string;
  /** Null when ssh would refuse the line: no argument, or a quote left open. */
  args: string[] | null;
}

/**
 * OpenSSH's argv_split: whitespace between words, double or single quotes
 * around one, a backslash before a quote, a backslash or (outside quotes) a
 * space taken literally, and a `#` starting a word ends the line.
 */
function splitArgs(text: string): string[] | null {
  const args: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "#") break;
    let arg = "";
    let quote = "";
    for (; i < text.length; i++) {
      const ch = text[i]!;
      const next = text[i + 1];
      if (ch === "\\") {
        if (next === "'" || next === '"' || next === "\\" || (quote === "" && next === " ")) i++;
        arg += text[i]!;
      } else if (quote === "" && (ch === " " || ch === "\t")) {
        break;
      } else if (quote === "" && (ch === '"' || ch === "'")) {
        quote = ch;
      } else if (quote !== "" && ch === quote) {
        quote = "";
      } else {
        arg += ch;
      }
    }
    if (quote !== "") return null;
    args.push(arg);
  }
  return args;
}

/** A keyword and its arguments, or null for a blank or comment line. Keywords are case-insensitive. */
export function splitConfigLine(raw: string): ConfigLine | null {
  const line = raw.replace(/^[ \t]+/, "").replace(/[ \t\r\n\f]+$/, "");
  if (line === "" || line.startsWith("#")) return null;
  const match = /^([^ \t"=]+)[ \t]*(?:=[ \t]*)?(.*)$/.exec(line);
  if (!match) return null;
  const keyword = match[1]!.toLowerCase();
  const rest = match[2]!;
  const args = rest === "" ? null : splitArgs(rest);
  return { keyword, args: args && args.length > 0 ? args : null };
}

/** OpenSSH's match_pattern: `*` and `?` wildcards, everything else literal and case-sensitive. */
export function matchHostPattern(name: string, pattern: string): boolean {
  let n = 0;
  let p = 0;
  let star = -1;
  let mark = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) {
      n++;
      p++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = n;
    } else if (star >= 0) {
      p = star + 1;
      n = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** A `Host` line applies when one of its patterns matches and none of its `!` patterns does. */
export function hostLineMatches(name: string, patterns: readonly string[]): boolean {
  let matched = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    if (!matchHostPattern(name, negated ? raw.slice(1) : raw)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

/** A Host argument that names one machine, typed as it would be after `ssh`. */
function isListableAlias(arg: string): boolean {
  // A pattern stands for many names; `@` never matches, since Host is matched against the host alone.
  return !/[*?!@]/.test(arg) && isValidSshTarget(arg);
}

type Block =
  | { kind: "all" }
  | { kind: "host"; patterns: string[] }
  /** A `Match` other than `Match all`: whether it applies can't be known without evaluating it. */
  | { kind: "match" }
  /** A `Host` or `Match` line ssh would refuse. */
  | { kind: "never" };

interface WalkContext {
  mode: "aliases" | "dependencies";
  home: string;
  signal?: AbortSignal;
  stopped: boolean;
  files: number;
  dirEntries: number;
  complete: boolean;
  aliases: string[];
  aliasSet: Set<string>;
  stamps: string[];
}

/** Include's path as readconf anchors it: `~/` in user configs, relative ones under ~/.ssh or /etc/ssh. */
function includePattern(arg: string, system: boolean, home: string): string | null {
  if (arg.startsWith("~")) {
    if (system) return null;
    if (arg === "~" || arg.startsWith("~/")) return path.join(home, arg.slice(1));
    // Another user's home: glob(3) would look it up; not worth a passwd read here.
    return null;
  }
  if (path.isAbsolute(arg)) return arg;
  return path.join(system ? "/etc/ssh" : path.join(home, ".ssh"), arg);
}

const GLOB_MAGIC = /[*?[]/;

/** One path segment against a glob(3) pattern: `*`, `?`, `[...]` classes and `\` escapes, no leading dot unless written. */
function globSegmentMatches(name: string, pattern: string): boolean {
  if (name.startsWith(".") && !pattern.startsWith(".")) return false;
  type Token = { kind: "star" } | { kind: "one"; test: (c: string) => boolean };
  const tokens: Token[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      tokens.push({ kind: "star" });
    } else if (c === "?") {
      tokens.push({ kind: "one", test: () => true });
    } else if (c === "[" && pattern.indexOf("]", i + 2) > 0) {
      const close = pattern.indexOf("]", i + 2);
      let body = pattern.slice(i + 1, close);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      const ranges: Array<[string, string]> = [];
      for (let j = 0; j < body.length; j++) {
        const from = body[j]!;
        if (body[j + 1] === "-" && j + 2 < body.length) {
          ranges.push([from, body[j + 2]!]);
          j += 2;
        } else {
          ranges.push([from, from]);
        }
      }
      tokens.push({
        kind: "one",
        test: (ch) => ranges.some(([lo, hi]) => ch >= lo && ch <= hi) !== negate,
      });
      i = close;
    } else {
      const literal = c === "\\" && i + 1 < pattern.length ? pattern[++i]! : c;
      tokens.push({ kind: "one", test: (ch) => ch === literal });
    }
  }
  let n = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (n < name.length) {
    const token = tokens[t];
    if (token?.kind === "one" && token.test(name[n]!)) {
      n++;
      t++;
    } else if (token?.kind === "star") {
      star = t++;
      mark = n;
    } else if (star >= 0) {
      t = star + 1;
      n = ++mark;
    } else {
      return false;
    }
  }
  while (tokens[t]?.kind === "star") t++;
  return t === tokens.length;
}

/** The files an Include pattern names, sorted as glob(3) sorts them. */
async function expandInclude(pattern: string, ctx: WalkContext): Promise<string[]> {
  if (!GLOB_MAGIC.test(pattern)) return [pattern];
  const { root } = path.parse(pattern);
  // A backslash is glob's escape on POSIX, so it only separates on Windows.
  const separators = path.sep === "\\" ? /[\\/]+/ : /\/+/;
  const segments = pattern.slice(root.length).split(separators).filter(Boolean);
  let paths = [root];
  for (const segment of segments) {
    if (!GLOB_MAGIC.test(segment)) {
      paths = paths.map((dir) => path.join(dir, segment));
      continue;
    }
    const next: string[] = [];
    for (const dir of paths) {
      if (ctx.stopped) return [];
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }
      ctx.dirEntries += entries.length;
      if (ctx.dirEntries > MAX_DIR_ENTRIES) {
        ctx.complete = false;
        return [];
      }
      for (const entry of entries) {
        if (globSegmentMatches(entry, segment)) next.push(path.join(dir, entry));
      }
    }
    paths = next;
  }
  // Every match counts toward the stamp, so a file newly matching the pattern changes it.
  ctx.stamps.push(`glob:${pattern}`);
  return paths.sort();
}

async function walkFile(
  file: string,
  system: boolean,
  gates: readonly (readonly string[])[],
  depth: number,
  ancestry: ReadonlySet<string>,
  ctx: WalkContext
): Promise<void> {
  if (ctx.stopped) return;
  if (++ctx.files > MAX_FILES) {
    ctx.complete = false;
    return;
  }
  let stat: Stats;
  try {
    stat = await fs.stat(file);
  } catch {
    ctx.stamps.push(`${file}:-`);
    return;
  }
  ctx.stamps.push(`${file}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
  if (!stat.isFile()) return;
  // ssh stops a loop at its depth limit; nothing past the first visit adds a host or a file.
  const identity = `${stat.dev}:${stat.ino}`;
  if (ancestry.has(identity)) return;
  if (stat.size > MAX_FILE_BYTES) {
    ctx.complete = false;
    return;
  }
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    ctx.complete = false;
    return;
  }
  const lineage = new Set(ancestry).add(identity);
  // Until its first Host or Match, a file is in whatever block included it.
  let block: Block = { kind: "all" };
  for (const raw of text.replace(/^﻿/, "").split("\n")) {
    if (ctx.stopped) return;
    const line = splitConfigLine(raw);
    if (!line) continue;
    if (line.keyword === "host") {
      const args = line.args;
      block = args && !args.includes("") ? { kind: "host", patterns: args } : { kind: "never" };
      if (ctx.mode === "aliases" && block.kind === "host") {
        for (const alias of block.patterns) {
          if (ctx.aliasSet.has(alias) || !isListableAlias(alias)) continue;
          // An included host applies only to names its Include's own Host lines match too.
          if (!hostLineMatches(alias, block.patterns)) continue;
          if (!gates.every((gate) => hostLineMatches(alias, gate))) continue;
          if (ctx.aliases.length >= MAX_ALIASES) break;
          ctx.aliasSet.add(alias);
          ctx.aliases.push(alias);
        }
      }
    } else if (line.keyword === "match") {
      const args = line.args;
      block = !args
        ? { kind: "never" }
        : args.length === 1 && args[0]!.toLowerCase() === "all"
          ? { kind: "all" }
          : { kind: "match" };
    } else if (line.keyword === "include" && line.args) {
      // Listing never decides a Match; a route's files follow every Include, whatever block it sits in.
      if (ctx.mode === "aliases" && (block.kind === "match" || block.kind === "never")) continue;
      const inner = block.kind === "host" ? [...gates, block.patterns] : gates;
      for (const arg of line.args) {
        const pattern = includePattern(arg, system, ctx.home);
        if (pattern === null) {
          // Nothing this can resolve, so a route can't be known to stay as it is.
          ctx.complete = false;
          continue;
        }
        const files = await expandInclude(pattern, ctx);
        for (const included of files) {
          if (depth + 1 > MAX_INCLUDE_DEPTH) {
            ctx.complete = false;
            break;
          }
          await walkFile(included, system, inner, depth + 1, lineage, ctx);
        }
      }
    }
  }
}

async function walk(
  roots: readonly SshConfigRoot[],
  mode: WalkContext["mode"],
  options: SshConfigWalkOptions
): Promise<WalkContext> {
  const ctx: WalkContext = {
    mode,
    home: options.home ?? os.homedir(),
    signal: options.signal,
    stopped: false,
    files: 0,
    dirEntries: 0,
    complete: true,
    aliases: [],
    aliasSet: new Set(),
    stamps: [],
  };
  const stop = () => {
    ctx.stopped = true;
    ctx.complete = false;
  };
  if (options.signal?.aborted) {
    stop();
    return ctx;
  }
  options.signal?.addEventListener("abort", stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      stop();
      resolve();
    }, options.deadlineMs ?? WALK_DEADLINE_MS);
  });
  const run = (async () => {
    for (const root of roots) {
      await walkFile(root.path, root.system === true, [], 0, new Set(), ctx);
    }
  })().catch(() => {
    ctx.complete = false;
  });
  try {
    // A read that hangs can't be cancelled; the walk is left to finish on its own and its result dropped.
    await Promise.race([run, deadline]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
  }
  return ctx;
}

/**
 * The hosts the user's own `~/.ssh/config` names, as written: literal `Host`
 * names (never a pattern), from the file and its Includes. An included file's
 * hosts are listed only when they also match the `Host` line above its
 * `Include` (`Host *` and the top of a file match everything), and Includes
 * under a `Match` other than `Match all` are skipped. A missing or unreadable
 * config is an empty list.
 */
export async function listSshConfigAliases(options: SshConfigWalkOptions = {}): Promise<string[]> {
  const home = options.home ?? os.homedir();
  const ctx = await walk([{ path: path.join(home, ".ssh", "config") }], "aliases", {
    ...options,
    home,
  });
  return [...ctx.aliases];
}

let incompleteStamps = 0;

/**
 * How the ssh config files stood: each file the roots reach through any
 * Include (whatever block it sits in), and what each Include pattern matched.
 * A remembered route is only good while this is unchanged. A walk cut short
 * (too many files, a hung read) gives a stamp no later one equals, so the
 * route is never reused on a partial view of the config.
 */
export async function sshConfigStamp(
  roots: readonly SshConfigRoot[],
  options: SshConfigWalkOptions = {}
): Promise<string> {
  const ctx = await walk(roots, "dependencies", options);
  if (!ctx.complete) return `incomplete:${++incompleteStamps}`;
  return crypto.createHash("sha256").update(ctx.stamps.join("\n")).digest("hex");
}
