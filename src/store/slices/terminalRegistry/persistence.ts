import { terminalPersistence } from "../../persistence/terminalPersistence";
import type { TerminalInstance } from "./types";
import type { TabGroup } from "@/types";

export function flushTerminalPersistence(): void {
  terminalPersistence.flush();
}

export function saveTerminals(terminals: TerminalInstance[]): void {
  terminalPersistence.save(terminals);
}

export function saveNormalized(
  terminalsById: Record<string, TerminalInstance>,
  terminalIds: string[]
): void {
  terminalPersistence.save(terminalIds.map((id) => terminalsById[id]).filter(Boolean));
}

export function saveTabGroups(tabGroups: Map<string, TabGroup>): void {
  terminalPersistence.saveTabGroups(tabGroups);
}
