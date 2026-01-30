/**
 * WorkflowLoader - Load and validate workflow definitions
 *
 * Loads workflow templates from JSON, validates them with Zod,
 * and detects cycles in the node graph using DFS.
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowValidationResult,
  type WorkflowValidationError,
  type LoadedWorkflow,
  type WorkflowSource,
  type WorkflowSummary,
} from "../../shared/types/workflow.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUILT_IN_WORKFLOWS_DIR = path.join(__dirname, "..", "workflows");

export class WorkflowLoader {
  private builtInWorkflows: Map<string, LoadedWorkflow> = new Map();
  private projectWorkflows: Map<string, LoadedWorkflow> = new Map();
  private initialized = false;

  /**
   * Initialize the loader by loading built-in workflows.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.loadBuiltInWorkflows();
    this.initialized = true;
  }

  /**
   * Load all built-in workflows from the workflows directory.
   */
  private async loadBuiltInWorkflows(): Promise<void> {
    try {
      const files = await fs.readdir(BUILT_IN_WORKFLOWS_DIR);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));

      for (const file of jsonFiles) {
        const filePath = path.join(BUILT_IN_WORKFLOWS_DIR, file);
        try {
          const workflow = await this.loadFromFile(filePath, "built-in");
          if (workflow) {
            this.builtInWorkflows.set(workflow.definition.id, workflow);
          }
        } catch (error) {
          console.error(`[WorkflowLoader] Failed to load built-in workflow ${file}:`, error);
        }
      }

      console.log(`[WorkflowLoader] Loaded ${this.builtInWorkflows.size} built-in workflow(s)`);
    } catch (error) {
      console.error("[WorkflowLoader] Failed to read built-in workflows directory:", error);
    }
  }

  /**
   * Load a workflow from a JSON file.
   */
  async loadFromFile(filePath: string, source: WorkflowSource): Promise<LoadedWorkflow | null> {
    const content = await fs.readFile(filePath, "utf-8");
    const json = JSON.parse(content);

    const validation = this.validate(json);
    if (!validation.valid) {
      const errorMessages = validation.errors?.map((e) => e.message).join("; ");
      throw new Error(`Invalid workflow in ${filePath}: ${errorMessages}`);
    }

    // Use validated data from Zod parse
    const parseResult = WorkflowDefinitionSchema.safeParse(json);
    if (!parseResult.success) {
      throw new Error(`Schema validation failed for ${filePath}`);
    }

    return {
      definition: parseResult.data,
      source,
      filePath,
      loadedAt: Date.now(),
    };
  }

  /**
   * Load a workflow from a JSON object.
   */
  loadFromJson(json: unknown, source: WorkflowSource): LoadedWorkflow | null {
    const validation = this.validate(json);
    if (!validation.valid) {
      const errorMessages = validation.errors?.map((e) => e.message).join("; ");
      throw new Error(`Invalid workflow: ${errorMessages}`);
    }

    // Use validated data from Zod parse
    const parseResult = WorkflowDefinitionSchema.safeParse(json);
    if (!parseResult.success) {
      throw new Error(`Schema validation failed`);
    }

    return {
      definition: parseResult.data,
      source,
      loadedAt: Date.now(),
    };
  }

  /**
   * Validate a workflow definition.
   * Checks schema validity and graph acyclicity.
   */
  validate(data: unknown): WorkflowValidationResult {
    const errors: WorkflowValidationError[] = [];
    const warnings: string[] = [];

    // Step 1: Schema validation with Zod
    const parseResult = WorkflowDefinitionSchema.safeParse(data);
    if (!parseResult.success) {
      const zodErrors = parseResult.error.flatten();

      // Field errors
      for (const [field, messages] of Object.entries(zodErrors.fieldErrors)) {
        for (const message of messages || []) {
          errors.push({
            type: "schema",
            message: `${field}: ${message}`,
            path: field,
          });
        }
      }

      // Form errors
      for (const message of zodErrors.formErrors) {
        errors.push({
          type: "schema",
          message,
        });
      }

      return { valid: false, errors };
    }

    const workflow = parseResult.data;

    // Step 2: Check for duplicate node IDs
    const nodeIds = new Set<string>();
    for (const node of workflow.nodes) {
      if (nodeIds.has(node.id)) {
        errors.push({
          type: "duplicate",
          message: `Duplicate node ID: ${node.id}`,
          path: `nodes`,
        });
      }
      nodeIds.add(node.id);
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    // Step 3: Check for invalid node references
    const nodeIndex = new Map(workflow.nodes.map((n, i) => [n.id, i]));
    for (const node of workflow.nodes) {
      const idx = nodeIndex.get(node.id);

      // Check dependencies
      for (const depId of node.dependencies || []) {
        if (!nodeIds.has(depId)) {
          errors.push({
            type: "reference",
            message: `Node '${node.id}' references unknown dependency: ${depId}`,
            path: `nodes[${idx}].dependencies`,
          });
        }
      }

      // Check onSuccess references
      for (const nextId of node.onSuccess || []) {
        if (!nodeIds.has(nextId)) {
          errors.push({
            type: "reference",
            message: `Node '${node.id}' references unknown onSuccess node: ${nextId}`,
            path: `nodes[${idx}].onSuccess`,
          });
        }
      }

      // Check onFailure references
      for (const nextId of node.onFailure || []) {
        if (!nodeIds.has(nextId)) {
          errors.push({
            type: "reference",
            message: `Node '${node.id}' references unknown onFailure node: ${nextId}`,
            path: `nodes[${idx}].onFailure`,
          });
        }
      }

      // Check condition taskId references
      for (const condition of node.conditions || []) {
        if (condition.taskId && !nodeIds.has(condition.taskId)) {
          errors.push({
            type: "reference",
            message: `Node '${node.id}' condition references unknown task: ${condition.taskId}`,
            path: `nodes[${idx}].conditions`,
          });
        }
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    // Step 4: Detect cycles using DFS
    const cycleResult = this.detectCycles(workflow);
    if (cycleResult.hasCycle) {
      errors.push({
        type: "cycle",
        message: `Cycle detected: ${cycleResult.cyclePath?.join(" -> ")}`,
        details: { cycle: cycleResult.cyclePath },
      });
      return { valid: false, errors };
    }

    // Step 5: Warnings for potential issues
    const entryNodes = workflow.nodes.filter((n) => !n.dependencies || n.dependencies.length === 0);
    if (entryNodes.length === 0) {
      warnings.push("No entry nodes found (all nodes have dependencies)");
    }

    const terminalNodes = workflow.nodes.filter(
      (n) =>
        (!n.onSuccess || n.onSuccess.length === 0) && (!n.onFailure || n.onFailure.length === 0)
    );
    if (terminalNodes.length === 0) {
      warnings.push("No terminal nodes found (all nodes have successors)");
    }

    return {
      valid: true,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Detect cycles in the workflow graph using DFS.
   * Builds an adjacency list from dependencies and routing edges (onSuccess/onFailure).
   * This ensures no execution path can loop infinitely.
   */
  private detectCycles(workflow: WorkflowDefinition): {
    hasCycle: boolean;
    cyclePath?: string[];
  } {
    // Build adjacency list: node -> all nodes it can reach
    // Include dependencies (must run before), onSuccess, and onFailure edges
    const adj = new Map<string, string[]>();
    for (const node of workflow.nodes) {
      const edges = [
        ...(node.dependencies || []),
        ...(node.onSuccess || []),
        ...(node.onFailure || []),
      ];
      adj.set(node.id, edges);
    }

    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const hasCycle = (nodeId: string): string[] | null => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);

      const neighbors = adj.get(nodeId) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          const cycle = hasCycle(neighbor);
          if (cycle) return cycle;
        } else if (recursionStack.has(neighbor)) {
          // Found a cycle
          const cycleStart = path.indexOf(neighbor);
          return [...path.slice(cycleStart), neighbor];
        }
      }

      path.pop();
      recursionStack.delete(nodeId);
      return null;
    };

    // Check from all unvisited nodes
    for (const nodeId of adj.keys()) {
      if (!visited.has(nodeId)) {
        const cycle = hasCycle(nodeId);
        if (cycle) {
          return { hasCycle: true, cyclePath: cycle };
        }
      }
    }

    return { hasCycle: false };
  }

  /**
   * Get a workflow by ID.
   * Searches built-in workflows first, then project workflows.
   */
  async getWorkflow(id: string): Promise<LoadedWorkflow | null> {
    await this.initialize();

    // Check built-in first
    if (this.builtInWorkflows.has(id)) {
      return this.builtInWorkflows.get(id)!;
    }

    // Then project workflows
    if (this.projectWorkflows.has(id)) {
      return this.projectWorkflows.get(id)!;
    }

    return null;
  }

  /**
   * List all available workflows.
   */
  async listWorkflows(): Promise<WorkflowSummary[]> {
    await this.initialize();

    const summaries: WorkflowSummary[] = [];

    for (const workflow of this.builtInWorkflows.values()) {
      summaries.push(this.toSummary(workflow));
    }

    for (const workflow of this.projectWorkflows.values()) {
      summaries.push(this.toSummary(workflow));
    }

    return summaries;
  }

  /**
   * Convert a loaded workflow to a summary.
   */
  private toSummary(workflow: LoadedWorkflow): WorkflowSummary {
    return {
      id: workflow.definition.id,
      name: workflow.definition.name,
      description: workflow.definition.description,
      version: workflow.definition.version,
      nodeCount: workflow.definition.nodes.length,
      source: workflow.source,
    };
  }

  /**
   * Load project-specific workflows from a directory.
   */
  async loadProjectWorkflows(workflowsDir: string): Promise<void> {
    this.projectWorkflows.clear();

    try {
      const files = await fs.readdir(workflowsDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));

      for (const file of jsonFiles) {
        const filePath = path.join(workflowsDir, file);
        try {
          const workflow = await this.loadFromFile(filePath, "project");
          if (workflow) {
            this.projectWorkflows.set(workflow.definition.id, workflow);
          }
        } catch (error) {
          console.error(`[WorkflowLoader] Failed to load project workflow ${file}:`, error);
        }
      }

      console.log(`[WorkflowLoader] Loaded ${this.projectWorkflows.size} project workflow(s)`);
    } catch (error) {
      // Directory might not exist, which is fine
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[WorkflowLoader] Failed to read project workflows directory:", error);
      }
    }
  }

  /**
   * Register a workflow from JSON data.
   */
  registerWorkflow(json: unknown, source: WorkflowSource): LoadedWorkflow {
    const workflow = this.loadFromJson(json, source);
    if (!workflow) {
      throw new Error("Failed to load workflow from JSON");
    }

    if (source === "project") {
      this.projectWorkflows.set(workflow.definition.id, workflow);
    }

    return workflow;
  }

  /**
   * Unregister a project workflow.
   */
  unregisterWorkflow(id: string): boolean {
    return this.projectWorkflows.delete(id);
  }

  /**
   * Clear all project workflows.
   */
  clearProjectWorkflows(): void {
    this.projectWorkflows.clear();
  }
}

export const workflowLoader = new WorkflowLoader();
