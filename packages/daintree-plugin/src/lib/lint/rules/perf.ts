import { chainStart, previousSignificant } from "../extract.js";
import { expressionEnd, matchClose, splitArgs } from "../source.js";
import type { LintFile, LintRule, RuleHit } from "../types.js";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const intervalPollingInView: LintRule = {
  id: "interval-polling-in-view",
  severity: "warn",
  appliesTo: "view",
  message: "setInterval in view code polls from the renderer",
  hint: "poll in the worker and push with host.postToPanel; in the view, subscribe first and then pull the current state — pushes arrive batched per macrotask with no ordering against invoke results, so tag both with a revision number and keep the newest",
  check(file) {
    return [...file.masked.matchAll(/\bsetInterval\s*\(/g)].map((m) => ({ offset: m.index }));
  },
};

const NODE_FS_IMPORT = /(?:from\s*["']|require\(\s*["'])(?:node:)?fs(?:\/promises)?["']/;

/** The options argument of a host subscription: missing, an object literal, or opaque. */
function optionsArg(file: LintFile, open: number, index: number): "missing" | "literal" | "opaque" {
  const args = splitArgs(file.masked, open);
  const arg = args[index];
  if (!arg) return "missing";
  const text = file.masked.slice(arg[0], arg[1]).trim();
  return text.startsWith("{") ? "literal" : "opaque";
}

const undebouncedSubscription: LintRule = {
  id: "undebounced-worktree-subscription",
  severity: "warn",
  appliesTo: "any",
  message: "subscription without debounceMs delivers every event in a burst",
  hint: "pass { debounceMs: 200 }, or debounceMs: 0 to say you want every event — the worktree list re-emits on every git-status poll and a watch fires per write",
  check(file) {
    const hits: RuleHit[] = [];
    const inspect = (open: number, at: number, index: number, name: string) => {
      const shape = optionsArg(file, open, index);
      if (shape === "opaque") return;
      if (shape === "literal") {
        const arg = splitArgs(file.masked, open)[index]!;
        if (/\bdebounceMs\b/.test(file.code.slice(arg[0], arg[1]))) return;
      }
      hits.push({
        offset: at,
        message: `${name} without debounceMs delivers every event in a burst`,
      });
    };
    for (const m of file.masked.matchAll(/\bonDidChangeWorktrees\s*\(/g)) {
      inspect(m.index + m[0].length - 1, m.index, 1, "onDidChangeWorktrees");
    }
    const nodeFs = NODE_FS_IMPORT.test(file.code);
    for (const m of file.masked.matchAll(/(\.\s*)?\bfs\s*\.\s*watch\s*\(/g)) {
      // A bare `fs.watch` in a file importing Node's fs is Node's, which has no debounceMs.
      if (!m[1] && nodeFs) continue;
      inspect(m.index + m[0].length - 1, m.index, 2, "fs.watch");
    }
    return hits;
  },
};

const SUBSCRIBE = /\bplugin\s*\.\s*(?:on|onPanel)\s*\(/g;

const subscriptionWithoutDispose: LintRule = {
  id: "subscription-without-dispose",
  severity: "warn",
  appliesTo: "view",
  message: "the subscription's disposer is dropped, so it outlives the view",
  hint: "keep the returned function and call it from the effect's cleanup: `const off = …; return () => off();`",
  check(file) {
    const hits: RuleHit[] = [];
    for (const m of file.masked.matchAll(SUBSCRIBE)) {
      const start = chainStart(file.masked, m.index);
      const before = previousSignificant(file.masked, start);
      const statement =
        before.char === "" ||
        before.char === ";" ||
        before.char === "{" ||
        before.char === "}" ||
        before.char === ")" ||
        before.word === "void" ||
        before.word === "else";
      if (statement) hits.push({ offset: m.index });
    }
    return hits;
  },
};

const POST = /\b(postToPanel|broadcastToRenderer)\s*\(/g;

/** `[start, end, iterable]` for every loop body whose collection is a readable expression. */
function loops(file: LintFile): Array<[number, number, string]> {
  const { masked, code } = file;
  const out: Array<[number, number, string]> = [];
  for (const m of masked.matchAll(/\bfor\s*(?:await\s*)?\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close < 0) continue;
    const iterable = /\b(?:of|in)\s+([\s\S]+)$/.exec(code.slice(open + 1, close))?.[1]?.trim();
    if (!iterable) continue;
    let bodyStart = close + 1;
    while (bodyStart < masked.length && /\s/.test(masked[bodyStart]!)) bodyStart++;
    const bodyEnd =
      masked[bodyStart] === "{" ? matchClose(masked, bodyStart) : expressionEnd(masked, bodyStart);
    if (bodyEnd > bodyStart) out.push([bodyStart, bodyEnd, iterable]);
  }
  for (const m of masked.matchAll(/\.\s*(?:forEach|map|flatMap)\s*\(/g)) {
    const receiverStart = chainStart(masked, m.index);
    const iterable = code.slice(receiverStart, m.index).trim();
    if (!iterable) continue;
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close > open) out.push([open, close, iterable]);
  }
  return out;
}

const largeInlinePayload: LintRule = {
  id: "large-inline-payload",
  severity: "warn",
  appliesTo: "any",
  message: "the whole collection is posted once per item, so the cost grows with its square",
  hint: "post the collection once after the loop, or post only the item that changed",
  check(file) {
    const hits: RuleHit[] = [];
    const seen = new Set<number>();
    const bodies = loops(file);
    if (bodies.length === 0) return hits;
    for (const m of file.masked.matchAll(POST)) {
      const open = m.index + m[0].length - 1;
      const args = splitArgs(file.masked, open);
      const payload = args[1];
      // A targeted push per panel is one message per instance, not a rebroadcast.
      if (!payload || args.length > 2) continue;
      const payloadText = file.code.slice(payload[0], payload[1]);
      for (const [start, end, iterable] of bodies) {
        if (m.index < start || m.index > end || seen.has(m.index)) continue;
        const whole = new RegExp(`(?<![\\w$.])${escape(iterable)}(?![\\w$]|\\s*[.[(])`);
        if (!whole.test(payloadText)) continue;
        seen.add(m.index);
        hits.push({
          offset: m.index,
          message: `${m[1]} sends all of \`${iterable}\` on every iteration over it, so the cost grows with its square`,
        });
      }
    }
    return hits;
  },
};

const VIEW_SUBSCRIBE =
  /\b(?:plugin\s*\.\s*(?:on|onPanel)|usePluginEvent|usePluginPanelEvent)\s*\(/g;
const HIGH_FREQUENCY =
  /(progress|tick|stream|output|chunk|delta|frame|logs?$|lines?$|metrics?|heartbeat|cursor|pty|stdout|stderr)/i;
const COALESCED =
  /\b(requestAnimationFrame|startTransition|setTimeout|debounce|throttle|queueMicrotask|useDeferredValue)\b/;
const APPEND_PER_EVENT =
  /\bset[A-Z][\w$]*\s*\(\s*(?:\(?\s*[\w$]+\s*\)?\s*=>\s*)?(?:\[\s*\.\.\.|[\w$]+\s*\.\s*concat\s*\()/;
const SETS_STATE = /^\s*set[A-Z][\w$]*\s*$|\bset[A-Z][\w$]*\s*\(/;

const renderOnEveryEvent: LintRule = {
  id: "render-on-every-event",
  severity: "warn",
  appliesTo: "view",
  message:
    "state is updated on every event of a high-frequency subscription, so each event schedules an update",
  hint: "coalesce: useThrottledCallback for replaceable values (progress, latest state), usePluginEventSelector for a slice of a snapshot, a buffer flushed once per frame for appends (throttling drops them), and useVirtualList or useProgressiveList for long lists — or ask the worker to batch",
  check(file) {
    const hits: RuleHit[] = [];
    for (const m of file.masked.matchAll(VIEW_SUBSCRIBE)) {
      const open = m.index + m[0].length - 1;
      const args = splitArgs(file.masked, open);
      const callback = args[args.length - 1];
      if (!callback || args.length < 2) continue;
      const callbackText = file.code.slice(callback[0], callback[1]);
      if (COALESCED.test(callbackText)) continue;
      const channel = args
        .map(([s, e]) => /^\s*(["'`])([^"'`]*)\1\s*$/.exec(file.code.slice(s, e))?.[2])
        .find((value) => value !== undefined);
      const append = APPEND_PER_EVENT.test(callbackText);
      const highFrequency = channel !== undefined && HIGH_FREQUENCY.test(channel);
      if (append || (highFrequency && SETS_STATE.test(callbackText))) {
        hits.push({
          offset: m.index,
          message: append
            ? "every event copies the collection in state to append one item, so the work grows with its length"
            : `state is updated on every "${channel}" event, so a burst schedules one update per event`,
        });
      }
    }
    return hits;
  },
};

const REACT_INTERNALS =
  /__(?:SECRET|CLIENT)_INTERNALS_DO_NOT_USE_OR_(?:YOU_WILL_BE_FIRED|WARN_USERS_THEY_CANNOT_UPGRADE)|@license React\b/;

const bundledReact: LintRule = {
  id: "bundled-react",
  severity: "error",
  appliesTo: "view",
  target: "build",
  message: "the built view bundles its own copy of React, so hooks break against the host's",
  hint: "leave react, react-dom and react/jsx-runtime external (the @daintreehq/plugin-vite preset does) — the host serves them from its import map",
  check(file) {
    const match = REACT_INTERNALS.exec(file.raw);
    return match ? [{ offset: match.index }] : [];
  },
};

export const PERF_RULES: LintRule[] = [
  intervalPollingInView,
  undebouncedSubscription,
  subscriptionWithoutDispose,
  largeInlinePayload,
  renderOnEveryEvent,
  bundledReact,
];
