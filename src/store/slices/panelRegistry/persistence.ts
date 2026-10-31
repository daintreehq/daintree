import { panelPersistence } from "../../persistence/panelPersistence";
import { getNarrowPanel } from "./selectors";
import type { TabGroup } from "@/types";

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

/** Resolves once the layout writes it started have settled. Never rejects. */
export function flushPanelPersistence(): Promise<void> {
  return panelPersistence.flushAndSettle();
}

export function saveNormalized(panelsById: Record<string, CarrierPanel>, panelIds: string[]): void {
  const panels = panelIds
    .map((id) => panelsById[id])
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
  panelPersistence.save(panels);
}

export function saveTabGroups(tabGroups: Map<string, TabGroup>): void {
  panelPersistence.saveTabGroups(tabGroups);
}
