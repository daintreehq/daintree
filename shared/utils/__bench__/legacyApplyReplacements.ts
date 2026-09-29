import type { ReplacementRule } from "../diagnosticsTransform.js";

/** Verbatim copy of the quadratic range bookkeeping, kept as the parity oracle and bench baseline. */
export function legacyApplyReplacementsCounted(
  json: string,
  rules: ReplacementRule[]
): { output: string; counts: number[]; ranges: [number, number][] } {
  let out = json;
  let ranges: [number, number][] = [];
  const counts = rules.map(() => 0);
  rules.forEach((rule, i) => {
    if (!rule.find) return;
    const matches: { start: number; end: number; length: number }[] = [];
    try {
      if (rule.kind === "regex") {
        const pattern = new RegExp(rule.find, "g");
        if (rule.replace.includes("$")) {
          counts[i] = out.match(pattern)?.length ?? 0;
          out = out.replace(pattern, rule.replace);
          ranges = [];
          return;
        }
        out = out.replace(pattern, (match: string, ...rest: unknown[]) => {
          const offset = rest.find((arg): arg is number => typeof arg === "number") ?? 0;
          matches.push({ start: offset, end: offset + match.length, length: rule.replace.length });
          return rule.replace;
        });
      } else {
        for (
          let at = out.indexOf(rule.find);
          at !== -1;
          at = out.indexOf(rule.find, at + rule.find.length)
        ) {
          matches.push({ start: at, end: at + rule.find.length, length: rule.replace.length });
        }
        out = out.split(rule.find).join(rule.replace);
      }
    } catch {
      return;
    }
    counts[i] = matches.length;
    if (matches.length === 0) return;
    const shiftAt = (pos: number) => {
      let delta = 0;
      for (const m of matches) {
        if (m.end > pos) break;
        delta += m.length - (m.end - m.start);
      }
      return pos + delta;
    };
    const moved = ranges
      .filter(([s, e]) => !matches.some((m) => m.start <= e && s < m.end))
      .map(([s, e]): [number, number] => [shiftAt(s), shiftAt(e + 1) - 1]);
    const added = matches
      .filter((m) => m.length > 0)
      .map((m): [number, number] => {
        const start = shiftAt(m.start);
        return [start, start + m.length - 1];
      });
    ranges = [...moved, ...added].sort((x, y) => x[0] - y[0]);
  });
  return { output: out, counts, ranges };
}
