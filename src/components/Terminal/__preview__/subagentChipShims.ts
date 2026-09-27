import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type {
  AgentSubagentsResult,
  AgentSubagentTranscriptResult,
} from "@shared/types/ipc/agentSubagents";
import { FIXTURES, isFixtureName, transcriptFor } from "./subagentChipFixtures";

// Imported first by `subagentChip.tsx`, so the bridge is on `window` before any
// store or client module evaluates.
//
// The `codex` and `claude` namespaces are answered for real, because they ARE
// the seam: the chip's hook asks `listSubagents` and each row asks
// `readSubagentTranscript` exactly as they do in the app. Everything else
// degrades to inert.

const params = new URLSearchParams(window.location.search);
const fixtureParam = params.get("fixture") ?? "codex-mixed";
if (!isFixtureName(fixtureParam)) throw new Error(`unknown fixture "${fixtureParam}"`);
const fixture = FIXTURES[fixtureParam];

const NOW = Date.now();
let listCalls = 0;

const never = <T>() => new Promise<T>(() => {});

function list(): Promise<AgentSubagentsResult> {
  listCalls += 1;
  if (fixture.hangRefresh && listCalls > 1) return never();
  return Promise.resolve({
    status: "ok",
    provider: fixture.provider,
    parentId: "root-session",
    subagents: fixture.subagents.map(({ agoMs, ...rest }) => ({
      ...rest,
      createdAt: NOW - agoMs - 60_000,
      updatedAt: NOW - agoMs,
    })),
  });
}

function readTranscript({
  subagentId,
}: {
  subagentId: string;
}): Promise<AgentSubagentTranscriptResult> {
  const result = transcriptFor(fixture, subagentId);
  return result ? Promise.resolve(result) : never();
}

const provider = { listSubagents: list, readSubagentTranscript: readTranscript };

installPreviewShims({ codex: provider, claude: provider });

try {
  window.localStorage.clear();
  window.sessionStorage.clear();
} catch {
  // Storage can be unavailable; the harness renders without it.
}
