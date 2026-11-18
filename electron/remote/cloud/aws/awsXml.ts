/**
 * A reader for the XML the EC2 and STS Query APIs answer with: elements and
 * text, nothing else. Attributes and namespaces are dropped, since none of
 * those answers carries meaning in them. Anything that isn't well formed
 * enough to read is refused rather than guessed at.
 */
export interface XmlNode {
  name: string;
  children: XmlNode[];
  /** The element's own text, entities decoded; empty for one with child elements. */
  text: string;
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlParseError";
  }
}

const MAX_DEPTH = 64;
const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_match, entity: string) => {
    switch (entity) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code =
          entity[1] === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : "";
      }
    }
  });
}

function localName(qualified: string): string {
  const colon = qualified.indexOf(":");
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

/** The document's root element. */
export function parseXml(source: string): XmlNode {
  const stack: Array<{ node: XmlNode; text: string[] }> = [];
  let root: XmlNode | null = null;
  let i = 0;
  const n = source.length;
  while (i < n) {
    const lt = source.indexOf("<", i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) {
      const text = source.slice(i, textEnd);
      if (stack.length > 0) stack[stack.length - 1]!.text.push(decodeEntities(text));
      else if (text.trim().length > 0) throw new XmlParseError("Text outside the root element");
    }
    if (lt === -1) break;
    if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt + 2);
      if (end === -1) throw new XmlParseError("Unterminated declaration");
      i = end + 2;
      continue;
    }
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      if (end === -1) throw new XmlParseError("Unterminated comment");
      i = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      if (end === -1) throw new XmlParseError("Unterminated CDATA section");
      if (stack.length === 0) throw new XmlParseError("CDATA outside the root element");
      stack[stack.length - 1]!.text.push(source.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (source.startsWith("<!", lt))
      throw new XmlParseError("Document type declarations aren't read");
    const gt = source.indexOf(">", lt + 1);
    if (gt === -1) throw new XmlParseError("Unterminated tag");
    const inner = source.slice(lt + 1, gt);
    i = gt + 1;
    if (inner.startsWith("/")) {
      const name = localName(inner.slice(1).trim());
      const open = stack.pop();
      if (!open || open.node.name !== name) throw new XmlParseError(`Unexpected </${name}>`);
      open.node.text = open.node.children.length === 0 ? open.text.join("") : "";
      if (stack.length === 0) root = open.node;
      continue;
    }
    const selfClosing = inner.endsWith("/");
    const match = NAME.exec(selfClosing ? inner.slice(0, -1) : inner);
    if (!match) throw new XmlParseError("Malformed tag");
    if (root) throw new XmlParseError("More than one root element");
    const node: XmlNode = { name: localName(match[0]), children: [], text: "" };
    if (stack.length > 0) stack[stack.length - 1]!.node.children.push(node);
    if (selfClosing) {
      if (stack.length === 0) root = node;
      continue;
    }
    if (stack.length >= MAX_DEPTH) throw new XmlParseError("Nested too deeply");
    stack.push({ node, text: [] });
  }
  if (stack.length > 0 || !root) throw new XmlParseError("The document ended early");
  return root;
}

/** The first child element with this name. */
export function xmlChild(node: XmlNode | null | undefined, name: string): XmlNode | null {
  return node?.children.find((child) => child.name === name) ?? null;
}

/** The text of the first child with this name, trimmed; null when there is none or it's empty. */
export function xmlText(node: XmlNode | null | undefined, name: string): string | null {
  const text = xmlChild(node, name)?.text.trim();
  return text ? text : null;
}

/** The `<item>` entries of a list element (`<instancesSet><item>…`), or [] when it's absent. */
export function xmlItems(node: XmlNode | null | undefined, listName: string): XmlNode[] {
  return xmlChild(node, listName)?.children.filter((child) => child.name === "item") ?? [];
}

/** The node at a path of child names, or null when any step is missing. */
export function xmlPath(node: XmlNode | null | undefined, ...names: string[]): XmlNode | null {
  let current: XmlNode | null = node ?? null;
  for (const name of names) {
    current = xmlChild(current, name);
    if (!current) return null;
  }
  return current;
}

/** A `tagSet` as a plain record. */
export function xmlTags(node: XmlNode | null | undefined): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const item of xmlItems(node, "tagSet")) {
    const key = xmlChild(item, "key")?.text;
    if (typeof key === "string" && key.length > 0 && !(key in Object.prototype)) {
      tags[key] = xmlChild(item, "value")?.text ?? "";
    }
  }
  return tags;
}
