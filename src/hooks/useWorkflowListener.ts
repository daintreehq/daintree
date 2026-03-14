import { useEffect } from "react";
import { useWorkflowStore } from "@/store/workflowStore";

export function useWorkflowListener(): void {
  useEffect(() => {
    if (!window.electron?.workflow) return;

    useWorkflowStore.getState().init();

    const cleanupStarted = window.electron.workflow.onStarted(({ runId }) => {
      useWorkflowStore.getState().refreshRun(runId);
    });
    const cleanupCompleted = window.electron.workflow.onCompleted(({ runId }) => {
      useWorkflowStore.getState().refreshRun(runId);
    });
    const cleanupFailed = window.electron.workflow.onFailed(({ runId }) => {
      useWorkflowStore.getState().refreshRun(runId);
    });

    return () => {
      cleanupStarted();
      cleanupCompleted();
      cleanupFailed();
    };
  }, []);
}
