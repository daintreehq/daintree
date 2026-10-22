/// <reference lib="dom" />
/**
 * Template positions `vite-plugin-vue-inspector` stamps on a page, the one
 * place a Vue dev build gets a line from. Nothing here needs the plugin; when
 * it is absent there are no stamps and no line.
 *
 * Its compile step writes `data-v-inspector="<file>:<line>:<column>"` onto
 * every element and component tag of each `.vue` file: the file relative to
 * the dev server's working directory, the position where the tag opens, as
 * Vue's template parser counts it over the whole file (1-based line and
 * column, UTF-16). Version 7 then moves the value off each vnode's props into
 * a non-enumerable `__v_inspector`, so a client-rendered page often has no
 * attribute at all, while a server-rendered one keeps the attribute in its
 * markup.
 *
 * A stamp on a component tag is a prop like any other, so an enumerable one
 * falls through to the component's root element and replaces that element's
 * own: the attribute on a root element can name where its component was
 * used. A stamp equal to one of those is never taken for the element's own.
 */

import type { Extraction } from "../../../../../shared/elementPicker/source.js";
import { componentsRootedAt, field, type VNode, type VueInstance } from "./vueInstance.js";

export const INSPECTOR_ATTRIBUTE = "data-v-inspector";
export const INSPECTOR_PROP = "__v_inspector";

/** Restated from `MAX_SOURCE_COORDINATE` and `ReportedFileSchema`: a value import would bundle zod into the page. */
const MAX_COORDINATE = 10_000_000;
const MAX_FILE_CHARS = 2048;
const MAX_STAMP_CHARS = MAX_FILE_CHARS + 24;

/** The file may hold colons of its own (a Windows drive), so the position is read from the right. */
const STAMP = /^(.+):(\d{1,8}):(\d{1,8})$/;

export interface Stamp {
  raw: string;
  file: string;
  line: number;
  column: number;
  extraction: Extraction;
}

export function parseStamp(raw: unknown, extraction: Extraction): Stamp | null {
  if (typeof raw !== "string" || raw.length > MAX_STAMP_CHARS) return null;
  const match = STAMP.exec(raw);
  if (match === null) return null;
  const [, file, lineText, columnText] = match;
  const line = Number(lineText);
  const column = Number(columnText);
  if (file!.length > MAX_FILE_CHARS || line < 1 || column < 1) return null;
  if (line > MAX_COORDINATE || column > MAX_COORDINATE) return null;
  return { raw, file: file!, line, column, extraction };
}

/** The stamp a vnode carries, hidden or not; `path` is the vnode's path from where it was read. */
function vnodeStamp(vnode: unknown, path: string): Stamp | null {
  const props = field(vnode, "props");
  return (
    parseStamp(field(props, INSPECTOR_PROP), {
      kind: "runtime-field",
      field: `${path}.props.${INSPECTOR_PROP}`,
    }) ??
    parseStamp(field(props, INSPECTOR_ATTRIBUTE), {
      kind: "runtime-field",
      field: `${path}.props.${INSPECTOR_ATTRIBUTE}`,
    })
  );
}

/**
 * Where `element` itself is written, if a stamp says so and it is not one a
 * component passed down to it. `vnode` is the element's own, null for markup
 * Vue inserted without one (a static block); `instance` is the component the
 * element was found in.
 */
export function elementStamp(
  element: Element,
  vnode: VNode | null,
  instance: VueInstance | null
): Stamp | null {
  // Never falls through, so a hidden stamp is always the element's own.
  const hidden = parseStamp(field(field(vnode, "props"), INSPECTOR_PROP), {
    kind: "runtime-field",
    field: `__vnode.props.${INSPECTOR_PROP}`,
  });
  if (hidden !== null) return hidden;
  let attribute: string | null;
  try {
    attribute = element.getAttribute(INSPECTOR_ATTRIBUTE);
  } catch {
    return null;
  }
  const stamp = parseStamp(attribute, { kind: "attribute", attribute: INSPECTOR_ATTRIBUTE });
  if (stamp === null) return null;
  if (vnode === null) return stamp;
  const passed = componentsRootedAt(element, instance).some(
    (component) => vnodeStamp(field(component, "vnode"), "vnode")?.raw === stamp.raw
  );
  return passed ? null : stamp;
}

/**
 * Where a component was used, from the stamp on its own vnode: the parent's
 * tag for it. When it is its parent's root, a stamp equal to the parent's is
 * the parent's own call site, passed down, and says nothing about this one.
 */
export function invocationStamp(instance: VueInstance): Stamp | null {
  const vnode = field(instance, "vnode");
  const stamp = vnodeStamp(vnode, "vnode");
  if (stamp === null) return null;
  const parent = field(instance, "parent");
  if (field(parent, "subTree") === vnode) {
    const inherited = vnodeStamp(field(parent, "vnode"), "vnode");
    if (inherited?.raw === stamp.raw) return null;
  }
  return stamp;
}
