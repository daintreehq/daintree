/// <reference lib="dom" />
/**
 * Reading an Angular dev build without trusting it. Everything goes through
 * the debug functions Angular publishes as `window.ng`, plus the presence of
 * the `__ngContext__` key it sets on what it renders; Angular's view internals
 * are never read. Page code shares this world and can replace any of it, so
 * every read is guarded and every answer checked for the shape Angular gives.
 */

import type { ObservedName } from "../../../../../shared/elementPicker/source.js";

/** Restated from `MAX_SOURCE_COORDINATE` and `ReportedFileSchema`: a value import would bundle zod into the page. */
export const MAX_SOURCE_COORDINATE = 10_000_000;
export const MAX_FILE_CHARS = 2048;
const MAX_NAME_CHARS = 256;

/** Set by Angular on every root node of a view and every directive host, in production builds too. */
const CONTEXT_KEY = "__ngContext__";
/** How far up the picked element Angular's key is looked for: the detector's ancestry bound. */
const OWNERSHIP_DEPTH = 64;

/** Stamped by the compiler's opt-in `enableTemplateSourceLocations`; absent by default. */
export const SOURCE_LOCATION_ATTRIBUTE = "data-ng-source-location";
const SOURCE_LOCATION_VALUE = /^(.+)@o:(\d+),l:(\d+),c:(\d+)$/;

export const DEBUG_INFO_FIELD = "constructor.ɵcmp.debugInfo";

export function read(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

export class Steps {
  constructor(private left: number) {}
  spend(): boolean {
    if (this.left <= 0) return false;
    this.left -= 1;
    return true;
  }
}

/** Undefined throughout is "Angular did not say": a missing function, a throw, or an answer of the wrong shape. */
export interface DebugApi {
  /** The component whose host `element` is; null when it hosts none. */
  componentOf(element: Element): object | null | undefined;
  /** The component whose template declared `target`; null for a root. */
  ownerOf(target: object): object | null | undefined;
  hostOf(instance: object): Element | undefined;
  /** Whether the page published `getOwningComponent`: without it no owner was looked for. */
  readonly owners: boolean;
  readonly hosts: boolean;
}

function isInstance(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** One published function, called on `ng` as Angular calls it; undefined for a throw or a missing function. */
function bind(ng: unknown, name: string): ((argument: unknown) => unknown) | undefined {
  const fn = read(ng, name);
  if (typeof fn !== "function") return undefined;
  return (argument) => {
    try {
      return fn.call(ng, argument) as unknown;
    } catch {
      // An instance no live view holds, or a node outside the app: Angular throws rather than answer.
      return undefined;
    }
  };
}

/**
 * The page's debug API, when it has the one function a chain needs. The
 * others degrade on their own: without `getOwningComponent` there are no
 * owner edges, without `getHostElement` an owner outside the chain has no root.
 */
export function debugApi(): DebugApi | null {
  const ng = read(globalThis, "ng");
  const getComponent = bind(ng, "getComponent");
  if (getComponent === undefined) return null;
  const getOwningComponent = bind(ng, "getOwningComponent");
  const getHostElement = bind(ng, "getHostElement");
  return {
    componentOf(element) {
      const instance = getComponent(element);
      return instance === null || isInstance(instance) ? instance : undefined;
    },
    ownerOf(target) {
      const owner = getOwningComponent?.(target);
      return owner === null || isInstance(owner) ? owner : undefined;
    },
    hostOf(instance) {
      const host = getHostElement?.(instance);
      return host instanceof Element ? host : undefined;
    },
    owners: getOwningComponent !== undefined,
    hosts: getHostElement !== undefined,
  };
}

/**
 * Whether a page with no debug API is a production build. Angular publishes
 * `ng` exactly when `ngDevMode` is on, which a development build makes an
 * object of counters and `enableProdMode()` sets false; with it on and no `ng`,
 * the API is simply not there to read.
 */
export function isProductionBuild(): boolean {
  return !read(globalThis, "ngDevMode");
}

function hasContext(node: Element): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(node, CONTEXT_KEY);
  } catch {
    return false;
  }
}

/** A node's parent element, or the host of the shadow root it sits at the top of: where ShadowDom encapsulation renders a view. */
export function parentOf(node: Element): Element | null {
  try {
    const parent = node.parentNode;
    if (parent instanceof Element) return parent;
    if (parent instanceof ShadowRoot) return parent.host;
  } catch {
    // A node whose parent cannot be read ends the walk.
  }
  return null;
}

/** Whether Angular rendered the element: it or an ancestor carries the key Angular sets on what it renders. */
export function isAngularNode(element: Element): boolean {
  let node: Element | null = element;
  for (let depth = 0; node !== null && depth < OWNERSHIP_DEPTH; depth += 1) {
    if (hasContext(node)) return true;
    node = parentOf(node);
  }
  return false;
}

/**
 * The component hosted on `node`. Angular keys every host, so an unkeyed node
 * hosts nothing and is never asked about: asking would send Angular up the
 * tree looking for a keyed ancestor of its own.
 */
export function hostedOn(node: Element, api: DebugApi): object | null | undefined {
  return hasContext(node) ? api.componentOf(node) : null;
}

function stringAt(value: unknown, key: string, limit: number): string | null {
  const found = read(value, key);
  return typeof found === "string" && found.length > 0 ? found.slice(0, limit) : null;
}

function debugInfoOf(instance: object): unknown {
  return read(read(read(instance, "constructor"), "ɵcmp"), "debugInfo");
}

/**
 * The class name the compiler recorded, which is the one written in source;
 * the constructor's own name is what the bundler left, often with a prefix.
 * Null is an anonymous class, not one whose name could not be read.
 */
export function observedName(instance: object): ObservedName | null {
  const className = stringAt(debugInfoOf(instance), "className", MAX_NAME_CHARS);
  if (className !== null) {
    return {
      value: className,
      extraction: { kind: "runtime-field", field: `${DEBUG_INFO_FIELD}.className` },
    };
  }
  const name = stringAt(read(instance, "constructor"), "name", MAX_NAME_CHARS);
  return name === null
    ? null
    : { value: name, extraction: { kind: "runtime-field", field: "constructor.name" } };
}

function isCoordinate(value: unknown, min: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= min &&
    (value as number) <= MAX_SOURCE_COORDINATE
  );
}

/**
 * Where the compiler says the class is declared: a path relative to the
 * project's root dirs, and the 1-based line of its `class` keyword or null when
 * it gave none. Never a column: the compiler records none.
 */
export function classDeclaration(instance: object): { file: string; line: number | null } | null {
  const debugInfo = debugInfoOf(instance);
  const file = read(debugInfo, "filePath");
  if (typeof file !== "string" || file.length === 0 || file.length > MAX_FILE_CHARS) return null;
  const line = read(debugInfo, "lineNumber");
  return { file, line: isCoordinate(line, 1) ? line : null };
}

export interface TemplateLocation {
  file: string;
  offset: number;
  line: number;
  column: number;
}

/** The compiler's stamp of where an element is written in its template: a character offset, and a 0-based line and column. */
export function templateLocation(element: Element): TemplateLocation | null {
  let value: string | null;
  try {
    value = element.getAttribute(SOURCE_LOCATION_ATTRIBUTE);
  } catch {
    return null;
  }
  if (value === null || value.length > MAX_FILE_CHARS + 64) return null;
  const match = SOURCE_LOCATION_VALUE.exec(value);
  if (match === null) return null;
  const [, file, offset, line, column] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  const numbers = [Number(offset), Number(line), Number(column)] as const;
  if (file.length > MAX_FILE_CHARS || !numbers.every((n) => isCoordinate(n, 0))) return null;
  return { file, offset: numbers[0], line: numbers[1], column: numbers[2] };
}

export class InstanceIds {
  private readonly ids = new WeakMap<object, string>();
  private next = 0;

  idOf(instance: object): string {
    let id = this.ids.get(instance);
    if (id === undefined) {
      this.next += 1;
      id = `angular-${this.next}`;
      this.ids.set(instance, id);
    }
    return id;
  }
}
