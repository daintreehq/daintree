import type { PerfMode, PerfScenario } from "../types";
import { startupScenarios } from "./startup";
import { hydrationSwitchScenarios } from "./hydrationSwitch";
import { devPreviewScenarios } from "./devPreview";
import { terminalScenarios } from "./terminal";
import { ipcScenarios } from "./ipc";
import { persistenceScenarios } from "./persistence";
import { soakScenarios } from "./soak";
import { projectSwitchScenarios } from "./projectSwitch";

export const allScenarios: PerfScenario[] = [
  ...startupScenarios,
  ...hydrationSwitchScenarios,
  ...devPreviewScenarios,
  ...terminalScenarios,
  ...ipcScenarios,
  ...persistenceScenarios,
  ...soakScenarios,
  ...projectSwitchScenarios,
];

export function getScenariosForMode(mode: PerfMode): PerfScenario[] {
  return allScenarios.filter((scenario) => scenario.modes.includes(mode));
}

export function assertMatrixCoverage(): void {
  const expectedIds = new Set([
    "PERF-001",
    "PERF-002",
    "PERF-003",
    "PERF-010",
    "PERF-011",
    "PERF-012",
    "PERF-013",
    "PERF-020",
    "PERF-021",
    "PERF-022",
    "PERF-023",
    "PERF-024",
    "PERF-030",
    "PERF-031",
    "PERF-032",
    "PERF-040",
    "PERF-041",
    "PERF-042",
    "PERF-050",
    "PERF-051",
    "PERF-052",
    "PERF-060",
    "PERF-061",
    "PERF-062",
    "PERF-070",
    "PERF-071",
    "PERF-072",
    "PERF-073",
  ]);

  const actualIds = new Set(allScenarios.map((scenario) => scenario.id));

  const missing = [...expectedIds].filter((id) => !actualIds.has(id));
  if (missing.length > 0) {
    throw new Error(`Performance scenario coverage gap. Missing: ${missing.join(", ")}`);
  }
}
