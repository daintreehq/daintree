import type { ReactElement, ReactNode } from "react";

/**
 * What React's Flight client hands the reconciler for a tree a server
 * rendered, built by hand rather than decoded from a payload: elements and
 * lazy chunks carrying `_debugInfo`, owners that are server component infos
 * rather than fibers, and stacks in the shape Flight fakes them in, each
 * server frame a call into a function whose `sourceURL` wraps the server's
 * file in `about://React/<env>/`. react-dom is real, so which fiber each
 * `_debugInfo` lands on is React's own doing.
 *
 * Shapes are React 19.3's Flight client (`ReactComponentInfo`, the fake
 * `react-stack-top-frame` errors) and the frames Next.js 16 serves: Turbopack
 * names a server chunk under `.next/dev/server`, Webpack a virtual
 * `webpack-internal:///(rsc)/` module. Paths are sanitized.
 */

export const APP_ROOT = "/work/app";
/** Where Flight's own fake JSX call site runs: React's client chunk. */
const CLIENT_CHUNK =
  "http://localhost:3000/_next/static/chunks/node_modules_react-server-dom_client.js";

export const TURBOPACK_PAGE = `file://${APP_ROOT}/.next/dev/server/chunks/ssr/[root-of-the-server]__page._.js`;
export const TURBOPACK_LAYOUT = `file://${APP_ROOT}/.next/dev/server/chunks/ssr/[root-of-the-server]__layout._.js`;
export const WEBPACK_PAGE = "webpack-internal:///(rsc)/./app/page.tsx";
export const NEXT_INTERNALS = `file://${APP_ROOT}/.next/dev/server/chunks/ssr/node_modules_next_dist_server_app-render._.js`;

let fakeFunctions = 0;

export interface ServerFrame {
  name: string;
  file: string;
  line: number;
  column: number;
}

/** One frame as V8 prints a call into Flight's fake function for it. */
function printed(frame: ServerFrame, env: string): string {
  fakeFunctions += 1;
  const url = `about://React/${encodeURIComponent(env)}/${encodeURI(frame.file)}?${fakeFunctions}`;
  return `    at ${frame.name} (${url}:${frame.line}:${frame.column})`;
}

/**
 * A stack the way Flight's `buildFakeCallStack` makes one: the fake JSX call
 * site first, then the server's frames innermost first, then React's bottom
 * marker, which is where the client's call into the fake stack starts.
 */
export function fakeStack(frames: ServerFrame[], env = "Server"): Error {
  const error = new Error("react-stack-top-frame");
  Object.defineProperty(error, "stack", {
    configurable: true,
    value: [
      "Error: react-stack-top-frame",
      `    at fakeJSXCallSite (${CLIENT_CHUNK}:1:1)`,
      ...frames.map((frame) => printed(frame, env)),
      `    at Object.react_stack_bottom_frame (${CLIENT_CHUNK}:2:2)`,
    ].join("\n"),
  });
  return error;
}

export interface ServerInfo {
  name: string;
  env: string;
  key: string | null;
  owner: ServerInfo | null;
  stack: unknown[] | null;
  props: Record<string, unknown>;
  /** Where the server made this component's element: its call site, in its owner's code. */
  debugStack: Error | null;
  /** A child's creation stack, whose last frame is this component's own function. */
  debugLocation: Error | null;
  debugTask: null;
}

export interface ServerInfoOptions {
  owner?: ServerInfo | null;
  env?: string;
  /** The frames the server captured where the element was made. */
  calledFrom?: ServerFrame[];
  /** Where the component's own function is, as the frame of a child it made. */
  definedAt?: ServerFrame;
}

export function serverInfo(name: string, options: ServerInfoOptions = {}): ServerInfo {
  const env = options.env ?? "Server";
  return {
    name,
    env,
    key: null,
    owner: options.owner ?? null,
    stack: null,
    props: {},
    debugStack: options.calledFrom ? fakeStack(options.calledFrom, env) : null,
    debugLocation: options.definedAt ? fakeStack([options.definedAt], env) : null,
    debugTask: null,
  };
}

export interface ServerElementOptions {
  owner?: ServerInfo | null;
  key?: string;
  /** The server components between this element's fiber and its parent's. */
  debugInfo?: unknown[];
  /** Where the server made the element. */
  createdAt?: ServerFrame[];
  env?: string;
}

/** An element as Flight decodes one the server made: owned by a server component, its stack faked. */
export function serverElement(
  type: unknown,
  props: Record<string, unknown>,
  options: ServerElementOptions = {}
): ReactElement {
  return {
    $$typeof: Symbol.for("react.transitional.element"),
    type,
    key: options.key ?? null,
    props,
    _owner: options.owner ?? null,
    _store: { validated: 1 },
    _debugInfo: options.debugInfo ?? null,
    _debugStack: fakeStack(options.createdAt ?? [], options.env),
    _debugTask: null,
  } as unknown as ReactElement;
}

/** A chunk Flight resolved: a lazy reference to a server component's output, with that component's info. */
export function serverChunk(value: ReactNode, debugInfo: unknown[]): ReactElement {
  return {
    $$typeof: Symbol.for("react.lazy"),
    _payload: value,
    _init: (payload: unknown) => payload,
    _debugInfo: debugInfo,
  } as unknown as ReactElement;
}
