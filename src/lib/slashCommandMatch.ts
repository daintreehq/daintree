import type { SlashCommand } from "@shared/types";

type MatchScore = {
  rank: number;
  detail: number;
};

/** Trigger characters stripped from the front of a token before matching. */
const TRIGGER_PREFIXES = ["/", "$", "@"] as const;

/**
 * Trim/lowercase a token and strip a single leading trigger (`/`, `$`, `@`) so
 * ranking is trigger-neutral. Only the first character is inspected, exactly
 * once — `$$plugin` normalizes to `$plugin`, never `plugin` — and triggers that
 * appear mid-token are left intact.
 */
function normalizeToken(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return (TRIGGER_PREFIXES as readonly string[]).includes(trimmed[0] ?? "")
    ? trimmed.slice(1)
    : trimmed;
}

/**
 * Split an already-normalized candidate into ordered subword tokens on
 * whitespace, colon, then hyphen (order preserved) so `neo-issue`,
 * `git:work-issue`, and `Plugin Creator` all yield their component words.
 * Callers must pass a value that has already been through {@link normalizeToken}.
 */
function extractOrderedTokens(normalized: string): string[] {
  const tokens: string[] = [];
  for (const spacePart of normalized.split(/\s+/)) {
    for (const colonPart of spacePart.split(":")) {
      for (const segment of colonPart.split("-")) {
        if (!segment) continue;
        tokens.push(segment);
      }
    }
  }
  return tokens;
}

/**
 * Score a single already-normalized candidate against an already-normalized
 * query across four tiers: exact token → label prefix → token prefix →
 * substring. Lower `rank`/`detail` is better. Returns null on no match.
 */
function scoreCandidate(normalizedCandidate: string, normalizedQuery: string): MatchScore | null {
  const tokens = extractOrderedTokens(normalizedCandidate);
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] === normalizedQuery) return { rank: 0, detail: index };
  }

  if (normalizedCandidate.startsWith(normalizedQuery)) return { rank: 1, detail: 0 };

  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]?.startsWith(normalizedQuery)) return { rank: 2, detail: index };
  }

  const withinIndex = normalizedCandidate.indexOf(normalizedQuery);
  if (withinIndex !== -1) return { rank: 3, detail: withinIndex };

  return null;
}

/**
 * Best score for a command across every searchable string — its label, the
 * triggerless insert text, and any aliases — normalizing each exactly once.
 * Kind, badge text, and description are deliberately excluded.
 */
function getMatchScore(command: SlashCommand, normalizedQuery: string): MatchScore | null {
  const candidates = [command.label];
  if (command.insertText) candidates.push(command.insertText);
  if (command.aliases) candidates.push(...command.aliases);

  let best: MatchScore | null = null;
  for (const candidate of candidates) {
    const score = scoreCandidate(normalizeToken(candidate), normalizedQuery);
    if (
      score &&
      (best === null ||
        score.rank < best.rank ||
        (score.rank === best.rank && score.detail < best.detail))
    ) {
      best = score;
    }
  }
  return best;
}

export function rankSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const normalizedQuery = normalizeToken(query);
  if (!normalizedQuery) return commands;

  return commands
    .map((command, index) => {
      const score = getMatchScore(command, normalizedQuery);
      return score ? { command, score, index } : null;
    })
    .filter(
      (entry): entry is { command: SlashCommand; score: MatchScore; index: number } =>
        entry !== null
    )
    .sort((a, b) => {
      if (a.score.rank !== b.score.rank) return a.score.rank - b.score.rank;
      if (a.score.detail !== b.score.detail) return a.score.detail - b.score.detail;
      const labelOrder = a.command.label.localeCompare(b.command.label);
      if (labelOrder !== 0) return labelOrder;
      return a.index - b.index;
    })
    .map(({ command }) => command);
}
