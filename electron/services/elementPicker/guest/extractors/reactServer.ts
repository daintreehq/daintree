/**
 * Server Components as a React 19 dev build records them in the page. They
 * leave no fiber: the Flight client hands the reconciler their output with a
 * `ReactComponentInfo` for each component that rendered it, and React copies
 * those onto the `_debugInfo` of the fibers made from that output. A fiber's
 * list is reset for every parent's children, so it holds exactly the server
 * components between that fiber and its parent, outermost first, which is the
 * order React's own component stacks read them in.
 *
 * Every value is page data, read through `field`, bounded, and never called.
 * An info's identity is the object: Flight reuses one info for every fiber a
 * component's output made, and two instances of one component are two infos.
 */

import type { ComponentEnvironment } from "../../../../../shared/elementPicker/component.js";
import { field, type Fiber } from "./reactFiber.js";

export type ServerInfo = Record<string, unknown>;

/**
 * Entries read off one fiber's list. A real page nests a handful of server
 * components per hop, but every `await` above a fiber adds an async entry, so
 * the bound leaves room for those.
 */
const MAX_ENTRIES = 256;
/** The longest array a JavaScript engine can hold; a `length` past it is no array's. */
const MAX_ARRAY_LENGTH = 2 ** 32 - 1;
const MAX_NAME_CHARS = 256;

export interface ServerEntry {
  info: ServerInfo;
  /** Its index in the fiber's `_debugInfo`, for naming the field it was read from. */
  index: number;
}

export interface ServerEntries {
  /** Outermost first, as the list holds them. */
  entries: ServerEntry[];
  /** The list ran past what is read; the outermost are the ones left out. */
  cut: boolean;
}

const NONE: ServerEntries = { entries: [], cut: false };

/**
 * A component entry, by the test React applies: a string `name`. Async and
 * timing entries share the list and have none.
 */
export function isServerInfo(value: unknown): value is ServerInfo {
  const name = field(value, "name");
  return (
    typeof value === "object" &&
    value !== null &&
    typeof name === "string" &&
    name.length > 0 &&
    typeof field(value, "tag") !== "number"
  );
}

export function serverEntries(fiber: Fiber): ServerEntries {
  const list = field(fiber, "_debugInfo");
  try {
    if (!Array.isArray(list)) return NONE;
  } catch {
    return NONE;
  }
  // A proxy can claim any length, or one that runs page code when read as a number.
  const length = field(list, "length");
  if (
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < 0 ||
    length > MAX_ARRAY_LENGTH
  ) {
    return NONE;
  }
  const start = Math.max(0, length - MAX_ENTRIES);
  const entries: ServerEntry[] = [];
  for (let index = start; index < length; index += 1) {
    const entry = field(list, String(index));
    if (isServerInfo(entry)) entries.push({ info: entry, index });
  }
  return { entries, cut: start > 0 };
}

export function serverName(info: ServerInfo): string | null {
  const name = field(info, "name");
  return typeof name === "string" && name.length > 0 ? name.slice(0, MAX_NAME_CHARS) : null;
}

/**
 * Flight names the environment a component rendered in (`Server`, or a
 * framework's own such as `Prerender` or `Cache`); any of them is a server.
 * An info that names none is not said to be one.
 */
export function serverEnvironment(info: ServerInfo): ComponentEnvironment {
  const env = field(info, "env");
  return typeof env === "string" && env.length > 0 ? "server" : "unknown";
}

/** Mints one id per server component instance, which is one info object. */
export class ServerIds {
  private readonly ids = new WeakMap<object, string>();
  private next = 0;

  constructor(private readonly prefix: string) {}

  idOf(info: ServerInfo): string {
    let id = this.ids.get(info);
    if (id === undefined) {
      this.next += 1;
      id = this.prefix + this.next;
      this.ids.set(info, id);
    }
    return id;
  }
}
