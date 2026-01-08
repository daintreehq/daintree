import { terminalPersistence } from "../../persistence/terminalPersistence";
import type { TerminalInstance } from "./types";

export function flushTerminalPersistence(): void {
  terminalPersistence.flush();
}

export function saveTerminals(terminals: TerminalInstance[]): void {
  terminalPersistence.save(terminals);
}
