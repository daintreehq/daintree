import type { LoopNode, WorkflowNode, WorkflowDefinition } from "../../../shared/types/workflow.js";
import type { WorkflowRun, NodeState, LoopNodeState } from "../../../shared/types/workflowRun.js";
import type { TaskQueueService } from "../TaskQueueService.js";
import { evaluateCondition } from "./ConditionEvaluator.js";
import { hasTemplateExpressions, resolveTemplateArgs } from "./TemplateResolver.js";

export const COMPOSITE_SEP = "|";

export function buildCompositeId(loopId: string, iterIndex: number, bodyNodeId: string): string {
  return `${loopId}${COMPOSITE_SEP}${iterIndex}${COMPOSITE_SEP}${bodyNodeId}`;
}

export function parseCompositeId(
  key: string
): { loopNodeId: string; iterIndex: number; bodyNodeId: string } | null {
  const first = key.indexOf(COMPOSITE_SEP);
  if (first === -1) return null;
  const second = key.indexOf(COMPOSITE_SEP, first + 1);
  if (second === -1) return null;
  return {
    loopNodeId: key.substring(0, first),
    iterIndex: parseInt(key.substring(first + 1, second), 10),
    bodyNodeId: key.substring(second + 1),
  };
}

export function findLoopNode(
  definition: WorkflowDefinition,
  loopNodeId: string
): LoopNode | undefined {
  const node = definition.nodes.find((n) => n.id === loopNodeId);
  return node?.type === "loop" ? (node as LoopNode) : undefined;
}

export interface LoopCompilerCallbacks {
  schedulePersist: () => Promise<void>;
  compileNodeToTask: (node: WorkflowNode, run: WorkflowRun) => Promise<unknown>;
  checkWorkflowCompletion: (run: WorkflowRun) => Promise<void>;
  evaluateRouting: (
    node: WorkflowNode,
    nodeState: NodeState,
    run: WorkflowRun,
    routingKey: "onSuccess" | "onFailure"
  ) => Promise<string[]>;
}

export class LoopCompiler {
  constructor(
    private queueService: TaskQueueService,
    private taskToNode: Map<string, { runId: string; nodeId: string }>
  ) {}

  async compileLoopNode(loopNode: LoopNode, run: WorkflowRun): Promise<void> {
    if (run.scheduledNodes.has(loopNode.id)) return;
    run.scheduledNodes.add(loopNode.id);

    const loopState: LoopNodeState = {
      status: "running",
      startedAt: Date.now(),
      currentIteration: 0,
      maxIterations: loopNode.config.maxIterations,
      exitedEarly: false,
    };
    run.nodeStates[loopNode.id] = loopState;

    await this.compileBodyIteration(loopNode, run, 0);
  }

  async compileBodyIteration(
    loopNode: LoopNode,
    run: WorkflowRun,
    iterIndex: number
  ): Promise<void> {
    const roots = loopNode.body.filter((n) => !n.dependencies || n.dependencies.length === 0);

    for (const bodyNode of roots) {
      await this.compileSingleBodyNode(bodyNode, loopNode, run, iterIndex);
    }
  }

  async compileSingleBodyNode(
    bodyNode: WorkflowNode,
    loopNode: LoopNode,
    run: WorkflowRun,
    iterIndex: number
  ): Promise<void> {
    if (bodyNode.type !== "action") return;

    const compositeId = buildCompositeId(loopNode.id, iterIndex, bodyNode.id);

    if (run.scheduledNodes.has(compositeId)) return;
    run.scheduledNodes.add(compositeId);

    const now = Date.now();
    const nodeState: NodeState = {
      status: "draft",
      startedAt: now,
    };
    run.nodeStates[compositeId] = nodeState;

    const dependencies = bodyNode.dependencies || [];
    const resolvedDeps: string[] = [];
    for (const depId of dependencies) {
      const depCompositeId = buildCompositeId(loopNode.id, iterIndex, depId);
      const taskId = run.taskMapping[depCompositeId];
      if (!taskId) {
        throw new Error(
          `Cannot compile body node ${bodyNode.id} in loop ${loopNode.id}: dependency ${depId} has not been scheduled yet`
        );
      }
      resolvedDeps.push(taskId);
    }

    let resolvedArgs = bodyNode.config.args;
    if (resolvedArgs && hasTemplateExpressions(resolvedArgs)) {
      const stateContext = { ...run.nodeStates };
      if (iterIndex > 0) {
        for (const bn of loopNode.body) {
          const prevComposite = buildCompositeId(loopNode.id, iterIndex - 1, bn.id);
          const prevState = run.nodeStates[prevComposite];
          if (prevState) {
            stateContext[bn.id] = prevState;
          }
        }
      }
      try {
        resolvedArgs = resolveTemplateArgs(resolvedArgs, stateContext);
      } catch (error) {
        await this.failBodyNode(compositeId, loopNode, run, (error as Error).message);
        return;
      }
    }

    const task = await this.queueService.createTask({
      title: `Workflow ${run.workflowId} - Loop ${loopNode.id}[${iterIndex}] - ${bodyNode.id}`,
      description: `Execute action: ${bodyNode.config.actionId}`,
      priority: 0,
      dependencies: resolvedDeps,
      metadata: {
        workflowRunId: run.runId,
        workflowId: run.workflowId,
        nodeId: compositeId,
        loopNodeId: loopNode.id,
        iterIndex,
        bodyNodeId: bodyNode.id,
        actionId: bodyNode.config.actionId,
        actionArgs: resolvedArgs,
      },
    });

    nodeState.taskId = task.id;
    nodeState.status = task.status;
    run.taskMapping[compositeId] = task.id;

    this.taskToNode.set(task.id, { runId: run.runId, nodeId: compositeId });

    await this.queueService.enqueueTask(task.id);
  }

  async failBodyNode(
    compositeId: string,
    loopNode: LoopNode,
    run: WorkflowRun,
    error: string
  ): Promise<void> {
    const nodeState = run.nodeStates[compositeId];
    if (!nodeState) return;

    nodeState.status = "failed";
    nodeState.completedAt = Date.now();
    nodeState.result = { error };

    const parsed = parseCompositeId(compositeId);
    if (parsed) {
      await this.checkLoopIterationComplete(loopNode, run, parsed.iterIndex);
    }
  }

  async handleBodyNodeComplete(
    composite: { loopNodeId: string; iterIndex: number; bodyNodeId: string },
    run: WorkflowRun
  ): Promise<void> {
    const loopNode = findLoopNode(run.definition, composite.loopNodeId);
    if (!loopNode) return;

    const bodyNode = loopNode.body.find((n) => n.id === composite.bodyNodeId);
    if (!bodyNode) return;

    for (const candidate of loopNode.body) {
      if (!candidate.dependencies || candidate.dependencies.length === 0) continue;
      const candidateComposite = buildCompositeId(
        composite.loopNodeId,
        composite.iterIndex,
        candidate.id
      );
      if (run.scheduledNodes.has(candidateComposite)) continue;

      const allDepsMet = candidate.dependencies.every((depId) => {
        const depComposite = buildCompositeId(composite.loopNodeId, composite.iterIndex, depId);
        const depState = run.nodeStates[depComposite];
        return depState?.status === "completed";
      });

      if (allDepsMet) {
        await this.compileSingleBodyNode(candidate, loopNode, run, composite.iterIndex);
      }
    }

    for (const nextId of bodyNode.onSuccess || []) {
      const nextBodyNode = loopNode.body.find((n) => n.id === nextId);
      if (nextBodyNode) {
        const nextComposite = buildCompositeId(composite.loopNodeId, composite.iterIndex, nextId);
        if (!run.scheduledNodes.has(nextComposite)) {
          await this.compileSingleBodyNode(nextBodyNode, loopNode, run, composite.iterIndex);
        }
      }
    }

    await this.checkLoopIterationComplete(loopNode, run, composite.iterIndex);
  }

  async handleBodyNodeFailed(
    composite: { loopNodeId: string; iterIndex: number; bodyNodeId: string },
    run: WorkflowRun
  ): Promise<void> {
    const loopNode = findLoopNode(run.definition, composite.loopNodeId);
    if (!loopNode) return;

    const bodyNode = loopNode.body.find((n) => n.id === composite.bodyNodeId);
    if (!bodyNode) return;

    const hasFailureHandler = bodyNode.onFailure && bodyNode.onFailure.length > 0;

    if (hasFailureHandler) {
      for (const nextId of bodyNode.onFailure!) {
        const nextBodyNode = loopNode.body.find((n) => n.id === nextId);
        if (nextBodyNode) {
          const nextComposite = buildCompositeId(composite.loopNodeId, composite.iterIndex, nextId);
          if (!run.scheduledNodes.has(nextComposite)) {
            await this.compileSingleBodyNode(nextBodyNode, loopNode, run, composite.iterIndex);
          }
        }
      }
    } else {
      for (const bn of loopNode.body) {
        const cid = buildCompositeId(composite.loopNodeId, composite.iterIndex, bn.id);
        const state = run.nodeStates[cid];
        if (
          state &&
          state.status !== "completed" &&
          state.status !== "failed" &&
          state.status !== "cancelled"
        ) {
          state.status = "cancelled";
          state.completedAt = Date.now();
          if (state.taskId) {
            try {
              await this.queueService.cancelTask(state.taskId);
            } catch (_e) {
              /* best effort */
            }
          }
        }
      }
    }

    await this.checkLoopIterationComplete(loopNode, run, composite.iterIndex);
  }

  async checkLoopIterationComplete(
    loopNode: LoopNode,
    run: WorkflowRun,
    iterIndex: number
  ): Promise<void> {
    for (const bodyNode of loopNode.body) {
      const compositeId = buildCompositeId(loopNode.id, iterIndex, bodyNode.id);
      if (!run.scheduledNodes.has(compositeId)) continue;
      const state = run.nodeStates[compositeId];
      if (!state) return;
      if (
        state.status !== "completed" &&
        state.status !== "failed" &&
        state.status !== "cancelled"
      ) {
        return;
      }
    }

    const loopState = run.nodeStates[loopNode.id] as LoopNodeState;
    if (!loopState || loopState.status !== "running") return;

    const iterStates: Record<string, NodeState> = {};
    for (const bodyNode of loopNode.body) {
      const compositeId = buildCompositeId(loopNode.id, iterIndex, bodyNode.id);
      const state = run.nodeStates[compositeId];
      if (state) {
        iterStates[bodyNode.id] = state;
      }
    }

    const anyBodyFailed = loopNode.body.some((bn) => {
      const cid = buildCompositeId(loopNode.id, iterIndex, bn.id);
      const state = run.nodeStates[cid];
      return state?.status === "failed";
    });

    let exitConditionMet = false;
    if (loopNode.config.exitCondition && !anyBodyFailed) {
      const lastBodyNode = loopNode.body[loopNode.body.length - 1];
      const lastComposite = buildCompositeId(loopNode.id, iterIndex, lastBodyNode.id);
      const lastState = run.nodeStates[lastComposite];
      if (lastState) {
        exitConditionMet = evaluateCondition(loopNode.config.exitCondition, lastState, {
          ...run,
          nodeStates: { ...run.nodeStates, ...iterStates },
        });
      }
    }

    const now = Date.now();

    if (exitConditionMet) {
      loopState.status = "completed";
      loopState.completedAt = now;
      loopState.exitedEarly = true;
    } else if (anyBodyFailed) {
      loopState.status = "failed";
      loopState.completedAt = now;
      loopState.result = { error: `Loop body failed at iteration ${iterIndex}` };
    } else if (iterIndex < loopNode.config.maxIterations - 1) {
      const nextIter = iterIndex + 1;
      loopState.currentIteration = nextIter;
      await this.compileBodyIteration(loopNode, run, nextIter);
    } else {
      loopState.status = "completed";
      loopState.completedAt = now;
      loopState.exitedEarly = false;
    }
  }
}
