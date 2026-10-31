import { assistantNeedsAttention, classifyAssistantActivity } from "@/lib/projectAssistantActivity";
import { isGroupBandKey } from "@/lib/projectGroupBands";
import { attentionClass, isBandCollapsed, PROJECT_SECTION_LABELS } from "./ordering";
import {
  PROJECT_SECTION_ORDER,
  type ProjectBandKey,
  type ProjectSwitcherBrowseBand,
  type ProjectSwitcherRow,
  type SearchableScratch,
} from "./types";

/** The bands a scratch can be lifted into: the ones that report what is happening. */
export type ScratchLiftBand = "current" | "attention" | "running";

/**
 * Where a scratch belongs in browse, by the same rule a project's band follows
 * (`sectionForProject`): the one you are in, then one asking for something,
 * then one with live work. Anything else stays in the Scratch section.
 *
 * The header's "4 running" counts scratches, so a scratch running agents must
 * be found where the header's eye goes, not under the whole catalogue.
 */
export function scratchLiftBand(scratch: SearchableScratch): ScratchLiftBand | null {
  if (scratch.isActive) return "current";
  const assistant = classifyAssistantActivity(scratch);
  if (
    scratch.waitingAgentCount > 0 ||
    scratch.blockedAgentCount > 0 ||
    scratch.unacknowledgedCompletedAgentCount > 0 ||
    assistantNeedsAttention(assistant)
  ) {
    return "attention";
  }
  if (scratch.activeAgentCount > 0 || assistant === "working") return "running";
  return null;
}

/**
 * Where a lifted scratch sits: its band, and — in Needs attention — the
 * severity tier it was admitted with (`attentionClass`, the projects' own:
 * blocked, then waiting, then finished-unread, assistant escalation included).
 * Held for the open session with the band, so a scratch whose state moves
 * between tiers doesn't move under the pointer while its text stays live.
 */
export interface ScratchLiftPlace {
  band: ScratchLiftBand;
  tier: number;
}

export function scratchLiftPlace(scratch: SearchableScratch): ScratchLiftPlace | null {
  const band = scratchLiftBand(scratch);
  return band ? { band, tier: band === "attention" ? attentionClass(scratch) : 0 } : null;
}

function workingAssistants(scratches: readonly SearchableScratch[]): number {
  return scratches.filter((scratch) => classifyAssistantActivity(scratch) === "working").length;
}

function rankOf(key: ProjectBandKey): number {
  // User groups sit just above Other, as `buildBandRanks` orders them.
  if (isGroupBandKey(key)) return PROJECT_SECTION_ORDER.indexOf("other") - 0.5;
  return PROJECT_SECTION_ORDER.indexOf(key);
}

export interface LiftedBrowse {
  results: ProjectSwitcherRow[];
  bands: ProjectSwitcherBrowseBand[];
  /** Scratches drawn in a project band, which the Scratch section leaves out. */
  liftedIds: ReadonlySet<string>;
}

/**
 * Browse with the lifted scratches placed at the end of their bands, and any
 * band they need that no project opened (a scratch the only thing running)
 * declared in its ranked place. Folded bands keep their headers and counts and
 * contribute no rows, as everywhere else in browse.
 *
 * `placeFor` is the placement the caller froze when the palette opened, so a
 * scratch that starts or stops running mid-session doesn't move under the
 * pointer — the same promise the project rows keep.
 */
export function liftScratches(
  results: ProjectSwitcherRow[],
  bands: ProjectSwitcherBrowseBand[],
  scratches: readonly SearchableScratch[],
  placeFor: (scratch: SearchableScratch) => ScratchLiftPlace | null,
  collapsedBands: Readonly<Record<string, boolean>>
): LiftedBrowse {
  const lifted = new Map<ScratchLiftBand, SearchableScratch[]>();
  const tierOf = new Map<string, number>();
  for (const scratch of scratches) {
    const place = placeFor(scratch);
    if (!place) continue;
    const list = lifted.get(place.band) ?? [];
    list.push(scratch);
    lifted.set(place.band, list);
    tierOf.set(scratch.id, place.tier);
  }
  // Scratches among themselves by tier; the sort is stable, so within one
  // tier they keep the recency order they arrived in.
  lifted.get("attention")?.sort((a, b) => tierOf.get(a.id)! - tierOf.get(b.id)!);
  if (lifted.size === 0) return { results, bands, liftedIds: new Set() };

  const nextBands = bands.map((band) => {
    const extra = lifted.get(band.key as ScratchLiftBand);
    if (!extra) return band;
    return {
      ...band,
      itemCount: band.itemCount + extra.length,
      activeAgentCount:
        (band.activeAgentCount ?? 0) + extra.reduce((sum, s) => sum + s.activeAgentCount, 0),
      workingAssistantCount: (band.workingAssistantCount ?? 0) + workingAssistants(extra),
    };
  });
  for (const key of ["current", "attention", "running"] as const) {
    const extra = lifted.get(key);
    if (!extra || nextBands.some((band) => band.key === key)) continue;
    const at = nextBands.findIndex((band) => rankOf(band.key) > rankOf(key));
    nextBands.splice(at === -1 ? nextBands.length : at, 0, {
      key,
      // "Current project" would misname a scratch; this band holds only one.
      label: key === "current" ? "Current workspace" : PROJECT_SECTION_LABELS[key],
      itemCount: extra.length,
      collapsed: isBandCollapsed(collapsedBands, key),
      activeAgentCount: extra.reduce((sum, s) => sum + s.activeAgentCount, 0),
      workingAssistantCount: workingAssistants(extra),
    });
  }

  const placed = new Set<string>();
  const nextResults: ProjectSwitcherRow[] = [];
  for (const band of nextBands) {
    if (band.collapsed) continue;
    const rows: ProjectSwitcherRow[] = [];
    for (const row of results) {
      if (row.kind === "project" && row.section === band.key) {
        rows.push(row);
        placed.add(row.id);
      }
    }
    for (const scratch of lifted.get(band.key as ScratchLiftBand) ?? []) {
      const row: ProjectSwitcherRow = { kind: "scratch", ...scratch, section: band.key };
      // Needs attention keeps its severity order across both kinds: a scratch
      // goes in before the first project of a lower tier, and the projects
      // keep the order the hook gave them. Every other band takes it last.
      const tier = tierOf.get(scratch.id) ?? 0;
      const at =
        band.key === "attention"
          ? rows.findIndex(
              (other) =>
                (other.kind === "project" ? attentionClass(other) : tierOf.get(other.id)!) > tier
            )
          : -1;
      if (at === -1) rows.push(row);
      else rows.splice(at, 0, row);
    }
    nextResults.push(...rows);
  }
  for (const row of results) if (!placed.has(row.id)) nextResults.push(row);

  const liftedIds = new Set<string>();
  for (const list of lifted.values()) for (const scratch of list) liftedIds.add(scratch.id);
  return { results: nextResults, bands: nextBands, liftedIds };
}
