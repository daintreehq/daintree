import type { SourceLocation } from "../../../../../../shared/elementPicker/coordinates.js";

/**
 * Tags in a `.vue` file's template, found by the position Vue's own parser
 * gives them. A stamp names where a tag opens; this parses the file as an SFC
 * the way `vite-plugin-vue-inspector` and `@vitejs/plugin-vue` both do, so a
 * position is matched in the convention it was made in, BOM and CRLF included,
 * and only ever against a tag in the top-level template: never a `<button>` in
 * a comment, an attribute, an interpolation or the script.
 *
 * The parser is imported the first time a file is checked, so a resolve that
 * only names files never loads it.
 */

type Compiler = typeof import("@vue/compiler-dom");

let compiler: Promise<Compiler> | null = null;

function loadCompiler(): Promise<Compiler> {
  compiler ??= import("@vue/compiler-dom").catch((error: unknown) => {
    // Not cached: a transient failure must not disable checking for the rest of the process.
    compiler = null;
    throw error;
  });
  return compiler;
}

/** Vue's `NodeTypes` and `ElementTypes` for the nodes read here. */
const NODE = { element: 1, attribute: 6 } as const;
export const TAG_TYPE = { element: 0, component: 1 } as const;

export interface TemplateTag {
  tag: string;
  /** Vue's `ElementTypes`: element, component, slot or `<template>`. */
  tagType: number;
  /** Offsets into the parsed text, from the opening `<` to the end of the closing tag. */
  start: number;
  end: number;
}

export type TemplateLookup =
  | { status: "found"; tag: TemplateTag }
  /** The template was read and no tag opens there. */
  | { status: "absent" }
  /** No template the parser can vouch for: another language, an external `src`, a file that no longer parses. */
  | { status: "unsupported" };

interface ParsedNode {
  type: number;
  tag?: string;
  tagType?: number;
  name?: string;
  value?: { content: string };
  props?: ParsedNode[];
  children?: ParsedNode[];
  loc: { start: { line: number; column: number; offset: number }; end: { offset: number } };
}

type Template = { status: "ok"; root: ParsedNode } | { status: "unsupported" };

function attribute(node: ParsedNode, name: string): string | null | undefined {
  const prop = node.props?.find((entry) => entry.type === NODE.attribute && entry.name === name);
  if (prop === undefined) return undefined;
  return prop.value?.content ?? null;
}

function templateOf(compiler: Compiler, text: string): Template {
  let failed = false;
  let root: ParsedNode;
  try {
    root = compiler.parse(text, {
      parseMode: "sfc",
      onError: () => {
        failed = true;
      },
    }) as unknown as ParsedNode;
  } catch {
    return { status: "unsupported" };
  }
  // A file the parser complains about is not the one the page compiled.
  if (failed) return { status: "unsupported" };
  const templates = (root.children ?? []).filter(
    (node) => node.type === NODE.element && node.tag === "template"
  );
  if (templates.length !== 1) return { status: "unsupported" };
  const template = templates[0]!;
  const lang = attribute(template, "lang");
  if (lang !== undefined && lang !== "html") return { status: "unsupported" };
  if (attribute(template, "src") !== undefined) return { status: "unsupported" };
  return { status: "ok", root: template };
}

/** One resolve's parses: a selection checks several tags in one file against the same text. */
export class TemplateIndex {
  private readonly parsed = new Map<string, Promise<Template>>();

  private template(text: string): Promise<Template> {
    let parsed = this.parsed.get(text);
    if (!parsed) {
      parsed = loadCompiler().then((loaded) => templateOf(loaded, text));
      this.parsed.set(text, parsed);
    }
    return parsed;
  }

  /** The tag whose opening `<` Vue's parser places at `line`:`column`, both 1-based. */
  async tagAt(text: string, line: number, column: number): Promise<TemplateLookup> {
    const template = await this.template(text);
    if (template.status !== "ok") return template;
    const pending = [...(template.root.children ?? [])];
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (node.type !== NODE.element) continue;
      const { start, end } = node.loc;
      if (start.line === line && start.column === column) {
        return {
          status: "found",
          tag: {
            tag: node.tag ?? "",
            tagType: node.tagType ?? -1,
            start: start.offset,
            end: end.offset,
          },
        };
      }
      if (node.children) pending.push(...node.children);
    }
    return { status: "absent" };
  }
}

function positionAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (
    let next = text.indexOf("\n");
    next !== -1 && next < offset;
    next = text.indexOf("\n", next + 1)
  ) {
    line += 1;
    lineStart = next + 1;
  }
  return { line, column: offset - lineStart };
}

/**
 * A tag's range as a location in a source map's convention, end exclusive,
 * measured as an editor shows the file: without the BOM the parser counted.
 */
export function rangeLocation(text: string, start: number, end: number): SourceLocation {
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const content = bom === 1 ? text.slice(1) : text;
  const from = positionAt(content, start - bom);
  return {
    lineBase: 1,
    columnBase: 0,
    columnUnit: "utf16",
    line: from.line,
    column: from.column,
    end: positionAt(content, end - bom),
  };
}
