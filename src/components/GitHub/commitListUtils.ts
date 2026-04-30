export interface ParsedCommit {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
}

const CONVENTIONAL_COMMIT_RE = /^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/;

export function parseConventionalCommit(message: string): ParsedCommit | null {
  const header = message.split("\n")[0];
  if (header === undefined) return null;
  const match = header.match(CONVENTIONAL_COMMIT_RE);
  if (!match) return null;
  const [, type, scope, breakingMark, description] = match;
  const trimmedScope = scope?.trim() || null;
  return { type: type!, scope: trimmedScope, breaking: !!breakingMark, description: description! };
}
