import { panelPersistence } from "../../persistence/panelPersistence";
import { type PanelInstance } from "@shared/types/panel";
import { getNarrowPanel } from "./selectors";
import type { TabGroup } from "@/types";

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

export function flushPanelPersistence(): void {
  panelPersistence.flush();
}

export function savePanels(panels: PanelInstance[]): void {
  panelPersistence.save(panels);
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
