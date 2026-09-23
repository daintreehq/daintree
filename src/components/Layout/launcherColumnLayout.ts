import type { DockLaunchBandId, DockLaunchRow } from "./dockLaunchItems";

/**
 * How the `+` launcher's browse list is laid out in two columns.
 *
 * The inventory is a list of sections — agents, the panels for each
 * destination, recipes — and any of them can be the long one: seventeen agents
 * on one machine, fifteen plugin panels on another, two agents and no recipes
 * on a third. So nothing here knows which section is "usually" long. The
 * sections flow like newspaper columns, down the first and on into the second,
 * and the layout picks the break (and, when it pays, the section order) that
 * makes the two columns end closest together.
 *
 * Everything is measured in rows, a heading counting as a fraction of one. The
 * result is decided from the inventory only — never from a query or a preset
 * expansion — so the columns cannot rebalance under the pointer.
 */

/** Every agent band renders under the one "Agents" heading. */
export const AGENT_BANDS: ReadonlySet<DockLaunchBandId> = new Set([
  "recent",
  "pinned",
  "other",
  "agents",
  "needs-setup",
  "available-agents",
  "presets",
]);

/**
 * The band whose label heads this row. Recency, pinning and setup are row
 * state — a trailing "Recent" or "Setup", a lit pin — so every agent band
 * shares one heading.
 */
export function headingBand(band: DockLaunchBandId): DockLaunchBandId {
  return AGENT_BANDS.has(band) && band !== "presets" ? "agents" : band;
}

const PANEL_HEADINGS: ReadonlySet<DockLaunchBandId> = new Set(["dock-panels", "grid-panels"]);

/** A heading's height in rows (a 27px label against a 38px row). */
const HEADING_HEIGHT = 0.7;
/** What splitting a section across the columns costs, in rows: a second heading
 * plus the reader's jump. Enough that a whole-section layout wins a near tie. */
const SPLIT_PENALTY = 1;
/** What moving a section out of its natural order costs, in rows. Cheap when
 * it keeps every section whole (two agents: recipes join them), dear when it
 * still has to split one — then it buys little and scrambles the categories. */
const REORDER_PENALTY = 0.5;
const REORDER_AND_SPLIT_PENALTY = 1;
/** Fewest rows of a section either side of a split: short sections stay whole,
 * and no split leaves an orphan or a widow. */
const MIN_SPLIT_ROWS = 3;

export interface LauncherColumnLayout {
  /** Browse rows in navigation order: first column, second column, footer. */
  rows: DockLaunchRow[];
  /** Which column each row key sits in; footer rows are absent. */
  columnOf: ReadonlyMap<string, 0 | 1>;
  /** Rows that open the second column mid-section and repeat its heading. */
  continuedKeys: ReadonlySet<string>;
}

interface Section {
  heading: DockLaunchBandId;
  rows: DockLaunchRow[];
  /** Position in the model's order, to price a reordering. */
  natural: number;
}

function sectionsOf(rows: ReadonlyArray<DockLaunchRow>): Section[] {
  const sections: Section[] = [];
  for (const row of rows) {
    const heading = headingBand(row.band);
    const last = sections[sections.length - 1];
    if (last && last.heading === heading) last.rows.push(row);
    else sections.push({ heading, rows: [row], natural: sections.length });
  }
  return sections;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
  );
}

interface Candidate {
  order: Section[];
  /** Rows in the first column. */
  breakAt: number;
  score: number;
}

function scoreBreak(order: Section[], breakAt: number): number | null {
  let first = 0;
  let second = 0;
  let consumed = 0;
  let split = false;
  for (const section of order) {
    const start = consumed;
    const end = consumed + section.rows.length;
    consumed = end;
    if (end <= breakAt) {
      first += HEADING_HEIGHT + section.rows.length;
    } else if (start >= breakAt) {
      second += HEADING_HEIGHT + section.rows.length;
    } else {
      const before = breakAt - start;
      const after = end - breakAt;
      if (before < MIN_SPLIT_ROWS || after < MIN_SPLIT_ROWS) return null;
      first += HEADING_HEIGHT + before;
      second += HEADING_HEIGHT + after;
      split = true;
    }
  }
  const reordered = order.some((section, i) => section.natural !== i);
  const reorderCost = reordered ? (split ? REORDER_AND_SPLIT_PENALTY : REORDER_PENALTY) : 0;
  return Math.max(first, second) + (split ? SPLIT_PENALTY : 0) + reorderCost;
}

/**
 * Lay the browse rows out. With `twoColumns` false (the popover has folded to
 * one column) the model's order stands and everything sits in the first column.
 */
export function layoutLauncherColumns(
  rows: ReadonlyArray<DockLaunchRow>,
  twoColumns: boolean
): LauncherColumnLayout {
  const footer = rows.filter((row) => row.band === "actions");
  const body = rows.filter((row) => row.band !== "actions");
  const sections = sectionsOf(body);

  if (!twoColumns || sections.length === 0) {
    return {
      rows: [...body, ...footer],
      columnOf: new Map(body.map((row) => [row.rowKey, 0])),
      continuedKeys: new Set(),
    };
  }

  // Agents lead the first column wherever they are; the rest may be reordered
  // when that balances better than splitting.
  const lead: Section | undefined = sections[0]!.heading === "agents" ? sections[0] : undefined;
  const rest = lead ? sections.slice(1) : sections;
  // The panel sections keep their own relative order — dock before grid is how
  // both surfaces read — so a reorder can only move whole groups around them.
  const orders = permutations(rest)
    .filter((tail) => {
      const panels = tail.filter((section) => PANEL_HEADINGS.has(section.heading));
      return panels.every((section, i) => i === 0 || panels[i - 1]!.natural < section.natural);
    })
    .map((tail) => (lead ? [lead, ...tail] : tail));

  let best: Candidate | null = null;
  for (const order of orders) {
    for (let breakAt = 1; breakAt <= body.length; breakAt++) {
      const score = scoreBreak(order, breakAt);
      if (score === null) continue;
      // Strictly better only, so the natural order (tried first) and the
      // earlier, whole-section break win every tie.
      if (!best || score < best.score - 1e-9) best = { order, breakAt, score };
    }
  }

  const ordered = best!.order.flatMap((section) => section.rows);
  const columnOf = new Map<string, 0 | 1>();
  ordered.forEach((row, i) => columnOf.set(row.rowKey, i < best!.breakAt ? 0 : 1));
  const continuedKeys = new Set<string>();
  const opener = ordered[best!.breakAt];
  const closer = ordered[best!.breakAt - 1];
  if (opener && closer && headingBand(opener.band) === headingBand(closer.band)) {
    continuedKeys.add(opener.rowKey);
  }
  return { rows: [...ordered, ...footer], columnOf, continuedKeys };
}
