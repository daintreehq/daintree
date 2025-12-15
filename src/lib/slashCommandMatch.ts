import type { SlashCommand } from "@shared/types";

type MatchScore = {
  rank: number;
  detail: number;
};

function normalizeToken(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

function getMatchScore(label: string, query: string): MatchScore | null {
  const normalizedLabel = normalizeToken(label);
  const normalizedQuery = normalizeToken(query);
  if (!normalizedQuery) return { rank: 0, detail: 0 };

  if (normalizedLabel.startsWith(normalizedQuery)) return { rank: 0, detail: 0 };

  const colonParts = normalizedLabel.split(":");
  for (let index = 1; index < colonParts.length; index++) {
    if (colonParts[index]?.startsWith(normalizedQuery)) {
      return { rank: 1, detail: index };
    }
  }

  const dashTokens: Array<{ token: string; order: number }> = [];
  let order = 0;
  for (const part of colonParts) {
    for (const segment of part.split("-")) {
      if (!segment) continue;
      dashTokens.push({ token: segment, order });
      order++;
    }
  }

  for (const token of dashTokens) {
    if (token.token.startsWith(normalizedQuery)) return { rank: 2, detail: token.order };
  }

  const withinIndex = normalizedLabel.indexOf(normalizedQuery);
  if (withinIndex !== -1) return { rank: 3, detail: withinIndex };

  return null;
}

export function rankSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const normalizedQuery = normalizeToken(query);
  if (!normalizedQuery) return commands;

  return commands
    .map((command, index) => {
      const score = getMatchScore(command.label, normalizedQuery);
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
