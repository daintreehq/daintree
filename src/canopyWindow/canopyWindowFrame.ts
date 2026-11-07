import { standaloneCanopyFrame } from "@/components/Canopy/canopyFrame";
import { notify } from "@/lib/notify";

/**
 * The Canopy window's answers to what only a host can decide. It holds no
 * project and moves to none, so nothing here navigates: a pane is left out
 * until Go to pane can reach it, and what needs a project says which one to open.
 */
export const CANOPY_WINDOW_FRAME = standaloneCanopyFrame({
  close: () => void window.electron.window.close(),
  goToRun: null,
  restoreElsewhere: () => {
    notify({
      type: "info",
      title: "Project isn't open",
      message: "Open the project this terminal ran in, then restore it from Canopy.",
      context: { eventKind: "agent" },
      duration: 6000,
    });
  },
  openAssistant: async () => "Open this assistant from its project's Assistant panel.",
});
