export type ContextKeyValue = string | boolean | null | undefined;

export type WhenClauseContext = Record<string, ContextKeyValue>;

export interface LiteralNode {
  kind: "literal";
  value: string | boolean;
}

export interface IdentifierNode {
  kind: "identifier";
  path: string[];
}

export interface UnaryOpNode {
  kind: "unary";
  operator: "!";
  operand: ASTNode;
}

export interface BinaryOpNode {
  kind: "binary";
  operator: "==" | "!=" | "&&" | "||";
  left: ASTNode;
  right: ASTNode;
}

export type ASTNode = LiteralNode | IdentifierNode | UnaryOpNode | BinaryOpNode;
