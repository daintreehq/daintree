import { describe, expect, it, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
 * ## The scanners fail closed
 *
 * The source-reading checks parse the TypeScript AST rather than counting brackets, and
 * they THROW on any shape they cannot account for — a spread, a computed key, an
 * unexpected declaration form. That is the difference between a guard and a decoration:
 * the first version of this file counted brackets, and both of these slipped past it while
 * still returning a non-empty key list, so the "did the scan find anything" health check
 * stayed green while the boundary was broken.
 *
 *     const EMPTY: AssistantSessionState = {
 *       sessionId: null,
 *       // } fields continued below
 *       accessToken: null,        // never seen: the comment closed the block
 *     };
 *
 *     const EMPTY: AssistantSessionState = {
 *       sessionId: null,
 *       ...ACCOUNT_STATE,         // never seen: the spread was skipped
 *     };
 *
 * `scanner fail-closed fixtures` below feeds both shapes, and several others, back through
 * the scanners and asserts they now fail. A scanner that cannot be trusted to see
 * everything must not be trusted to report nothing.
 *
 * ## What this still does NOT catch, so nobody reads a pass as more than it is
 *
 * - A credential smuggled through an EXISTING channel's payload. `assistant-host:send`
 *   already carries arbitrary engine commands and `host:ready` already carries masthead
 *   facts; neither is inspected here.
 * - An account field added to `AssistantSessionState` but never to the `EMPTY` literal, or
 *   one nested inside a field that IS on it — the key scan reads the top level and does
 *   not descend.
 * - A Settings control that drives the engine's own `/login` over the existing transport.
 *   That one is deliberate rather than a hole: the boundary is about who OWNS the account,
 *   and an affordance that hands the question to the engine owns nothing. Whether such a
 *   control belongs in Settings is a UI question, and it stays guarded where it happens —
 *   `e2e/full/panels/assistant-native-panel.spec.ts`.
 * - Anything a new store or service does. The scans are scoped to the modules the
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

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../../..");
const HOST_DIR = path.resolve(TEST_DIR, "..");

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
    CHANNELS.ASSISTANT_HOST_PEER_PROMPT,
    "A prompt another window sent to the engine this view also watches. Conversation " +
      "text only — the engine never echoes prompts, so this is what keeps two windows " +
      "on one project from diverging. Carries no account, token or endpoint.",
  ],
  [
    CHANNELS.ASSISTANT_TIMERS_LIST,
    "A project's scheduled timers, read over the supervisor daemon's control socket " +
      "when no engine is running. A project id in, schedule rows out — no account, no " +
      "token, and no endpoint: the socket path is learned from the engine itself and " +
      "never crosses to the renderer.",
  ],
  [
    CHANNELS.ASSISTANT_TIMERS_CANCEL,
    "Retires one timer over the same socket. A timer id in, an outcome out. The " +
      "AUTHORITY it withdraws is the engine's own automation grant, which is scoped " +
      "to a timer actor and is not an account credential.",
  ],
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
 * `tsc -p electron/tsconfig.json` rejects the first outright (TS6307). So the declaration
 * IS the artifact. It reads keys, not the prose around them: a comment mentioning tokens
 * does not fail it, and a field called `accessToken` does.
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
  "identity",
  "license",
  "logged",
  "login",
  "logout",
  "oauth",
  "password",
  "plan",
  "principal",
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
const ACCOUNT_SUBSTRINGS = ["apikey", "supporthash", "baseurl", "serverurl", "userid", "accountid"];

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
 * The scanner met a shape it cannot account for.
 *
 * Always a hard stop, never a shorter list. Everything below reasons from "these are the
 * keys" / "these are the variables", and a scanner that quietly drops what it did not
 * understand turns every one of those into a claim it has not checked.
 */
function outgrew(what: string, detail: string): never {
  throw new Error(
    `${what}: ${detail}. The source has outgrown this scanner — teach it the new shape ` +
      `rather than narrowing what it looks at.`
  );
}

function parseText(text: string, name = "fixture.ts"): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function parseSource(relativePath: string): ts.SourceFile {
  return parseText(read(relativePath), relativePath);
}

/** `x as const`, `x satisfies T`, `(x)` — the wrappers a declaration may be dressed in. */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/** The initializer of a top-level `const <name> = …`, or a hard stop. */
function declarationInitializer(source: ts.SourceFile, name: string): ts.Expression {
  const found: ts.Expression[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      if (!declaration.initializer) {
        outgrew(name, "the declaration has no initializer");
      }
      found.push(declaration.initializer);
    }
  }
  if (found.length === 0) {
    outgrew(name, `no top-level \`const ${name}\` in ${source.fileName}`);
  }
  if (found.length > 1) {
    outgrew(name, `declared ${found.length} times, so which one this reads is ambiguous`);
  }
  return unwrap(found[0] as ts.Expression);
}

/**
 * Top-level keys of an object literal. Nested objects are not descended into — but a
 * spread, a computed key or an accessor stops the scan rather than being skipped, because
 * each of those is a way for a field to exist without appearing here.
 */
function objectLiteralKeys(expression: ts.Expression, what: string): string[] {
  if (!ts.isObjectLiteralExpression(expression)) {
    outgrew(what, `expected an object literal, found ${ts.SyntaxKind[expression.kind]}`);
  }
  const keys: string[] = [];
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      outgrew(what, "a spread hides whatever it carries from a key scan");
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      keys.push(property.name.text);
      continue;
    }
    if (!ts.isPropertyAssignment(property)) {
      outgrew(what, `a ${ts.SyntaxKind[property.kind]} member is not a plain field`);
    }
    const { name } = property;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      keys.push(name.text);
      continue;
    }
    outgrew(what, "a computed key cannot be read statically");
  }
  return keys;
}

/** Every element of a string-literal array, or a hard stop. */
function stringArrayElements(expression: ts.Expression, what: string): string[] {
  if (!ts.isArrayLiteralExpression(expression)) {
    outgrew(what, `expected an array literal, found ${ts.SyntaxKind[expression.kind]}`);
  }
  return expression.elements.map((element) => {
    if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
      return element.text;
    }
    return outgrew(what, `a ${ts.SyntaxKind[element.kind]} element is not a literal name`);
  });
}

/** The one spread the child-environment literal is allowed to carry. */
const INHERITED_ENV_HELPER = "assistantChildEnv";

/**
 * `DAINTREE_*` names written into a child-environment object literal.
 *
 * Modelled shape by shape rather than pattern-matched out of the text: the literal is
 * built from conditional spreads, so anything this does not recognise is a new way of
 * putting a variable into the child and has to be read by a human before the check below
 * can mean anything.
 */
function envObjectNames(expression: ts.Expression, what: string, into: Set<string>): void {
  if (!ts.isObjectLiteralExpression(expression)) {
    outgrew(what, `expected an object literal, found ${ts.SyntaxKind[expression.kind]}`);
  }
  for (const property of expression.properties) {
    if (ts.isPropertyAssignment(property)) {
      const { name } = property;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
        if (name.text.startsWith("DAINTREE_")) into.add(name.text);
        continue;
      }
      outgrew(what, "a computed key could name any variable at all");
    }
    if (!ts.isSpreadAssignment(property)) {
      outgrew(what, `a ${ts.SyntaxKind[property.kind]} member is not a plain field`);
    }
    const spread = unwrap(property.expression);
    if (
      ts.isCallExpression(spread) &&
      ts.isIdentifier(spread.expression) &&
      spread.expression.text === INHERITED_ENV_HELPER
    ) {
      // The inherited environment minus the strip list. Its contents are the subject of
      // `assistantChildEnv.test.ts` and of the inheritance check below.
      continue;
    }
    if (ts.isConditionalExpression(spread)) {
      envObjectNames(unwrap(spread.whenTrue), what, into);
      envObjectNames(unwrap(spread.whenFalse), what, into);
      continue;
    }
    if (ts.isObjectLiteralExpression(spread)) {
      envObjectNames(spread, what, into);
      continue;
    }
    // A call to a helper declared in the host itself — `...namespaceEnv(slot)`. Its
    // RETURNS are modelled, exactly as an inline conditional spread would be, so this
    // reads the real shape rather than trusting a name. A helper the scanner cannot
    // find, or one that returns something it cannot read, still stops the run.
    if (ts.isCallExpression(spread) && ts.isIdentifier(spread.expression)) {
      const helper = spread.expression.text;
      const declaration = hostFunction(helper);
      if (declaration) {
        for (const returned of returnExpressions(declaration, `${what} → ${helper}()`)) {
          envExpressionNames(returned, `${what} → ${helper}()`, into);
        }
        continue;
      }
    }
    outgrew(what, "a spread of something this cannot read could carry any variable");
  }
}

/** An env fragment as an expression: an object literal, or a conditional over them. */
function envExpressionNames(expression: ts.Expression, what: string, into: Set<string>): void {
  const node = unwrap(expression);
  if (ts.isConditionalExpression(node)) {
    envExpressionNames(node.whenTrue, what, into);
    envExpressionNames(node.whenFalse, what, into);
    return;
  }
  envObjectNames(node, what, into);
}

/** The host's own declaration of `name`, if it has one. */
function hostFunction(name: string): ts.FunctionDeclaration | null {
  for (const file of hostSourceFiles()) {
    const source = parseText(readFileSync(file, "utf8"), file);
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
    }
  }
  return null;
}

/** Every expression a function returns. A bare `return;` is a shape this cannot read. */
function returnExpressions(fn: ts.FunctionDeclaration, what: string): ts.Expression[] {
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) {
      if (!node.expression) outgrew(what, "a bare `return` leaves the fragment unknown");
      out.push(node.expression);
      return;
    }
    // Not into nested functions: their returns belong to them, not to this one.
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))
      return;
    ts.forEachChild(node, visit);
  };
  if (!fn.body) outgrew(what, "an overload signature has no body to read");
  ts.forEachChild(fn.body, visit);
  if (out.length === 0) outgrew(what, "the helper returns nothing this could model");
  return out;
}

/** Every `env: { … }` literal in the host's own modules, read shape by shape. */
function envLiteralNames(): Set<string> {
  const names = new Set<string>();
  let literals = 0;
  for (const file of hostSourceFiles()) {
    const source = parseText(readFileSync(file, "utf8"), file);
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "env" &&
        ts.isObjectLiteralExpression(unwrap(node.initializer))
      ) {
        literals += 1;
        envObjectNames(unwrap(node.initializer), `${relative(file)} env literal`, names);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (literals === 0) {
    outgrew("child environment", "no `env: { … }` literal in the host — it has moved");
  }
  return names;
}

/**
 * `DAINTREE_*` names assigned anywhere in the host, as a supplement to the modelled
 * literal above — a field key or an `env.DAINTREE_X = …` write outside it.
 */
function daintreeNamesAnywhere(): Set<string> {
  const names = new Set<string>();
  for (const file of hostSourceFiles()) {
    const source = parseText(readFileSync(file, "utf8"), file);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        const { name } = node;
        if (
          (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
          name.text.startsWith("DAINTREE_")
        ) {
          names.add(name.text);
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const target = node.left;
        if (ts.isPropertyAccessExpression(target) && target.name.text.startsWith("DAINTREE_")) {
          names.add(target.name.text);
        }
        if (
          ts.isElementAccessExpression(target) &&
          ts.isStringLiteral(target.argumentExpression) &&
          target.argumentExpression.text.startsWith("DAINTREE_")
        ) {
          names.add(target.argumentExpression.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return names;
}

/**
 * Source with comment lines removed, for the one text scan left.
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

/** The host's own modules — everything that assembles or passes the child environment. */
function hostSourceFiles(): string[] {
  return readdirSync(HOST_DIR)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .map((file) => path.join(HOST_DIR, file));
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
    ].map((file) => path.join(REPO_ROOT, file)),
    ...readdirSync(panelDir, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
      .map((file) => path.join(panelDir, file)),
  ].filter((file) => !file.includes("__tests__"));
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function sessionStateKeys(source: ts.SourceFile): string[] {
  return objectLiteralKeys(declarationInitializer(source, "EMPTY"), "assistant session state");
}

function persistedSettingKeys(source: ts.SourceFile): string[] {
  return stringArrayElements(
    declarationInitializer(source, "HELP_ASSISTANT_KEYS"),
    "persisted assistant settings"
  );
}

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
    const restore = new Map<string, string | undefined>();

    function pollute(name: string, value: string) {
      if (!restore.has(name)) restore.set(name, process.env[name]);
      process.env[name] = value;
    }

    afterEach(() => {
      // Restore rather than delete: a developer or CI runner with one of these genuinely
      // exported would otherwise have it removed for every later test in this fork.
      for (const [name, previous] of restore) {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
      restore.clear();
    });

    it("sets nothing that decides the account or the endpoint", () => {
      // Read from source rather than from a spawned service: the values are assembled
      // inside `startSession` from a live window, an MCP binding and a resolved binary,
      // none of which a unit test has. What matters is not what one launch computes but
      // which variables the host is in the business of setting at all.
      const assigned = new Set([...envLiteralNames(), ...daintreeNamesAnywhere()]);

      // A cross-check between two artifacts that move independently: the host re-sets
      // several of the names it strips (the tier, the MCP pair) from authoritative
      // sources. This is a corroboration, not the health signal — the scanners above throw
      // rather than return short, which is what makes an empty result trustworthy.
      expect(
        ENGINE_CONTROLLED_ENV.filter((name) => assigned.has(name)),
        "the host sets none of the variables it strips, which no longer describes it"
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
        pollute(name, "inherited-from-a-shell-profile");
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
      const keys = persistedSettingKeys(parseSource("electron/ipc/handlers/helpAssistant.ts"));
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
      const keys = sessionStateKeys(parseSource("src/store/assistantStore.ts"));
      const offenders = keys.filter((key) => isAccountKey(key) && !SESSION_STATE_ALLOWED.has(key));
      expect(
        offenders,
        `session-state fields naming an account or an endpoint: ${offenders.join(", ")}`
      ).toEqual([]);
    });

    it("has no stale exception in its session-state allowlist", () => {
      const keys = new Set(sessionStateKeys(parseSource("src/store/assistantStore.ts")));
      const stale = [...SESSION_STATE_ALLOWED.keys()].filter((key) => !keys.has(key));
      expect(stale, `exceptions for fields that no longer exist: ${stale.join(", ")}`).toEqual([]);
    });
  });

  /**
   * The scanners, fed the shapes that would hide a regression from them.
   *
   * Every case here PASSED the bracket-counting version this file shipped with, which is
   * the reason the fixtures exist: the checks above are only worth their word if a scanner
   * that cannot see everything refuses to report nothing.
   */
  describe("scanner fail-closed fixtures", () => {
    it("stops when a comment would close the object early", () => {
      const source = parseText(
        `const EMPTY: AssistantSessionState = {\n` +
          `  sessionId: null,\n` +
          `  // } fields continued below\n` +
          `  accessToken: null,\n` +
          `};\n`
      );
      // The AST reads the comment as a comment, so this one does not fail — it SEES the
      // field the bracket counter missed, which is the stronger outcome.
      expect(sessionStateKeys(source)).toContain("accessToken");
    });

    it("stops at a spread rather than skipping what it carries", () => {
      const source = parseText(
        `const ACCOUNT_STATE = { accessToken: null };\n` +
          `const EMPTY: AssistantSessionState = {\n` +
          `  sessionId: null,\n` +
          `  ...ACCOUNT_STATE,\n` +
          `};\n`
      );
      expect(() => sessionStateKeys(source)).toThrow(/spread/i);
    });

    it("stops at a computed key", () => {
      const source = parseText(
        `const EMPTY: AssistantSessionState = { [FIELD]: null, sessionId: null };\n`
      );
      expect(() => sessionStateKeys(source)).toThrow(/computed/i);
    });

    it("stops when the declaration is gone rather than reporting no fields", () => {
      const source = parseText(`const SOMETHING_ELSE = { sessionId: null };\n`);
      expect(() => sessionStateKeys(source)).toThrow(/no top-level/i);
    });

    it("stops when the declaration is no longer an object literal", () => {
      const source = parseText(`const EMPTY: AssistantSessionState = buildEmptyState();\n`);
      expect(() => sessionStateKeys(source)).toThrow(/expected an object literal/i);
    });

    it("reads a key list through `as const satisfies`, and stops on a non-literal element", () => {
      const good = parseText(
        `const HELP_ASSISTANT_KEYS = ["docSearch", "tier"] as const satisfies readonly string[];\n`
      );
      expect(persistedSettingKeys(good)).toEqual(["docSearch", "tier"]);

      const bad = parseText(`const HELP_ASSISTANT_KEYS = ["docSearch", ...EXTRA_KEYS] as const;\n`);
      expect(() => persistedSettingKeys(bad)).toThrow(/element is not a literal name/i);
    });

    it("stops at an environment spread it cannot read", () => {
      const names = new Set<string>();
      const source = parseText(
        `const options = { env: { ...assistantChildEnv(), ...buildAccountEnvironment() } };\n`
      );
      const literal = declarationInitializer(source, "options");
      const envProperty = ts.isObjectLiteralExpression(literal)
        ? literal.properties.find(
            (property): property is ts.PropertyAssignment =>
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === "env"
          )
        : undefined;
      expect(envProperty, "the fixture no longer contains an env literal").toBeDefined();
      expect(() =>
        envObjectNames(unwrap(envProperty!.initializer), "fixture env literal", names)
      ).toThrow(/spread of something this cannot read/i);
    });

    it("reads the conditional spreads the real environment literal is built from", () => {
      const names = new Set<string>();
      const source = parseText(
        `const options = { env: {\n` +
          `  ...assistantChildEnv(),\n` +
          `  DAINTREE_PROJECT_ID: id,\n` +
          `  ...(on ? { DAINTREE_API_KEY: key } : {}),\n` +
          `} };\n`
      );
      const literal = declarationInitializer(source, "options");
      const envProperty = ts.isObjectLiteralExpression(literal)
        ? literal.properties.find(
            (property): property is ts.PropertyAssignment =>
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === "env"
          )
        : undefined;
      envObjectNames(unwrap(envProperty!.initializer), "fixture env literal", names);
      // The conditional branch is exactly where a credential would be tucked away.
      expect([...names].sort()).toEqual(["DAINTREE_API_KEY", "DAINTREE_PROJECT_ID"]);
    });
  });
});
