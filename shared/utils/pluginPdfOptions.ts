import path from "path";
import type { PluginPdfPageSize, PluginRenderPdfOptions } from "../types/plugin.js";

/**
 * Option validation for `host.documents.renderPdf`, shared by the real host and
 * the published mock host so a plugin's export tests fail on exactly what
 * Daintree refuses. Pure: no Electron, no filesystem.
 */

/** Cap on HTML a render holds in main, inline or read from `htmlPath`. */
export const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_MARGIN_INCHES = 3;
const MAX_PAGE_RANGES_LENGTH = 200;

const PAGE_SIZES: ReadonlySet<PluginPdfPageSize> = new Set([
  "A4",
  "Letter",
  "Legal",
  "A3",
  "A5",
  "Tabloid",
]);
const OPTION_KEYS: ReadonlySet<string> = new Set([
  "html",
  "htmlPath",
  "outputPath",
  "pageSize",
  "landscape",
  "printBackground",
  "margins",
  "pageRanges",
]);
const MARGIN_KEYS: ReadonlySet<string> = new Set(["top", "bottom", "left", "right"]);
const PAGE_RANGES_PATTERN = /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/;

export type PdfSource = { kind: "html"; html: string } | { kind: "path"; htmlPath: string };

/** The subset of Electron's `PrintToPDFOptions` a plugin can set. */
export interface PdfPrintOptions {
  pageSize: PluginPdfPageSize;
  printBackground: boolean;
  preferCSSPageSize: boolean;
  landscape?: boolean;
  margins?: { top?: number; bottom?: number; left?: number; right?: number };
  pageRanges?: string;
}

export interface ValidatedRenderPdfOptions {
  source: PdfSource;
  outputPath: string;
  print: PdfPrintOptions;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a plugin's `renderPdf` options and translate them to Electron's
 * `printToPDF` options. Strict by design: an unknown key is refused rather than
 * dropped, so a typo like `margin` fails loudly instead of printing with
 * defaults the author did not ask for.
 */
export function validateRenderPdfOptions(
  pluginId: string,
  raw: unknown
): ValidatedRenderPdfOptions {
  const fail = (message: string): never => {
    throw new Error(`VALIDATION: plugin "${pluginId}" documents.renderPdf: ${message}`);
  };
  if (!isPlainObject(raw)) fail("options must be an object");
  const options = raw as Record<string, unknown> & Partial<PluginRenderPdfOptions>;
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) fail(`unknown option "${key}"`);
  }

  const hasHtml = options.html !== undefined;
  const hasHtmlPath = options.htmlPath !== undefined;
  if (hasHtml === hasHtmlPath) fail("exactly one of html or htmlPath is required");
  let source: PdfSource;
  if (hasHtml) {
    if (typeof options.html !== "string") fail("html must be a string");
    const html = options.html as string;
    if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) {
      fail(`html exceeds the ${MAX_HTML_BYTES} byte limit; move large assets into files`);
    }
    source = { kind: "html", html };
  } else {
    const htmlPath = options.htmlPath;
    if (typeof htmlPath !== "string" || !path.isAbsolute(htmlPath)) {
      fail("htmlPath must be an absolute path");
    }
    source = { kind: "path", htmlPath: htmlPath as string };
  }

  const outputPath = options.outputPath;
  if (typeof outputPath !== "string" || !path.isAbsolute(outputPath)) {
    fail("outputPath must be an absolute path");
  }
  if (!(outputPath as string).toLowerCase().endsWith(".pdf")) {
    fail("outputPath must end in .pdf");
  }

  const print: PdfPrintOptions = {
    pageSize: "A4",
    printBackground: true,
    preferCSSPageSize: false,
  };
  if (options.pageSize !== undefined) {
    if (!PAGE_SIZES.has(options.pageSize as PluginPdfPageSize)) {
      fail(`pageSize must be one of ${[...PAGE_SIZES].join(", ")}`);
    }
    print.pageSize = options.pageSize as PluginPdfPageSize;
  }
  if (options.landscape !== undefined) {
    if (typeof options.landscape !== "boolean") fail("landscape must be a boolean");
    print.landscape = options.landscape;
  }
  if (options.printBackground !== undefined) {
    if (typeof options.printBackground !== "boolean") fail("printBackground must be a boolean");
    print.printBackground = options.printBackground;
  }
  if (options.margins !== undefined) {
    if (!isPlainObject(options.margins)) fail("margins must be an object");
    const margins: NonNullable<PdfPrintOptions["margins"]> = {};
    for (const [side, value] of Object.entries(options.margins as Record<string, unknown>)) {
      if (!MARGIN_KEYS.has(side)) fail(`unknown margin "${side}"`);
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > MAX_MARGIN_INCHES
      ) {
        fail(`margins.${side} must be a number of inches between 0 and ${MAX_MARGIN_INCHES}`);
      }
      margins[side as keyof NonNullable<PdfPrintOptions["margins"]>] = value as number;
    }
    print.margins = margins;
  }
  if (options.pageRanges !== undefined) {
    const ranges = options.pageRanges;
    if (
      typeof ranges !== "string" ||
      ranges.length > MAX_PAGE_RANGES_LENGTH ||
      !PAGE_RANGES_PATTERN.test(ranges)
    ) {
      fail('pageRanges must look like "1-3, 5"');
    }
    for (const part of (ranges as string).split(",")) {
      const [start = 0, end = start] = part.split("-").map((n) => Number(n.trim()));
      if (start < 1 || end < start) fail(`pageRanges has an invalid range "${part.trim()}"`);
    }
    print.pageRanges = (ranges as string).trim();
  }

  return { source, outputPath: outputPath as string, print };
}
