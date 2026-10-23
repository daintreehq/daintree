/**
 * Where a generated module says its map is, and the bytes of one it carries
 * inline. Pure: main reads modules from the preview origin and from the app's
 * own build output on disk, and both are read for their map the same way.
 */

/**
 * The map a module names in its trailing comments: the last annotation in the
 * run of comment and blank lines that ends the file, and none at all once a
 * line of code comes after it. A block comment counts when it opens and closes
 * on its own line. Line-based, like ECMA-426's extraction without parsing: a
 * module can contrive a template literal to fool it, which at worst picks
 * another map on the same origin. Conservative on purpose: an annotation-shaped
 * string inside the module's own code is not where its map is.
 */
export function sourceMappingReference(text: string): string | null {
  let end = text.length;
  while (end > 0) {
    const newline = text.lastIndexOf("\n", end - 1);
    const line = text.slice(newline + 1, end).trim();
    end = newline;
    if (line === "") continue;
    const match =
      /^\/\/[#@]\s*sourceMappingURL=(\S+)$/.exec(line) ??
      /^\/\*[#@]\s*sourceMappingURL=(\S+?)\s*\*\/$/.exec(line);
    // `/*# sourceMappingURL=a.map*/run();/*b*/` ends in a comment but is code.
    if (match) return match[1]!.includes("*/") ? null : match[1]!;
    const comment =
      line.startsWith("//") ||
      (line.startsWith("/*") && line.endsWith("*/") && line.indexOf("*/") === line.length - 2);
    if (!comment) return null;
  }
  return null;
}

/**
 * A `data:` map's bytes: base64 or percent-encoded JSON. The charset parameter
 * is read and not honoured: a source map is UTF-8 JSON whatever it claims.
 */
export function decodeDataUrl(reference: string): Uint8Array | null {
  const comma = reference.indexOf(",");
  if (comma === -1) return null;
  const parameters = reference
    .slice("data:".length, comma)
    .split(";")
    .map((part) => part.trim().toLowerCase());
  const mediaType = parameters[0];
  if (mediaType !== "" && mediaType !== "application/json" && mediaType !== "text/plain") {
    return null;
  }
  const data = reference.slice(comma + 1);
  if (parameters.includes("base64")) {
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(data)) return null;
    return new Uint8Array(Buffer.from(data, "base64"));
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(data));
  } catch {
    return null;
  }
}
