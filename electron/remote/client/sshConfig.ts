import crypto from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
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
/** Character comparisons per walk: a pathological Host line stops here rather than holding the main thread. */
const MAX_MATCH_WORK = 20_000_000;
/** Longer than any file name, so a longer glob segment can't name one; reading it would only cost time. */
const MAX_GLOB_SEGMENT = 1024;
/** A config on a dead mount stops the walk here rather than holding up a dial or the dialog. */
const WALK_DEADLINE_MS = 2_000;
/** More than a list can usefully show; the rest can still be typed. */
const MAX_ALIASES = 500;

const WHITESPACE = " \t\r\n";
const NUL = String.fromCharCode(0);

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

function skipWhitespace(line: string, at: number): number {
  while (at < line.length && WHITESPACE.includes(line[at]!)) at++;
  return at;
}

/**
 * OpenSSH's strdelim: one word, ending at whitespace, a double quote (whose
 * contents join the word) or a single `=`. `next` is -1 once the line is used
 * up; null for a quote left open.
 */
function strdelim(line: string, from: number): { word: string; next: number } | null {
  let at = from;
  while (at < line.length && !`${WHITESPACE}"=`.includes(line[at]!)) at++;
  if (at >= line.length) return { word: line.slice(from), next: -1 };
  if (line[at] === '"') {
    const close = line.indexOf('"', at + 1);
    if (close < 0) return null;
    return {
      word: line.slice(from, at) + line.slice(at + 1, close),
      next: skipWhitespace(line, close + 1),
    };
  }
  const equals = line[at] === "=";
  let next = skipWhitespace(line, at + 1);
  if (!equals && line[next] === "=") next = skipWhitespace(line, next + 1);
  return { word: line.slice(from, at), next };
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

/** A keyword (lowercased) and its arguments, as readconf splits a line; null for a blank or comment line. */
export function splitConfigLine(raw: string): ConfigLine | null {
  // A C string ends at its first NUL, and readconf trims trailing whitespace and form feeds.
  const nul = raw.indexOf(NUL);
  let end = nul < 0 ? raw.length : nul;
  while (end > 0 && `${WHITESPACE}\f`.includes(raw[end - 1]!)) end--;
  const line = raw.slice(0, end);
  if (line === "") return null;
  let first = strdelim(line, 0);
  // Leading whitespace (or a leading `=`) gives an empty first word; the keyword is the next one.
  if (first && first.word === "") first = first.next < 0 ? null : strdelim(line, first.next);
  if (!first || first.word === "" || first.word.startsWith("#")) return null;
  const keyword = first.word.toLowerCase();
  const rest = first.next < 0 ? "" : line.slice(skipWhitespace(line, first.next));
  return { keyword, args: rest === "" ? null : splitArgs(rest) };
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
  deadlineAt: number;
  stopped: boolean;
  /** Ends the caller's wait at once, whatever read is still pending. */
  settle: () => void;
  files: number;
  dirEntries: number;
  work: number;
  complete: boolean;
  aliases: string[];
  aliasSet: Set<string>;
  stamps: string[];
}

function halt(ctx: WalkContext): void {
  ctx.stopped = true;
  ctx.complete = false;
  ctx.settle();
}

function outOfTime(ctx: WalkContext): boolean {
  if (!ctx.stopped && Date.now() > ctx.deadlineAt) halt(ctx);
  return ctx.stopped;
}

/** Not there: an ordinary miss, as ssh's glob and fopen see one. Anything else leaves ssh's view unknown. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The %-tokens Include shares with Match exec that don't depend on the destination. */
function localToken(token: string, home: string): string | null {
  try {
    switch (token) {
      case "%":
        return "%";
      case "d":
        return home;
      case "u":
        return os.userInfo().username;
      case "i":
        return process.getuid ? String(process.getuid()) : null;
      case "l":
        return os.hostname();
      case "L":
        return os.hostname().split(".")[0] ?? null;
      default:
        // %h, %n, %p, %r, %C, %j, %k name the host being dialled.
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Include's environment variables and %-tokens (OpenSSH 9.9+), in one pass
 * over the operand as ssh makes it, so a value is never read again as a token.
 * Null when one can't be known here.
 */
function expandIncludeTokens(arg: string, home: string): string | null {
  let out = "";
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i]!;
    if (c === "$" && arg[i + 1] === "{") {
      const close = arg.indexOf("}", i + 2);
      const name = close < 0 ? "" : arg.slice(i + 2, close);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
      const value: unknown = process.env[name];
      if (typeof value !== "string") return null;
      out += value;
      i = close;
    } else if (c === "%") {
      const token = arg[++i];
      const value = token === undefined ? null : localToken(token, home);
      if (value === null) return null;
      out += value;
    } else {
      out += c;
    }
  }
  return out;
}

/** Include's path as readconf anchors it: `~/` in user configs, relative ones under ~/.ssh or /etc/ssh. */
function includePattern(arg: string, system: boolean, home: string): string | null {
  const expanded = expandIncludeTokens(arg, home);
  if (expanded === null) return null;
  if (expanded.startsWith("~")) {
    if (system) return null;
    if (expanded === "~" || expanded.startsWith("~/")) return home + expanded.slice(1);
    // Another user's home: glob(3) would look it up; not worth a passwd read here.
    return null;
  }
  if (path.isAbsolute(expanded)) return expanded;
  // Joined as glob(3) sees it: `link/..` is the filesystem's to resolve, not collapsed here.
  return `${system ? "/etc/ssh" : `${home}/.ssh`}/${expanded}`;
}

type GlobToken = { kind: "star" } | { kind: "one"; test: (c: string) => boolean; literal?: string };

/**
 * A bracket expression from `open` (the `[`): its test and where it closes,
 * or null when nothing closes it and the `[` is literal. `undefined` for a
 * POSIX character class, which isn't read here.
 */
function globClass(
  segment: string,
  open: number,
  escapes: boolean,
  lastClose: number
): { test: (c: string) => boolean; close: number } | null | undefined {
  // Nothing can close it: a member and then the segment's last `]` must both fit after it.
  if (lastClose < open + 2) return null;
  let i = open + 1;
  const negate = segment[i] === "!";
  if (negate) i++;
  const chars: string[] = [];
  const ranges: Array<[string, string]> = [];
  let first = true;
  while (i <= lastClose) {
    let c = segment[i]!;
    // A `]` first in the class is one of its characters.
    if (c === "]" && !first) {
      const set = ranges.concat(chars.map((ch): [string, string] => [ch, ch]));
      return { test: (ch) => set.some(([lo, hi]) => ch >= lo && ch <= hi) !== negate, close: i };
    }
    if (c === "[" && segment[i + 1] === ":") return undefined;
    if (escapes && c === "\\" && i + 1 < segment.length) c = segment[++i]!;
    first = false;
    const dash = segment[i + 1] === "-" && i + 2 < segment.length && segment[i + 2] !== "]";
    if (dash) {
      let hi = segment[i + 2]!;
      i += 2;
      if (escapes && hi === "\\" && i + 1 < segment.length) hi = segment[++i]!;
      ranges.push([c, hi]);
    } else {
      chars.push(c);
    }
    i++;
  }
  return null;
}

/**
 * One path segment of a glob(3) pattern: `*`, `?`, `[...]` (with `!` and
 * ranges) and, on POSIX, `\` escapes. Null for what isn't read here: a POSIX
 * character class, or a segment longer than any file name.
 */
function globTokens(segment: string): GlobToken[] | null {
  if (segment.length > MAX_GLOB_SEGMENT) return null;
  const escapes = path.sep === "/";
  let lastClose = -1;
  for (let i = 0; i < segment.length; i++) {
    if (escapes && segment[i] === "\\") i++;
    else if (segment[i] === "]") lastClose = i;
  }
  const tokens: GlobToken[] = [];
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === "*") {
      tokens.push({ kind: "star" });
      continue;
    }
    if (c === "?") {
      tokens.push({ kind: "one", test: () => true });
      continue;
    }
    if (c === "[") {
      const bracket = globClass(segment, i, escapes, lastClose);
      if (bracket === undefined) return null;
      if (bracket) {
        tokens.push({ kind: "one", test: bracket.test });
        i = bracket.close;
        continue;
      }
    }
    const literal = escapes && c === "\\" && i + 1 < segment.length ? segment[++i]! : c;
    tokens.push({ kind: "one", test: (ch) => ch === literal, literal });
  }
  return tokens;
}

function globMatches(name: string, tokens: readonly GlobToken[]): boolean {
  // A leading dot is matched only by a dot written as such.
  const first = tokens[0];
  if (name.startsWith(".") && !(first?.kind === "one" && first.literal === ".")) return false;
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

function joinRaw(dir: string, name: string): string {
  return dir.endsWith("/") || dir.endsWith(path.sep) ? dir + name : `${dir}${path.sep}${name}`;
}

/** A directory's names, up to what the walk has left to read; null once that runs out. */
async function readDirBudgeted(dir: string, ctx: WalkContext): Promise<string[] | null> {
  const names: string[] = [];
  try {
    for await (const entry of await fs.opendir(dir)) {
      if (ctx.stopped) return null;
      if (++ctx.dirEntries > MAX_DIR_ENTRIES) {
        halt(ctx);
        return null;
      }
      names.push(entry.name);
    }
  } catch (error) {
    if (!isMissing(error)) ctx.complete = false;
  }
  return names;
}

/** The files an Include pattern names, in glob(3)'s byte order. */
async function expandInclude(pattern: string, ctx: WalkContext): Promise<string[]> {
  const { root } = path.parse(pattern);
  const separators = path.sep === "/" ? /\/+/ : /[\\/]+/;
  // On POSIX a backslash escapes; only on Windows does it end a directory name.
  const trailingSlash =
    (path.sep === "/" ? pattern.endsWith("/") : /[\\/]$/.test(pattern)) &&
    pattern.length > root.length;
  const segments = pattern.slice(root.length).split(separators).filter(Boolean);
  let paths = [root];
  let magic = false;
  for (const segment of segments) {
    const tokens = globTokens(segment);
    if (tokens === null) {
      ctx.complete = false;
      return [];
    }
    if (tokens.every((token) => token.kind === "one" && token.literal !== undefined)) {
      const literal = tokens.map((token) => (token.kind === "one" ? token.literal : "")).join("");
      paths = paths.map((dir) => joinRaw(dir, literal));
      continue;
    }
    magic = true;
    const next: string[] = [];
    for (const dir of paths) {
      const names = await readDirBudgeted(dir, ctx);
      if (names === null) return [];
      for (const name of names) if (globMatches(name, tokens)) next.push(joinRaw(dir, name));
    }
    paths = next;
  }
  // A trailing slash asks for a directory; stat then refuses a file named that way, as glob does.
  if (trailingSlash) paths = paths.map((p) => `${p}/`);
  if (!magic) return paths;
  // Every match counts toward the stamp, so a file newly matching the pattern changes it.
  ctx.stamps.push(`glob\t${pattern}`);
  return paths.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

/** Opening a pipe for reading waits for a writer; non-blocking, it can't hold a worker. */
const READ_FLAGS =
  process.platform === "win32" ? "r" : fsConstants.O_RDONLY | fsConstants.O_NONBLOCK;

/**
 * A regular file's bytes, or null when it holds `limit` bytes or more (it grew
 * since it was stat'ed) or is no longer a regular file.
 */
async function readBelow(file: string, limit: number): Promise<Buffer | null> {
  const handle = await fs.open(file, READ_FLAGS);
  try {
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(limit);
    let length = 0;
    while (length < limit) {
      const { bytesRead } = await handle.read(buffer, length, limit - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return length >= limit ? null : buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

function collectAliases(
  patterns: readonly string[],
  gates: readonly (readonly string[])[],
  ctx: WalkContext
): void {
  // A literal on its own Host line matches it; only that line's negations can still rule it out.
  const negations = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  const patternChars = (list: readonly string[]) => list.reduce((sum, p) => sum + p.length + 1, 0);
  // Matching is at worst the name's length times the pattern's, so that's what each check costs.
  let cost: number | undefined;
  for (const alias of patterns) {
    if (ctx.aliases.length >= MAX_ALIASES) return;
    if (ctx.aliasSet.has(alias) || !isListableAlias(alias)) continue;
    cost ??= patternChars(negations) + gates.reduce((sum, gate) => sum + patternChars(gate), 0);
    ctx.work += (alias.length + 1) * cost;
    if (ctx.work > MAX_MATCH_WORK) return halt(ctx);
    if (negations.some((negation) => matchHostPattern(alias, negation))) continue;
    // An included host applies only to names its Includes' own Host lines match too.
    if (!gates.every((gate) => hostLineMatches(alias, gate))) continue;
    ctx.aliasSet.add(alias);
    ctx.aliases.push(alias);
  }
}

async function walkFile(
  file: string,
  system: boolean,
  gates: readonly (readonly string[])[],
  depth: number,
  ancestry: ReadonlySet<string>,
  ctx: WalkContext
): Promise<void> {
  if (outOfTime(ctx)) return;
  if (++ctx.files > MAX_FILES) return halt(ctx);
  let stat: Stats;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (!isMissing(error)) ctx.complete = false;
    ctx.stamps.push(`${file}\t-`);
    return;
  }
  if (ctx.stopped) return;
  const identity = `${stat.dev}:${stat.ino}`;
  ctx.stamps.push(`${file}\t${identity}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
  if (!stat.isFile()) {
    // ssh reads a pipe's bytes, which no stat vouches for.
    if (stat.isFIFO()) ctx.complete = false;
    return;
  }
  if (ancestry.has(identity)) {
    // ssh recurses until its depth limit refuses the whole config.
    ctx.complete = false;
    return;
  }
  if (stat.size > MAX_FILE_BYTES) {
    ctx.complete = false;
    return;
  }
  let bytes: Buffer | null;
  try {
    bytes = await readBelow(file, stat.size + 1);
  } catch {
    bytes = null;
  }
  if (ctx.stopped) return;
  if (bytes === null) {
    ctx.complete = false;
    return;
  }
  // The bytes too: two same-sized edits inside one timestamp tick otherwise look alike.
  ctx.stamps.push(crypto.createHash("sha256").update(bytes).digest("hex"));
  const lineage = new Set(ancestry).add(identity);
  // Until its first Host or Match, a file is in whatever block included it.
  let block: Block = { kind: "all" };
  for (const raw of bytes.toString("utf8").split("\n")) {
    if (outOfTime(ctx)) return;
    const line = splitConfigLine(raw);
    if (!line) continue;
    if (line.keyword === "host") {
      const args = line.args;
      block =
        args && args.length > 0 && !args.includes("")
          ? { kind: "host", patterns: args }
          : { kind: "never" };
      if (ctx.mode === "aliases" && block.kind === "host") {
        collectAliases(block.patterns, gates, ctx);
        if (ctx.stopped) return;
      }
    } else if (line.keyword === "match") {
      const args = line.args;
      block =
        !args || args.length === 0
          ? { kind: "never" }
          : args.length === 1 && args[0]!.toLowerCase() === "all"
            ? { kind: "all" }
            : { kind: "match" };
    } else if (line.keyword === "include" && line.args) {
      // Listing never decides a Match; a route's files follow every Include, whatever block it sits in.
      if (ctx.mode === "aliases" && (block.kind === "match" || block.kind === "never")) continue;
      const inner = block.kind === "host" ? [...gates, block.patterns] : gates;
      for (const arg of line.args) {
        // ssh refuses the line at an empty path.
        if (arg === "") break;
        const pattern = includePattern(arg, system, ctx.home);
        if (pattern === null) {
          // Nothing this can resolve, so a route can't be known to stay as it is.
          ctx.complete = false;
          continue;
        }
        const files = await expandInclude(pattern, ctx);
        if (ctx.stopped) return;
        for (const included of files) {
          if (depth + 1 > MAX_INCLUDE_DEPTH) {
            ctx.complete = false;
            break;
          }
          await walkFile(included, system, inner, depth + 1, lineage, ctx);
          if (ctx.stopped) return;
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
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const ctx: WalkContext = {
    mode,
    home: options.home ?? os.homedir(),
    deadlineAt: Date.now() + (options.deadlineMs ?? WALK_DEADLINE_MS),
    stopped: false,
    settle,
    files: 0,
    dirEntries: 0,
    work: 0,
    complete: true,
    aliases: [],
    aliasSet: new Set(),
    stamps: [],
  };
  const stop = () => halt(ctx);
  if (options.signal?.aborted) {
    stop();
    return ctx;
  }
  options.signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, Math.max(0, ctx.deadlineAt - Date.now()));
  const run = (async () => {
    for (const root of roots) {
      await walkFile(root.path, root.system === true, [], 0, new Set(), ctx);
      if (ctx.stopped) return;
    }
  })().catch(() => {
    ctx.complete = false;
  });
  try {
    // A read that hangs can't be cancelled; it is left to finish on its own and its result dropped.
    await Promise.race([run, settled]);
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
 * Include (whatever block it sits in), its bytes, and what each Include
 * pattern matched. A remembered route is only good while this is unchanged.
 * A walk that can't vouch for ssh's view (cut short, an Include naming the
 * destination, an I/O error) gives a stamp no later one equals, so the route
 * is never reused on a partial view of the config.
 */
export async function sshConfigStamp(
  roots: readonly SshConfigRoot[],
  options: SshConfigWalkOptions = {}
): Promise<string> {
  const ctx = await walk(roots, "dependencies", options);
  if (!ctx.complete) return `incomplete:${++incompleteStamps}`;
  return crypto.createHash("sha256").update(ctx.stamps.join("\n")).digest("hex");
}
