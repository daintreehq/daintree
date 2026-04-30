import { panelPersistence } from "../../persistence/panelPersistence";
import type { TerminalInstance } from "./types";
import type { TabGroup } from "@/types";

export function flushPanelPersistence(): void {
  panelPersistence.flush();
}

export function savePanels(terminals: TerminalInstance[]): void {
  panelPersistence.save(terminals);
}

export function saveNormalized(
  panelsById: Record<string, TerminalInstance>,
  panelIds: string[]
): void {
  panelPersistence.save(
    panelIds.map((id) => panelsById[id]).filter((t): t is TerminalInstance => Boolean(t))
  );
}

export function saveTabGroups(tabGroups: Map<string, TabGroup>): void {
  panelPersistence.saveTabGroups(tabGroups);
}
