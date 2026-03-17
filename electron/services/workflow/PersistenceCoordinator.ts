import type { WorkflowPersistence } from "../persistence/WorkflowPersistence.js";
import type { WorkflowRun } from "../../../shared/types/workflowRun.js";

export class PersistenceCoordinator {
  constructor(
    private persistence: WorkflowPersistence,
    private runs: Map<string, WorkflowRun>,
    private taskToNode: Map<string, { runId: string; nodeId: string }>
  ) {}

  async schedulePersist(projectId: string | null, enabled: boolean): Promise<void> {
    if (!enabled || !projectId) return;

    try {
      const runsArray = Array.from(this.runs.values());
      await this.persistence.save(projectId, runsArray);
    } catch (error) {
      console.error("[WorkflowEngine] Failed to persist workflow state:", error);
    }
  }

  async loadFromDisk(projectId: string): Promise<void> {
    const loadedRuns = await this.persistence.load(projectId);
    this.runs.clear();
    this.taskToNode.clear();

    for (const run of loadedRuns) {
      this.runs.set(run.runId, run);

      for (const [nodeId, taskId] of Object.entries(run.taskMapping)) {
        this.taskToNode.set(taskId, { runId: run.runId, nodeId });
      }
    }

    console.log(`[WorkflowEngine] Loaded ${this.runs.size} workflow runs for project ${projectId}`);
  }

  async flush(projectId: string | null): Promise<void> {
    if (!projectId) return;
    await this.persistence.flush(projectId);
  }

  async saveImmediate(projectId: string): Promise<void> {
    const runsArray = Array.from(this.runs.values());
    await this.persistence.flush(projectId);
    await this.persistence.save(projectId, runsArray);
    await this.persistence.flush(projectId);
  }
}
