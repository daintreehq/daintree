import { useShallow } from "zustand/react/shallow";
import { useTerminalStore } from "@/store/terminalStore";

export function useWaitingTerminalIds(): string[] {
  return useTerminalStore(
    useShallow((state) =>
      state.terminals
        .filter((t) => t.agentState === "waiting" && !state.isInTrash(t.id))
        .map((t) => t.id)
    )
  );
}
