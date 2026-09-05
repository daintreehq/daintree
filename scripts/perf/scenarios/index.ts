import type { PerfMode, PerfScenario } from "../types";
import { startupScenarios } from "./startup";
import { hydrationSwitchScenarios } from "./hydrationSwitch";
import { devPreviewScenarios } from "./devPreview";
import { terminalScenarios } from "./terminal";
import { agentAnalysisScenarios } from "./agentAnalysis";
import { ipcScenarios } from "./ipc";
import { persistenceScenarios } from "./persistence";
import { soakScenarios } from "./soak";
import { projectSwitchScenarios } from "./projectSwitch";
import { migrationScenarios } from "./migrations";
import { idleWindowScenarios } from "./idleWindow";
import { gitPipelineScenarios } from "./gitPipeline";
import { resizeReflowScenarios } from "./resizeReflow";
import { worktreeSidebarScenarios } from "./worktreeSidebar";
import { fleetBroadcastScenarios } from "./fleetBroadcast";
import { diffTokenizeScenarios } from "./diffTokenize";
import { paletteFilterScenarios } from "./paletteFilter";
import { fileSearchScenarios } from "./fileSearch";
import { terminalSearchScenarios } from "./terminalSearch";
import { scrollbackSnapshotScenarios } from "./scrollbackSnapshot";
import { actionDispatchScenarios } from "./actionDispatch";
import { pluginHostScenarios } from "./pluginHost";
import { panelScenarios } from "./panels";
import { supervisionScenarios } from "./supervision";
import { mcpSessionScenarios } from "./mcpSession";
import { themeScenarios } from "./theme";
import { notificationScenarios } from "./notifications";
import { forgeRegistryScenarios } from "./forgeRegistry";
import { agentRosterScenarios } from "./agentRoster";
import { ipcEnvelopeScenarios } from "./ipcEnvelope";
import { loggingScenarios } from "./logging";
import { ptyFlowControlScenarios } from "./ptyFlowControl";
import { copyTreeScenarios } from "./copyTree";
import { cliAvailabilityScenarios } from "./cliAvailability";
import { sidebarFilterScenarios } from "./sidebarFilters";
import { switcherSearchScenarios } from "./switcherSearch";
import { imagePathProbeScenarios } from "./imagePathProbe";

export const allScenarios: PerfScenario[] = [
  ...startupScenarios,
  ...hydrationSwitchScenarios,
  ...devPreviewScenarios,
  ...terminalScenarios,
  ...agentAnalysisScenarios,
  ...ipcScenarios,
  ...persistenceScenarios,
  ...soakScenarios,
  ...projectSwitchScenarios,
  ...migrationScenarios,
  ...idleWindowScenarios,
  ...gitPipelineScenarios,
  ...resizeReflowScenarios,
  ...worktreeSidebarScenarios,
  ...fleetBroadcastScenarios,
  ...diffTokenizeScenarios,
  ...paletteFilterScenarios,
  ...fileSearchScenarios,
  ...terminalSearchScenarios,
  ...scrollbackSnapshotScenarios,
  ...actionDispatchScenarios,
  ...pluginHostScenarios,
  ...panelScenarios,
  ...supervisionScenarios,
  ...mcpSessionScenarios,
  ...themeScenarios,
  ...notificationScenarios,
  ...forgeRegistryScenarios,
  ...agentRosterScenarios,
  ...ipcEnvelopeScenarios,
  ...loggingScenarios,
  ...ptyFlowControlScenarios,
  ...copyTreeScenarios,
  ...cliAvailabilityScenarios,
  ...sidebarFilterScenarios,
  ...switcherSearchScenarios,
  ...imagePathProbeScenarios,
];

export function getScenariosForMode(mode: PerfMode): PerfScenario[] {
  return allScenarios.filter((scenario) => scenario.modes.includes(mode));
}

/**
 * The declared PERF matrix. This list is the contract: every id here must be
 * implemented, and nothing may be implemented that is not listed. Exported so
 * the matrix test can assert both directions against one declaration rather
 * than keeping a second copy of the count.
 */
export const EXPECTED_SCENARIO_IDS: ReadonlySet<string> = new Set([
  "PERF-001",
  "PERF-002",
  "PERF-003",
  "PERF-004",
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
  "PERF-033",
  "PERF-034",
  "PERF-035",
  "PERF-036",
  "PERF-042",
  "PERF-043",
  "PERF-044",
  "PERF-045",
  "PERF-046",
  "PERF-053",
  "PERF-054",
  "PERF-055",
  "PERF-056",
  "PERF-057",
  "PERF-058",
  "PERF-060",
  "PERF-061",
  "PERF-062",
  "PERF-063",
  "PERF-070",
  "PERF-071",
  "PERF-072",
  "PERF-073",
  "PERF-074",
  "PERF-075",
  "PERF-076",
  "PERF-077",
  "PERF-080",
  "PERF-092",
  "PERF-093",
  "PERF-094",
  "PERF-100",
  "PERF-101",
  "PERF-102",
  "PERF-103",
  "PERF-104",
  "PERF-105",
  "PERF-106",
  "PERF-110",
  "PERF-111",
  "PERF-112",
  "PERF-130",
  "PERF-131",
  "PERF-132",
  "PERF-133",
  "PERF-134",
  "PERF-135",
  "PERF-136",
  "PERF-137",
  "PERF-138",
  "PERF-139",
  "PERF-140",
  "PERF-141",
  "PERF-142",
  "PERF-150",
  "PERF-151",
  "PERF-160",
  "PERF-161",
  "PERF-162",
  "PERF-163",
  "PERF-170",
  "PERF-171",
  "PERF-190",
  "PERF-191",
  "PERF-192",
  "PERF-193",
  "PERF-194",
  "PERF-195",
  "PERF-196",
  "PERF-197",
  "PERF-198",
  "PERF-200",
  "PERF-201",
  "PERF-202",
  "PERF-203",
  "PERF-204",
  "PERF-205",
  "PERF-220",
  "PERF-221",
  "PERF-222",
  "PERF-223",
  "PERF-224",
  "PERF-225",
  "PERF-240",
  "PERF-241",
  "PERF-242",
  "PERF-243",
  "PERF-244",
  "PERF-245",
  "PERF-246",
  "PERF-260",
  "PERF-261",
  "PERF-262",
  "PERF-263",
  "PERF-264",
  "PERF-280",
  "PERF-281",
  "PERF-282",
  "PERF-283",
  "PERF-284",
  "PERF-285",
  "PERF-300",
  "PERF-301",
  "PERF-302",
  "PERF-303",
  "PERF-304",
  "PERF-305",
  "PERF-320",
  "PERF-321",
  "PERF-322",
  "PERF-323",
  "PERF-324",
  "PERF-325",
  "PERF-340",
  "PERF-341",
  "PERF-342",
  "PERF-343",
  "PERF-350",
  "PERF-351",
  "PERF-352",
  "PERF-353",
  "PERF-360",
  "PERF-361",
  "PERF-362",
  "PERF-363",
  "PERF-364",
  "PERF-370",
  "PERF-371",
  "PERF-372",
  "PERF-373",
  "PERF-380",
  "PERF-381",
  "PERF-382",
  "PERF-383",
  "PERF-384",
  "PERF-390",
  "PERF-391",
  "PERF-392",
  "PERF-393",
  "PERF-394",
  "PERF-395",
  "PERF-400",
  "PERF-401",
  "PERF-402",
  "PERF-403",
  "PERF-404",
  "PERF-405",
]);

/**
 * Scenarios deliberately excused from declaring a correctness predicate.
 *
 * EMPTY, and the emptiness is the point — it previously held fifteen scenarios
 * whose oracles lived in fixture modules, and all fifteen now declare one. It
 * survives as a mechanism because a legitimate exception is imaginable: a timer
 * calibration, an intentional no-op control, a purely observational diagnostic.
 *
 * It lives HERE rather than in the matrix test because both readers must agree.
 * The test enforces the declaration at build time and `evaluateCorrectness`
 * enforces it at run time under `--enforce-integrity`; an exemption honoured by
 * one and ignored by the other is a contract that cannot be satisfied — the
 * scenario passes the suite and fails every enforced run.
 */
export const CORRECTNESS_EXEMPT_SCENARIO_IDS: ReadonlySet<string> = new Set<string>([]);

/**
 * Enforce the matrix contract in BOTH directions at runtime, so a scenario
 * added without being declared fails the run rather than only the unit test.
 */
export function assertMatrixCoverage(): void {
  const actualIds = new Set(allScenarios.map((scenario) => scenario.id));

  const missing = [...EXPECTED_SCENARIO_IDS].filter((id) => !actualIds.has(id));
  if (missing.length > 0) {
    throw new Error(`Performance scenario coverage gap. Missing: ${missing.join(", ")}`);
  }

  const undeclared = [...actualIds].filter((id) => !EXPECTED_SCENARIO_IDS.has(id));
  if (undeclared.length > 0) {
    throw new Error(
      `Performance scenario not declared in EXPECTED_SCENARIO_IDS: ${undeclared.join(", ")}`
    );
  }
}
