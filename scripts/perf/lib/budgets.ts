import fs from "node:fs";
import path from "node:path";
import type { PerfBudgetConfig, ScenarioBudget } from "../types";

const DEFAULT_BUDGETS_PATH = path.resolve(process.cwd(), "scripts/perf/config/budgets.json");

export function loadBudgetConfig(configPath = DEFAULT_BUDGETS_PATH): PerfBudgetConfig {
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as PerfBudgetConfig;

  if (!parsed.defaultBudget || !parsed.scenarios) {
    throw new Error(`Invalid performance budget config: ${configPath}`);
  }

  return parsed;
}

export function getScenarioBudget(config: PerfBudgetConfig, scenarioId: string): ScenarioBudget {
  return {
    ...config.defaultBudget,
    ...(config.scenarios[scenarioId] ?? {}),
  };
}
