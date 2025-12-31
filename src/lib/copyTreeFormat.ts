import type { CopyTreeOptions } from "@shared/types/ipc/copyTree";
import type { TerminalInstance } from "@/store/terminalStore";

type CopyTreeFormat = NonNullable<CopyTreeOptions["format"]>;

const AGENT_FORMAT_MAP: Record<string, CopyTreeFormat> = {
  claude: "xml",
  gemini: "markdown",
  codex: "xml",
  terminal: "xml",
};

export function getFormatForAgent(agentIdOrType?: string): CopyTreeFormat {
  if (!agentIdOrType) return "xml";
  const format = AGENT_FORMAT_MAP[agentIdOrType];
  if (!format) {
    console.warn(`Unknown agent/terminal type "${agentIdOrType}", defaulting to XML format`);
    return "xml";
  }
  return format;
}

export function getFormatForTerminal(
  terminal: Pick<TerminalInstance, "agentId" | "type"> | undefined
): CopyTreeFormat {
  if (!terminal) return "xml";
  return getFormatForAgent(terminal.agentId ?? terminal.type);
}
