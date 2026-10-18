import type { ASTNode, BinaryOpNode, IdentifierNode, LiteralNode, UnaryOpNode } from "./types.js";

// Segments may hold hyphens and start with a digit so any plugin manifest name
// (`publisher.name`, e.g. `acme.linear-planner`, `3m.tools`) is a valid path
// root for the keys that plugin publishes with `host.setContext` (#13506).
const IDENT_RE = /^\w[\w-]*(?:\.\w[\w-]*)*/;
const NUMERIC_RE = /^\d+(?:\.\d+)*$/;
const UNSUPPORTED_OPS: Array<[RegExp, string]> = [
  [/^=~/, "regex operator `=~` is not yet supported"],
  // `in` is an operator only as a whole word: `in.tools.key` and
  // `in-house.tools.key` are identifiers rooted at a plugin publisher.
  [/^in(?![\w.-])/, "`in` operator is not yet supported"],
  [/^[<>]=?/, "numeric comparison operators are not yet supported"],
  [/^\(/, "parentheses are not supported"],
  [/^\)/, "parentheses are not supported"],
  [/^"/, "double-quoted strings are not supported — use single quotes"],
];

class Tokenizer {
  private pos = 0;

  constructor(private readonly input: string) {}

  get length(): number {
    return this.input.length;
  }

  peek(): string | null {
    this.skipWhitespace();
    if (this.pos >= this.input.length) return null;
    const slice = this.input.slice(this.pos);
    if (slice[0] === "'") return "'";
    if (slice.startsWith("&&")) return "&&";
    if (slice.startsWith("||")) return "||";
    if (slice.startsWith("==")) return "==";
    if (slice.startsWith("!=")) return "!=";
    if (slice[0] === "!") return "!";
    for (const [re, msg] of UNSUPPORTED_OPS) {
      if (re.test(slice)) {
        throw new ParseError(msg, this.pos);
      }
    }
    const m = slice.match(IDENT_RE);
    if (m) {
      const ident = m[0]!;
      if (ident === "true" || ident === "false") return "bool";
      if (NUMERIC_RE.test(ident)) {
        throw new ParseError("numeric literals are not supported", this.pos);
      }
      return "ident";
    }
    throw new ParseError(`unexpected token "${slice[0]}"`, this.pos);
  }

  next(): string {
    this.skipWhitespace();
    if (this.pos >= this.input.length) {
      throw new ParseError("unexpected end of expression", this.pos);
    }
    const slice = this.input.slice(this.pos);

    if (slice[0] === "'") {
      let i = 1;
      while (i < slice.length) {
        if (slice[i] === "\\" && i + 1 < slice.length) {
          i += 2;
          continue;
        }
        if (slice[i] === "'") {
          const val = slice.slice(1, i).replace(/\\'/g, "'");
          this.pos += i + 1;
          return val;
        }
        i++;
      }
      throw new ParseError("unterminated string literal", this.pos);
    }

    if (slice.startsWith("&&")) {
      this.pos += 2;
      return "&&";
    }
    if (slice.startsWith("||")) {
      this.pos += 2;
      return "||";
    }
    if (slice.startsWith("==")) {
      this.pos += 2;
      return "==";
    }
    if (slice.startsWith("!=")) {
      this.pos += 2;
      return "!=";
    }
    if (slice[0] === "!") {
      this.pos += 1;
      return "!";
    }

    const m = slice.match(IDENT_RE);
    if (m) {
      const ident = m[0]!;
      if (ident === "true") {
        this.pos += 4;
        return "_true_";
      }
      if (ident === "false") {
        this.pos += 5;
        return "_false_";
      }
      this.pos += ident.length;
      return ident;
    }

    throw new ParseError(`unexpected token "${slice[0]}"`, this.pos);
  }

  private skipWhitespace(): void {
    while (this.pos < this.input.length && /\s/.test(this.input[this.pos]!)) {
      this.pos++;
    }
  }
}

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly position: number
  ) {
    super(`When clause parse error at position ${position}: ${message}`);
    this.name = "ParseError";
  }
}

function parsePrimary(tok: Tokenizer): ASTNode {
  const next = tok.peek();
  if (next === null) throw new ParseError("unexpected end of expression", tok.length);
  if (next === "!") {
    tok.next();
    return { kind: "unary", operator: "!", operand: parsePrimary(tok) } as UnaryOpNode;
  }
  if (next === "bool") {
    const val = tok.next();
    return { kind: "literal", value: val === "_true_" } as LiteralNode;
  }
  if (next === "ident") {
    const ident = tok.next();
    return { kind: "identifier", path: ident.split(".") } as IdentifierNode;
  }
  if (next === "'") {
    return { kind: "literal", value: tok.next() } as LiteralNode;
  }
  throw new ParseError(`unexpected token "${next}"`, tok.length);
}

function parseEquality(tok: Tokenizer): ASTNode {
  let left = parsePrimary(tok);
  while (true) {
    const op = tok.peek();
    if (op === "==" || op === "!=") {
      tok.next();
      left = { kind: "binary", operator: op, left, right: parsePrimary(tok) } as BinaryOpNode;
    } else {
      break;
    }
  }
  return left;
}

function parseAnd(tok: Tokenizer): ASTNode {
  let left = parseEquality(tok);
  while (tok.peek() === "&&") {
    tok.next();
    left = { kind: "binary", operator: "&&", left, right: parseEquality(tok) } as BinaryOpNode;
  }
  return left;
}

function parseOr(tok: Tokenizer): ASTNode {
  let left = parseAnd(tok);
  while (tok.peek() === "||") {
    tok.next();
    left = { kind: "binary", operator: "||", left, right: parseAnd(tok) } as BinaryOpNode;
  }
  return left;
}

export function parse(input: string): ASTNode {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new ParseError("empty expression", 0);
  }
  const tok = new Tokenizer(trimmed);
  const ast = parseOr(tok);
  if (tok.peek() !== null) {
    throw new ParseError("unexpected content after expression", input.length);
  }
  return ast;
}
