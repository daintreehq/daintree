import { useEffect, useRef } from "react";
import { isElectronAvailable } from "../useElectron";
import { useTerminalStore } from "@/store/terminalStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { useRecipeStore } from "@/store/recipeStore";
import { notify } from "@/lib/notify";

interface MilestoneDefinition {
  id: string;
  title: string;
  message: string;
}

const MILESTONES: MilestoneDefinition[] = [
  {
    id: "first-agent-completed",
    title: "First task complete",
    message: "Your first agent task just finished.",
  },
  {
    id: "first-concurrent-agents",
    title: "Welcome to orchestration",
    message: "Three or more agents are running at once.",
  },
  {
    id: "first-context-injection",
    title: "Context shared",
    message: "Your first context injection landed.",
  },
  {
    id: "first-pr-merged",
    title: "Shipped",
    message: "Your first worktree PR has been merged.",
  },
  {
    id: "first-recipe-used",
    title: "Recipe activated",
    message: "You ran your first terminal recipe.",
  },
];

const TOAST_DURATION = 5000;
const TOAST_STAGGER = 5500;

function checkAgentCompleted(): boolean {
  return useTerminalStore.getState().terminals.some((t) => t.agentState === "completed");
}

function checkConcurrentAgents(): boolean {
  return (
    useTerminalStore.getState().terminals.filter((t) => t.agentState === "working").length >= 3
  );
}

function checkContextInjection(): boolean {
  try {
    return localStorage.getItem("canopy:context-injected-once") === "true";
  } catch {
    return false;
  }
}

function checkPRMerged(): boolean {
  const worktrees = getCurrentViewStore().getState().worktrees;
  for (const w of worktrees.values()) {
    if (w.prState === "merged") return true;
  }
  return false;
}

function checkRecipeUsed(): boolean {
  return useRecipeStore.getState().recipes.some((r) => r.lastUsedAt != null);
}

function reconcile(shown: Record<string, boolean>, markShown: (id: string) => void): void {
  const checks: Record<string, () => boolean> = {
    "first-agent-completed": checkAgentCompleted,
    "first-concurrent-agents": checkConcurrentAgents,
    "first-context-injection": checkContextInjection,
    "first-pr-merged": checkPRMerged,
    "first-recipe-used": checkRecipeUsed,
  };

  for (const [id, check] of Object.entries(checks)) {
    if (!shown[id] && check()) {
      markShown(id);
    }
  }
}

export function useOrchestrationMilestones(isStateLoaded: boolean): void {
  const shownRef = useRef<Record<string, boolean>>({});
  const queueRef = useRef<string[]>([]);
  const drainingRef = useRef(false);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded || hydratedRef.current) return;
    hydratedRef.current = true;

    let disposed = false;
    const unsubs: (() => void)[] = [];

    const markShownSilent = (id: string) => {
      shownRef.current[id] = true;
      void window.electron.milestones.markShown(id);
    };

    const showToast = (id: string) => {
      if (shownRef.current[id]) return;
      shownRef.current[id] = true;
      void window.electron.milestones.markShown(id);
      queueRef.current.push(id);
      drainQueue();
    };

    const drainQueue = () => {
      if (drainingRef.current) return;
      const next = queueRef.current.shift();
      if (!next) return;
      drainingRef.current = true;

      const milestone = MILESTONES.find((m) => m.id === next);
      if (milestone) {
        notify({
          type: "success",
          title: milestone.title,
          message: milestone.message,
          duration: TOAST_DURATION,
        });
      }

      setTimeout(() => {
        drainingRef.current = false;
        drainQueue();
      }, TOAST_STAGGER);
    };

    window.electron.milestones
      .get()
      .then((persisted) => {
        if (disposed) return;
        shownRef.current = { ...persisted };
        reconcile(shownRef.current, markShownSilent);

        const shown = shownRef.current;

        unsubs.push(
          useTerminalStore.subscribe((state, prev) => {
            if (!shown["first-agent-completed"]) {
              const had = prev.terminals.some((t) => t.agentState === "completed");
              const has = state.terminals.some((t) => t.agentState === "completed");
              if (!had && has) showToast("first-agent-completed");
            }

            if (!shown["first-concurrent-agents"]) {
              const prevCount = prev.terminals.filter((t) => t.agentState === "working").length;
              const curCount = state.terminals.filter((t) => t.agentState === "working").length;
              if (prevCount < 3 && curCount >= 3) showToast("first-concurrent-agents");
            }
          })
        );

        const viewStore = getCurrentViewStore();
        unsubs.push(
          viewStore.subscribe((state, prev) => {
            if (shown["first-pr-merged"]) return;
            for (const [id, w] of state.worktrees) {
              if (w.prState === "merged") {
                const prevW = prev.worktrees.get(id);
                if (!prevW || prevW.prState !== "merged") {
                  showToast("first-pr-merged");
                  return;
                }
              }
            }
          })
        );

        unsubs.push(
          useRecipeStore.subscribe((state, prev) => {
            if (shown["first-recipe-used"]) return;
            const hadUsed = prev.recipes.some((r) => r.lastUsedAt != null);
            const hasUsed = state.recipes.some((r) => r.lastUsedAt != null);
            if (!hadUsed && hasUsed) showToast("first-recipe-used");
          })
        );

        const onContextInjected = () => {
          if (!shown["first-context-injection"]) {
            showToast("first-context-injection");
          }
        };
        window.addEventListener("canopy:context-injected", onContextInjected);
        unsubs.push(() => window.removeEventListener("canopy:context-injected", onContextInjected));
      })
      .catch(console.error);

    return () => {
      disposed = true;
      for (const unsub of unsubs) unsub();
    };
  }, [isStateLoaded]);
}
