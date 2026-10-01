import { chainStart, previousSignificant } from "../extract.js";
import { expressionEnd, matchClose, splitArgs } from "../source.js";
import type { LintFile, LintRule, RuleHit } from "../types.js";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** At or above this an interval re-renders a clock rather than polls: "5m ago" moves once a minute. */
const CLOCK_INTERVAL_MS = 30_000;

/** A delay written as a number, a product of numbers (`60 * 1000`), or a `const` holding one. */
function literalDelay(file: LintFile, text: string, depth = 0): number | null {
  const trimmed = text.trim();
  if (/^[\d._eE+*\s]+$/.test(trimmed)) {
    const factors = trimmed.split("*").map((part) => Number(part.trim().replace(/_/g, "")));
    if (factors.length === 0 || factors.some((n) => !Number.isFinite(n))) return null;
    return factors.reduce((a, b) => a * b, 1);
  }
  if (depth > 2 || !/^[A-Za-z_$][\w$]*$/.test(trimmed)) return null;
  // Not scope-aware: when the name is declared more than once, the shortest
  // delay stands, so a local fast poll is never excused by a slow one elsewhere.
  const declared = [
    ...file.code.matchAll(new RegExp(`\\bconst\\s+${escape(trimmed)}\\s*=\\s*([^;,\\n]+)`, "g")),
  ].map((match) => literalDelay(file, match[1]!, depth + 1));
  if (declared.length === 0 || declared.some((value) => value === null)) return null;
  return Math.min(...(declared as number[]));
}

/** A callback that visibly asks the worker or the network for data: polling at any rate. */
const FETCHES = /\b(?:invoke|fetch)\s*\(|\bXMLHttpRequest\b/;

/**
 * A callback that only moves a clock: it stores the time, or bumps a counter
 * named like a clock (`setTick((t) => t + 1)`) whose only job is to
 * re-render, and does nothing else.
 */
const STORES_TIME =
  /^\(\s*\)\s*=>\s*\{?\s*(?:set[A-Z][\w$]*\s*\(|[\w$]+\.current\s*=)\s*(?:Date\.now\(\s*\)|new\s+Date\(\s*\)|performance\.now\(\s*\))\s*\)?\s*;?\s*\}?$/;
const BUMPS_CLOCK =
  /^\(\s*\)\s*=>\s*\{?\s*set[\w$]*(?:Tick|Now|Time|Clock|Minute|Second|Epoch|Render|Refresh)[\w$]*\s*\(\s*\(?\s*[\w$]+\s*\)?\s*=>\s*[\w$]+\s*\+\s*1\s*\)\s*;?\s*\}?$/;

const intervalPollingInView: LintRule = {
  id: "interval-polling-in-view",
  severity: "warn",
  appliesTo: "view",
  message: "setInterval in view code polls from the renderer",
  hint: 'poll in the worker and push with host.postToPanel; in the view, subscribe first and then pull the current state — pushes arrive batched per macrotask with no ordering against invoke results, so tag both with a revision number and keep the newest (createSyncedCollection + useSyncedCollection from the SDK do exactly this for a keyed list); for an animation loop use useAnimationFrame, which pauses while the view is hidden or cached; for text that changes as time passes ("5m ago") use useNow from @daintreehq/plugin-sdk/react, one shared timer that pauses the same way',
  check(file) {
    const hits: RuleHit[] = [];
    for (const m of file.masked.matchAll(/\bsetInterval\s*\(/g)) {
      const args = splitArgs(file.masked, m.index + m[0].length - 1);
      const delay = args[1] ? literalDelay(file, file.code.slice(args[1][0], args[1][1])) : null;
      const callback = args[0] ? file.code.slice(args[0][0], args[0][1]).trim() : "";
      // A slow tick re-renders a clock; it cannot hammer anything. One that
      // visibly fetches is still polling, however slowly.
      if (delay !== null && delay >= CLOCK_INTERVAL_MS && !FETCHES.test(callback)) continue;
      if (STORES_TIME.test(callback) || BUMPS_CLOCK.test(callback)) {
        hits.push({
          offset: m.index,
          message:
            "setInterval ticks a clock in the view; useNow from @daintreehq/plugin-sdk/react shares one timer across every component and pauses while the view is hidden or cached",
        });
        continue;
      }
      hits.push({ offset: m.index });
    }
    return hits;
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
  message: "host fs.watch without debounceMs delivers every write in a burst",
  hint: "pass { debounceMs: 200 }, or debounceMs: 0 to say you want every event — a watch fires once per write. (Worktree, active-worktree and agent-state subscriptions already coalesce by default.)",
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
  hint: "post the collection once after the loop, or post only the item that changed — createSyncedCollection batches a loop of changes into one delta for useSyncedCollection",
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

/**
 * `[…].slice(-n)` or `….concat(…).slice(a, b)` at `close`: the copy is capped
 * as it is made. `.slice()` and `.slice(0)` copy it whole, so they cap nothing.
 */
function slicedAfter(masked: string, close: number): boolean {
  if (close < 0) return false;
  const cap = /\s*\.\s*slice\s*\(\s*(?:-|[^,()]+,\s*[^\s)])/y;
  cap.lastIndex = close + 1;
  return cap.test(masked);
}

/**
 * `x.push(`, `x.unshift(`, `x = [...x, …]`, `x = x.concat(` — `x` grows. `x` may be a member path.
 * `x = [...x, item].slice(-100)` rebuilds `x` capped, so it does not grow.
 */
function appendedCollections(masked: string): Set<string> {
  const grown = new Set<string>();
  const path = "[A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*";
  const normal = (text: string) => text.replace(/\s+/g, "");
  for (const m of masked.matchAll(new RegExp(`(${path})\\s*\\.\\s*(?:push|unshift)\\s*\\(`, "g"))) {
    grown.add(normal(m[1]!));
  }
  for (const m of masked.matchAll(
    new RegExp(
      `(${path})\\s*=\\s*(?:(\\[)\\s*\\.\\.\\.\\s*(${path})|(${path})\\s*\\.\\s*concat\\s*(\\())`,
      "g"
    )
  )) {
    const target = normal(m[1]!);
    if (normal(m[3] ?? m[4] ?? "") !== target) continue;
    const open = m[2] !== undefined ? m.index + m[0].indexOf("[") : m.index + m[0].length - 1;
    if (slicedAfter(masked, matchClose(masked, open))) continue;
    grown.add(target);
  }
  return grown;
}

/** `x.shift()`, `x.splice(`, `x.length = `, `x = x.slice(` — someone keeps `x` bounded. */
function isBounded(masked: string, name: string): boolean {
  const p = name.split(".").map(escape).join("\\s*\\.\\s*");
  return new RegExp(
    `(?<![\\w$.])${p}\\s*(?:\\.\\s*(?:shift|splice)\\s*\\(|\\.\\s*length\\s*=(?!=)|=\\s*${p}\\s*\\.\\s*slice\\s*\\()`
  ).test(masked);
}

/**
 * `x = []` or `x = new Array()` after `from` in the same block — a flush that
 * posts the buffer and starts a fresh one, which bounds it like `x.splice(0)`. A declaration
 * (`let x = []`) is where it starts, not a reset.
 */
function resetAfter(masked: string, name: string, from: number): boolean {
  // Only in the block holding the post: a reset in some other callback does
  // not run when this one posts.
  const end = enclosingBlockEnd(masked, from);
  const p = name.split(".").map(escape).join("\\s*\\.\\s*");
  const reset = new RegExp(
    `(?<![\\w$.])(?<!\\b(?:let|const|var)\\s+)${p}\\s*=(?!=)\\s*(?:\\[\\s*\\]|new\\s+Array\\s*\\(\\s*(?:0\\s*)?\\))`,
    "g"
  );
  reset.lastIndex = from;
  const match = reset.exec(masked);
  return match !== null && match.index < end;
}

/** The `}` closing the innermost block around `at`, or the end of the text at top level. */
function enclosingBlockEnd(masked: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = masked[i]!;
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) {
        const close = matchClose(masked, i);
        return close < 0 ? masked.length : close;
      }
      depth--;
    }
  }
  return masked.length;
}

/** Names a payload sends whole: `x`, `{ x }`, `{ k: x }`, `[...x]`, `x.slice()`. */
function payloadReferences(payloadText: string, name: string): boolean {
  const p = name.split(".").map(escape).join("\\s*\\.\\s*");
  return new RegExp(
    `(?<![\\w$.])${p}(?![\\w$]|\\s*(?:\\.\\s*(?!slice\\s*\\(\\s*\\))[\\w$]|\\[|\\())`
  ).test(payloadText);
}

const wholeStatePush: LintRule = {
  id: "whole-state-push",
  severity: "warn",
  // Only a worker can post, but its state often lives in a helper module.
  appliesTo: "any",
  message:
    "a growing collection is re-sent whole on every push, so the bytes grow with the square of its length",
  hint: "send only what changed: createSyncedCollection (worker) + useSyncedCollection (view) from @daintreehq/plugin-sdk pull the list once and then push deltas, and handle the pull/push ordering race",
  check(file) {
    const grown = appendedCollections(file.masked);
    if (grown.size === 0) return [];
    const unbounded = [...grown].filter((name) => !isBounded(file.masked, name));
    if (unbounded.length === 0) return [];
    const hits: RuleHit[] = [];
    for (const m of file.masked.matchAll(POST)) {
      const open = m.index + m[0].length - 1;
      const payload = splitArgs(file.masked, open)[1];
      if (!payload) continue;
      const payloadText = file.masked.slice(payload[0], payload[1]);
      // A collection, or the object that owns it (`state` for `state.calls.push`).
      const sent = unbounded.find((name) => {
        if (resetAfter(file.masked, name, payload[1])) return false;
        const segments = name.split(".");
        return segments.some((_, i) =>
          payloadReferences(payloadText, segments.slice(0, i + 1).join("."))
        );
      });
      if (!sent) continue;
      hits.push({
        offset: m.index,
        message: `${m[1]} re-sends \`${sent}\`, which only grows, on every push — the bytes sent grow with the square of its length`,
      });
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

/**
 * An append in `[start, end)` whose copy grows with the collection.
 * `setLines((prev) => [...prev, line].slice(-500))` copies a capped buffer.
 */
function growingAppend(masked: string, start: number, end: number): boolean {
  const re = new RegExp(APPEND_PER_EVENT.source, "g");
  for (const m of masked.slice(start, end).matchAll(re)) {
    const spread = m[0].indexOf("[");
    const open = start + m.index + (spread >= 0 ? spread : m[0].length - 1);
    if (!slicedAfter(masked, matchClose(masked, open))) return true;
  }
  return false;
}

const renderOnEveryEvent: LintRule = {
  id: "render-on-every-event",
  severity: "warn",
  appliesTo: "view",
  message:
    "state is updated on every event of a high-frequency subscription, so each event schedules an update",
  hint: "coalesce: useThrottledCallback for replaceable values (progress, latest state), usePluginEventSelector for a slice of a snapshot, useStreamBuffer (a buffer flushed once per frame for appends such as log lines — lossless, where throttling would drop them), useSyncedCollection for a keyed list the worker changes, and useVirtualList or useProgressiveList for long lists — or ask the worker to batch",
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
      const append = growingAppend(file.masked, callback[0], callback[1]);
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
  wholeStatePush,
  renderOnEveryEvent,
  bundledReact,
];
