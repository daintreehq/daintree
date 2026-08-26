import { describe, expect, it, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { CHANNELS } from "../../../ipc/channels.js";
import { ASSISTANT_HOST_METHOD_CHANNELS } from "../../../ipc/handlers/assistantHost.preload.js";
import { HELP_ASSISTANT_METHOD_CHANNELS } from "../../../ipc/handlers/helpAssistant.preload.js";
import { assistantChildEnv, ENGINE_CONTROLLED_ENV } from "../assistantChildEnv.js";

/**
 * The account belongs to the CLI, and Daintree keeps none of it.
 *
 * The engine signs in, holds the tokens, chooses the endpoint and knows what the plan
 * entitles — Daintree starts a process, moves frames, and renders what comes back. That
 * arrangement was arrived at by DELETING the other one: a Settings sign-in form, an
 * access/refresh token pair, an entitlement cache, a Supabase subject, and a backend-URL
 * preference that had to agree with all of them.
 *
 * Nothing guarded it. `assistantHost.ownership.test.ts` is about SESSION ownership —
 * which window may drive which engine process — and the only account-boundary check that
 * exists is an e2e one that opens Settings and looks for controls. So the boundary was
 * held by nobody noticing, and the regression it invites is not malice: it is someone
 * caching the plan so the footer can render without waiting for the engine, or persisting
 * the endpoint so the masthead is right on the first frame.
 *
 * The assertions are over STRUCTURE where structure exists — the channel registry, the
 * environment the child is actually handed, the declared key lists — because a word can be
 * renamed while a credential still has to arrive through a channel, be persisted under a
 * key, or be handed over as a variable.
 *
 * ## What this does NOT catch, so nobody reads a pass as more than it is
 *
 * - A credential smuggled through an EXISTING channel's payload. `assistant-host:send`
 *   already carries arbitrary engine commands and `host:ready` already carries masthead
 *   facts; neither is inspected here.
 * - An account field added to `AssistantSessionState` but not to the `EMPTY` literal, or
 *   nested inside one of its objects — the parser reads top-level keys only.
 * - A Settings control that drives the engine's own `/login` over the existing transport.
 *   That one is deliberate rather than a hole: the boundary is about who OWNS the account,
 *   and an affordance that hands the question to the engine owns nothing. Whether such a
 *   control belongs in Settings is a UI question, and it stays guarded where it happens —
 *   `e2e/full/panels/assistant-native-panel.spec.ts`.
 * - Anything a new store or service does. The scans below are scoped to the modules the
 *   assistant owns today.
 *
 * ## Out of scope on purpose
 *
 * `app-agent:*` is a REAL credential IPC with a persisted key, belonging to the separate
 * BYO-key "app agent" feature. Every check here is scoped to the assistant's own surface,
 * so the app agent can neither fail these nor satisfy them — and one check asserts the
 * assistant does not reach for it, which is how a credential store gets acquired by
 * borrowing rather than by being built.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const HOST_DIR = path.resolve(__dirname, "..");

/**
 * The whole renderer↔main surface the assistant has, and what each channel is for.
 *
 * Keyed by the registry constants rather than by the channel strings: renaming a channel's
 * value is a refactor, and a test that has to be edited alongside one is asserting the
 * spelling instead of the shape. A channel ADDED to the assistant's surface lands here
 * with a reason or fails — which is the point, because state that has to survive a restart
 * or cross the process boundary has to come through one of these.
 */
const ASSISTANT_CHANNEL_SURFACE = new Map<string, string>([
  [CHANNELS.ASSISTANT_HOST_START, "Starts an engine process for this window. Transport."],
  [CHANNELS.ASSISTANT_HOST_SEND, "One typed command into the running engine. Transport."],
  [CHANNELS.ASSISTANT_HOST_STOP, "Ends the session. Transport."],
  [CHANNELS.ASSISTANT_HOST_EVENT, "One validated protocol event back. Transport."],
  [CHANNELS.ASSISTANT_HOST_GAP, "A hole in the engine's sequence. Transport integrity."],
  [CHANNELS.ASSISTANT_HOST_EXIT, "The engine process ended. Lifecycle."],
  [
    CHANNELS.HELP_ASSISTANT_GET_SETTINGS,
    "Behaviour preferences — tier, tool permissions, model, audit retention. Agent, " +
      "model, capability and approval settings are not authentication.",
  ],
  [CHANNELS.HELP_ASSISTANT_SET_SETTINGS, "Writes the same behaviour preferences."],
  [
    CHANNELS.HELP_ASSISTANT_GET_LIVE_SESSION_STATUS,
    "What the MCP control plane is granting this session right now. Daintree's own " +
      "capability state, not the engine's account.",
  ],
  [
    CHANNELS.HELP_OPEN_ASSISTANT_CONTENT_FOLDER,
    "Reveals the assistant's content directory in the OS file manager. A path, not a " +
      "credential.",
  ],
]);

/**
 * Channels named for the assistant, however they are spelled.
 *
 * Matched on the whole value rather than on a namespace prefix, so a regression that
 * introduces its own namespace — `assistant-auth:sign-in` — is caught by the same check
 * as one that adds to an existing one.
 */
function assistantChannels(): string[] {
  return Object.values(CHANNELS).filter((channel) => /assistant/i.test(channel));
}

/**
 * Engine variables that decide WHO a session is and WHERE it talks. Daintree must set none
 * of them and inherit none of them: setting one is the deleted design coming back as an
 * environment variable, and inheriting one is a shell profile quietly outranking whatever
 * the CLI decided.
 */
const OWNERSHIP_DECIDING_ENV = new Map<string, string>([
  ["DAINTREE_API_KEY", "overrides account sign-in for the whole session"],
  ["DAINTREE_BACKEND_URL", "pins the endpoint, and pinned means /backend cannot move it"],
  ["DAINTREE_ALLOW_INSECURE_BACKEND", "lifts the TLS floor on whatever endpoint is stored"],
  ["DAINTREE_ASSISTANT_STATE_DIR", "decides which sign-in the session runs under"],
  ["DAINTREE_ASSISTANT_SOCKET_DIR", "decides which supervisor the session can find"],
  ["DAINTREE_ROUTING_ONLY", "endpoint selection under another name"],
  ["DAINTREE_ROUTING_IGNORE", "endpoint selection under another name"],
]);

/**
 * Vocabulary an account of Daintree's own would arrive under.
 *
 * The weak instrument in this file, and confined to two named declarations in two named
 * files rather than let loose over source text. The structural version is not available
 * from here: both key lists describe a TypeScript type, erased before any test can see it,
 * and the runtime objects that would answer instead (`ASSISTANT_EMPTY_STATE`, the settings
 * defaults) live under `src/` and in a module that opens the electron-store on import —
 * neither reachable from the electron TypeScript project. So the declaration IS the
 * artifact. It reads keys, not the prose around them: a comment mentioning tokens does not
 * fail it, and a field called `accessToken` does.
 *
 * `backend` and `endpoint` are in the list because a REMEMBERED endpoint is the deleted
 * design's other half; the renderer's transient `backend` string is excused by name below,
 * with the reason.
 */
const ACCOUNT_WORDS = new Set([
  "account",
  "auth",
  "backend",
  "bearer",
  "billing",
  "credential",
  "credentials",
  "credits",
  "email",
  "endpoint",
  "entitlement",
  "entitlements",
  "license",
  "logged",
  "login",
  "logout",
  "oauth",
  "password",
  "plan",
  "quota",
  "secret",
  "sign",
  "signin",
  "signed",
  "subject",
  "subscription",
  "supabase",
  "token",
]);

/** Spellings that survive camel-case splitting as one run of letters. */
const ACCOUNT_SUBSTRINGS = ["apikey", "supporthash", "baseurl", "serverurl"];

/** Session-state fields that carry an account word and are allowed anyway, with why. */
const SESSION_STATE_ALLOWED = new Map<string, string>([
  [
    "backend",
    "Masthead text the engine reports in `host:ready` — what IT says it is talking to, " +
      "rendered and thrown away with the session. Not persisted, never read back, and " +
      "nothing decides anything from it. A stored preference here would be the deleted " +
      "backend picker.",
  ],
]);

function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isAccountKey(key: string): boolean {
  const flat = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (ACCOUNT_SUBSTRINGS.some((needle) => flat.includes(needle))) return true;
  return words(key).some((word) => ACCOUNT_WORDS.has(word));
}

function read(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

/**
 * Source with comment lines removed, so prose about a variable is never read as code.
 *
 * Line-based, not a lexer: an inline trailing comment survives. That is the right way for
 * it to be wrong — it can produce a false FAILURE a human resolves in a minute, never a
 * false pass.
 */
function withoutComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");
}

/**
 * The block a named declaration opens, from its first bracket to the matching one.
 *
 * Fails loudly rather than returning empty when the declaration has moved or been renamed:
 * a silently empty block turns every assertion below it into a pass, which is what makes a
 * source-reading contract worthless. Anchored to the start of a line so a mention in prose
 * cannot be mistaken for the declaration.
 */
function declarationBlock(source: string, declaration: string, open: "{" | "["): string {
  const anchored = new RegExp(`^${declaration.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
  const match = anchored.exec(source);
  expect(
    match,
    `\`${declaration}\` no longer starts a line here — repoint this contract at whatever ` +
      `replaced it rather than deleting the check`
  ).not.toBeNull();
  const from = source.indexOf(open, match?.index ?? 0);
  expect(from, `\`${declaration}\` opens no \`${open}\``).toBeGreaterThanOrEqual(0);
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return source.slice(from + 1, i);
    }
  }
  throw new Error(`unterminated ${declaration}`);
}

/** Top-level keys of an object literal block. Nested objects are NOT descended into. */
function topLevelKeys(block: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (depth === 0) {
      const match = /^["']?([A-Za-z_$][\w$]*)["']?\s*:/.exec(trimmed);
      if (match?.[1]) keys.push(match[1]);
    }
    for (const ch of line) {
      if (ch === "{" || ch === "[" || ch === "(") depth += 1;
      else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    }
  }
  return keys;
}

function tsFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .map((file) => path.join(dir, file));
}

/** The host's own modules — everything that assembles or passes the child environment. */
function hostSourceFiles(): string[] {
  return tsFilesIn(HOST_DIR);
}

/** Every non-test module the assistant owns, main and renderer, by absolute path. */
function assistantSourceFiles(): string[] {
  const panelDir = path.join(REPO_ROOT, "src/components/AssistantPanel");
  return [
    ...hostSourceFiles(),
    ...[
      "electron/ipc/handlers/assistantHost.ts",
      "electron/ipc/handlers/assistantHost.preload.ts",
      "electron/ipc/handlers/helpAssistant.ts",
      "electron/ipc/handlers/helpAssistant.preload.ts",
      "shared/types/ipc/assistantHost.ts",
      "src/store/assistantStore.ts",
      "src/components/Settings/DaintreeAssistantSettingsTab.tsx",
    ].map((relative) => path.join(REPO_ROOT, relative)),
    ...readdirSync(panelDir, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
      .map((file) => path.join(panelDir, file)),
  ].filter((file) => !file.includes("__tests__"));
}

const relative = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join("/");

describe("assistant account-ownership boundary", () => {
  describe("the IPC surface", () => {
    it("carries transport and behaviour, and nothing that names a credential", () => {
      const unaccounted = assistantChannels().filter(
        (channel) => !ASSISTANT_CHANNEL_SURFACE.has(channel)
      );
      expect(
        unaccounted,
        `assistant channels with no entry in ASSISTANT_CHANNEL_SURFACE:\n  ${unaccounted.join("\n  ")}\n` +
          `If it moves frames or behaviour settings, add it with the reason. If it carries ` +
          `an account, a token or an endpoint, it is the boundary this file exists to hold.`
      ).toEqual([]);
    });

    it("has no stale entries in its own allowlist", () => {
      // The failure this mirrors from the app's other contract guards: an entry outlives
      // the channel it excused, and the allowlist stops describing anything.
      const live = new Set<string>(assistantChannels());
      const stale = [...ASSISTANT_CHANNEL_SURFACE.keys()].filter((channel) => !live.has(channel));
      expect(
        stale,
        `allowlist entries for channels that no longer exist: ${stale.join(", ")}`
      ).toEqual([]);
    });

    it("exposes nothing to the renderer that is not on that surface", () => {
      // The registry is the inventory; the preload bindings are what a renderer can
      // actually call. A method wired to an off-registry channel would be invisible to the
      // check above.
      const exposed = [
        ...Object.values(ASSISTANT_HOST_METHOD_CHANNELS),
        ...Object.values(HELP_ASSISTANT_METHOD_CHANNELS),
      ];
      const offRegistry = exposed.filter((channel) => !ASSISTANT_CHANNEL_SURFACE.has(channel));
      expect(
        offRegistry,
        `renderer-callable assistant methods off the declared surface: ${offRegistry.join(", ")}`
      ).toEqual([]);
    });

    it("reaches none of the app agent's credential IPC", () => {
      // The app agent is a separate feature with a real persisted key and real key-test
      // channels. Nothing on the assistant's side references it, and that is what stops
      // the assistant quietly acquiring a credential store by borrowing one. Comments are
      // stripped first: mentioning the app agent in prose — this file does — is not
      // reaching for it.
      const borrowers = assistantSourceFiles().filter((file) =>
        /\bapp-?agent/i.test(withoutComments(readFileSync(file, "utf8")).replace(/[_.]/g, "-"))
      );
      expect(
        borrowers,
        `assistant sources referencing the app agent: ${borrowers.map(relative).join(", ")}`
      ).toEqual([]);
    });
  });

  describe("the child environment", () => {
    const added: string[] = [];

    afterEach(() => {
      for (const name of added.splice(0)) delete process.env[name];
    });

    it("sets nothing that decides the account or the endpoint", () => {
      // Read from source rather than from a spawned service: the values are assembled
      // inside `startSession` from a live window, an MCP binding and a resolved binary,
      // none of which a unit test has. What matters is not what one launch computes but
      // which variables the host is in the business of setting at all.
      //
      // It sees literal assignment — `DAINTREE_X:`, `"DAINTREE_X":`, `env.DAINTREE_X =`.
      // A computed key would slip past, and no rewrite of this makes it not so; the
      // narrower claim it can honestly support is that the host does not name one.
      const assigned = new Set<string>();
      for (const file of hostSourceFiles()) {
        const source = withoutComments(readFileSync(file, "utf8"));
        for (const match of source.matchAll(/["']?\b(DAINTREE_[A-Z0-9_]+)["']?\s*(?::|=[^=])/g)) {
          if (match[1]) assigned.add(match[1]);
        }
      }
      // The scanner's own canary, from two artifacts that move independently: the host
      // re-sets several of the names it strips (the tier, the MCP pair) from authoritative
      // sources, so an empty intersection means the scan has stopped matching code rather
      // than that the host stopped setting anything.
      expect(
        ENGINE_CONTROLLED_ENV.filter((name) => assigned.has(name)),
        "the host sets none of the variables it strips — the source scan has gone blind"
      ).not.toEqual([]);

      const overreach = [...OWNERSHIP_DECIDING_ENV.keys()].filter((name) => assigned.has(name));
      expect(
        overreach,
        `the host sets a variable that decides ownership:\n  ` +
          overreach.map((name) => `${name} — ${OWNERSHIP_DECIDING_ENV.get(name)}`).join("\n  ")
      ).toEqual([]);
    });

    it("lets none of them through from the environment Daintree was launched in", () => {
      for (const name of OWNERSHIP_DECIDING_ENV.keys()) {
        added.push(name);
        process.env[name] = "inherited-from-a-shell-profile";
      }

      const env = assistantChildEnv();

      const survivors = [...OWNERSHIP_DECIDING_ENV.keys()].filter(
        (name) => env[name] !== undefined
      );
      expect(
        survivors,
        `an inherited variable reached the engine:\n  ` +
          survivors.map((name) => `${name} — ${OWNERSHIP_DECIDING_ENV.get(name)}`).join("\n  ")
      ).toEqual([]);
    });
  });

  describe("what Daintree remembers", () => {
    it("persists no assistant setting that is an account, a credential or an endpoint", () => {
      // `HELP_ASSISTANT_KEYS` is the write gate: `setSettings` drops any field not in it,
      // so it is the complete set of assistant preferences that can reach disk. A backend
      // URL preference or a stored token has to appear here to survive a restart.
      const block = declarationBlock(
        read("electron/ipc/handlers/helpAssistant.ts"),
        "const HELP_ASSISTANT_KEYS",
        "["
      );
      const keys = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
      expect(keys.length, "the persisted-settings key list came back empty").toBeGreaterThan(0);

      const offenders = keys.filter(isAccountKey);
      expect(
        offenders,
        `persisted assistant settings naming an account or an endpoint: ${offenders.join(", ")}`
      ).toEqual([]);
    });

    it("holds no account fact in the renderer's session state", () => {
      // `EMPTY` is the shape every session starts from, so it is the store's declared field
      // set — a plan, a subject or a support hash has to be a field on it to be rendered
      // from.
      const keys = sessionStateKeys();
      expect(keys.length, "the session-state field list came back empty").toBeGreaterThan(0);

      const offenders = keys.filter((key) => isAccountKey(key) && !SESSION_STATE_ALLOWED.has(key));
      expect(
        offenders,
        `session-state fields naming an account or an endpoint: ${offenders.join(", ")}`
      ).toEqual([]);
    });

    it("has no stale exception in its session-state allowlist", () => {
      const keys = new Set(sessionStateKeys());
      const stale = [...SESSION_STATE_ALLOWED.keys()].filter((key) => !keys.has(key));
      expect(stale, `exceptions for fields that no longer exist: ${stale.join(", ")}`).toEqual([]);
    });
  });
});

function sessionStateKeys(): string[] {
  return topLevelKeys(
    declarationBlock(read("src/store/assistantStore.ts"), "const EMPTY: AssistantSessionState", "{")
  );
}
