import path from "node:path";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  PLUGIN_CUSTOM_ICON_MAX_BYTES,
  isPluginCustomIconRef,
  validatePluginCustomIconRef,
} from "../../../shared/config/pluginCustomIcon.js";
import { validateSvg } from "../../../shared/utils/svgSanitizer.js";
import { PluginPathNotAllowedError, resolveContainedPath } from "./pluginFsContainment.js";

/**
 * Reads and vets the SVG files a manifest names in `iconId` (#13143). Pure
 * Node with no Electron imports: the `daintree-plugin validate` CLI runs the
 * same checks, so an author sees exactly the rejection the host would apply.
 */

interface IconBearingContributions {
  panels: ReadonlyArray<{ iconId: string; toolbar?: ReadonlyArray<{ iconId?: string }> }>;
  toolbarButtons: ReadonlyArray<{ iconId: string }>;
  processTools: ReadonlyArray<{ iconId: string }>;
}

export interface PluginIconIssue {
  /** Dotted manifest path, e.g. `contributes.toolbarButtons.0.iconId`. */
  path: string;
  message: string;
}

export interface PluginCustomIconLoadResult {
  /** Sanitized markup by reference, for every reference that loaded. */
  loaded: Map<string, string>;
  /** One issue per manifest location whose reference failed. */
  issues: PluginIconIssue[];
}

type IconLoadOutcome = { ok: true; svg: string } | { ok: false; error: string };

/** Every custom reference in `contributes`, with the manifest paths that name it. */
export function collectPluginCustomIconRefs(
  contributes: IconBearingContributions
): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  const note = (iconId: string | undefined, where: string) => {
    if (!isPluginCustomIconRef(iconId)) return;
    const existing = refs.get(iconId);
    if (existing) existing.push(where);
    else refs.set(iconId, [where]);
  };
  const add = (group: keyof IconBearingContributions) => {
    for (const [index, entry] of contributes[group].entries()) {
      note(entry.iconId, `contributes.${group}.${index}.iconId`);
    }
  };
  add("panels");
  for (const [index, panel] of contributes.panels.entries()) {
    for (const [slot, item] of (panel.toolbar ?? []).entries()) {
      note(item.iconId, `contributes.panels.${index}.toolbar.${slot}.iconId`);
    }
  }
  add("toolbarButtons");
  add("processTools");
  return refs;
}

async function readBounded(filePath: string): Promise<Buffer | null> {
  // Non-blocking so an icon path naming a FIFO with no writer fails the
  // regular-file check below instead of hanging plugin startup in `open()`.
  // `O_NONBLOCK` is undefined on Windows, where there are no FIFOs to open.
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("not a regular file");
    if (stat.size > PLUGIN_CUSTOM_ICON_MAX_BYTES) return null;
    // Read one byte past the cap so a file that grew after the stat still
    // reads as oversize rather than being silently truncated.
    const buffer = Buffer.alloc(PLUGIN_CUSTOM_ICON_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > PLUGIN_CUSTOM_ICON_MAX_BYTES) return null;
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const DRAWABLE_ELEMENTS = new Set([
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "use",
]);

/**
 * Zero or more `name="value"` / `name='value'` attributes. Quote-aware so a
 * `>` inside a value doesn't end the tag, and strict so an unquoted value —
 * malformed XML that would render as a blank mask — fails to match.
 */
const ATTRIBUTES = /(?:\s+[^\s=<>/"']+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*/;

/** Local name of a possibly namespace-prefixed tag (`svg:path` → `path`). */
function localName(tag: string): string {
  return tag.slice(tag.indexOf(":") + 1).toLowerCase();
}

/**
 * Structural checks the regex sanitizer doesn't make: it only looks for an
 * `<svg` tag somewhere, so a fragment, an unclosed or empty document, or one
 * without the SVG namespace would otherwise pass — and Chromium renders such a
 * mask as nothing, which hides the fallback glyph instead of showing it. A
 * light tag-balance pass rather than a full XML parser: the sanitizer, and the
 * static image mode the mask renders in, are what keep the content inert.
 */
function checkSvgStructure(text: string): string | null {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return "must not contain a DOCTYPE or ENTITY declaration";
  if (/<\?xml-stylesheet/i.test(text)) return "must not reference a stylesheet";
  const body = text
    .replace(/^\uFEFF/, "")
    .replace(/^\s*<\?xml[^>]*\?>/i, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .trim();
  if (/<!--|<!\[CDATA\[/.test(body))
    return "is not well-formed XML (unterminated comment or CDATA)";

  const root = new RegExp(`^<svg${ATTRIBUTES.source}\\s*/?>`, "i").exec(body)?.[0];
  if (!root) return "must have an <svg> root element";
  if (!new RegExp(`\\sxmlns\\s*=\\s*["']${SVG_NAMESPACE}["']`).test(root)) {
    return `the <svg> root must declare xmlns="${SVG_NAMESPACE}"`;
  }
  const hasViewBox = /\sviewBox\s*=/i.test(root);
  const hasSize = /\swidth\s*=/i.test(root) && /\sheight\s*=/i.test(root);
  if (!hasViewBox && !hasSize) return "the <svg> root must declare a viewBox";

  const stack: string[] = [];
  let drawable = false;
  let end = 0;
  const TAG = new RegExp(
    `<(/?)([A-Za-z_][\\w:.-]*)${ATTRIBUTES.source}\\s*(/?)>|<\\?[^>]*\\?>`,
    "g"
  );
  for (let match = TAG.exec(body); match; match = TAG.exec(body)) {
    // Character data may hold `>` but never a raw `<`: one here is a tag the
    // pattern couldn't read, i.e. malformed markup.
    if (body.slice(end, match.index).includes("<")) return "is not well-formed XML";
    end = match.index + match[0].length;
    const [, closing, name, selfClosing] = match;
    if (name === undefined) continue; // processing instruction
    if (closing) {
      if (stack.pop() !== name) return `is not well-formed XML (unexpected </${name}>)`;
    } else {
      if (DRAWABLE_ELEMENTS.has(localName(name))) drawable = true;
      if (!selfClosing) stack.push(name);
    }
    if (stack.length === 0 && body.slice(end).trim() !== "") {
      return "must have a single <svg> root element";
    }
  }
  if (body.slice(end).includes("<")) return "is not well-formed XML";
  if (stack.length > 0) return `is not well-formed XML (unclosed <${stack[stack.length - 1]}>)`;
  if (!drawable) return "contains nothing drawable";
  return null;
}

/** Load one reference from `pluginDir`, returning sanitized markup or the reason it is unusable. */
export async function loadPluginCustomIcon(
  pluginId: string,
  pluginDir: string,
  ref: string
): Promise<IconLoadOutcome> {
  const refError = validatePluginCustomIconRef(ref);
  if (refError) return { ok: false, error: `"${ref}" ${refError}` };
  // Containment needs an absolute root; the CLI passes `validate .` through as-is.
  const root = path.resolve(pluginDir);

  let resolved: string;
  try {
    // Realpath containment, so a symlinked icon that points outside the plugin
    // directory is refused rather than read.
    resolved = await resolveContainedPath(pluginId, path.join(root, ref.slice(2)), [root]);
  } catch (err) {
    if (err instanceof PluginPathNotAllowedError) {
      return { ok: false, error: `"${ref}" resolves outside the plugin directory` };
    }
    throw err;
  }

  let bytes: Buffer | null;
  try {
    bytes = await readBounded(resolved);
  } catch {
    return { ok: false, error: `"${ref}" was not found or is not a readable file` };
  }
  if (bytes === null) {
    return {
      ok: false,
      error: `"${ref}" is larger than ${PLUGIN_CUSTOM_ICON_MAX_BYTES / 1024} KB`,
    };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: `"${ref}" is not valid UTF-8` };
  }

  const structureError = checkSvgStructure(text);
  if (structureError) return { ok: false, error: `"${ref}" ${structureError}` };

  const sanitized = validateSvg(text);
  if (!sanitized.ok) return { ok: false, error: `"${ref}": ${sanitized.error}` };
  return { ok: true, svg: sanitized.svg };
}

/**
 * Validation-time view of {@link loadPluginCustomIcons}: every manifest
 * location whose custom icon the host would refuse. Shared by the
 * `daintree-plugin validate` CLI and the in-app `plugin.validate` action so
 * both report the same text.
 */
export async function collectPluginIconIssues(
  pluginId: string,
  pluginDir: string,
  contributes: IconBearingContributions
): Promise<PluginIconIssue[]> {
  return (await loadPluginCustomIcons(pluginId, pluginDir, contributes)).issues;
}

/**
 * Load every custom icon `contributes` references. A failed reference is
 * reported once per manifest location and left out of `loaded`, so the host
 * renders the fallback glyph there while the rest of the plugin loads.
 */
export async function loadPluginCustomIcons(
  pluginId: string,
  pluginDir: string,
  contributes: IconBearingContributions
): Promise<PluginCustomIconLoadResult> {
  const loaded = new Map<string, string>();
  const issues: PluginIconIssue[] = [];
  for (const [ref, locations] of collectPluginCustomIconRefs(contributes)) {
    const outcome = await loadPluginCustomIcon(pluginId, pluginDir, ref);
    if (outcome.ok) {
      loaded.set(ref, outcome.svg);
      continue;
    }
    for (const where of locations) issues.push({ path: where, message: outcome.error });
  }
  return { loaded, issues };
}
