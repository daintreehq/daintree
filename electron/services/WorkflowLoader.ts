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
  type WorkflowNode,
  type LoopNode,
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn(
          `[WorkflowLoader] Built-in workflows directory not found: ${BUILT_IN_WORKFLOWS_DIR}. Continuing without built-in workflows.`
        );
        return;
      }
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

    // Step 2: Check for pipe character in node IDs (reserved as composite key separator)
    this.validateNodeIdChars(workflow.nodes, errors, "nodes");
    if (errors.length > 0) {
      return { valid: false, errors };
    }

    // Step 3: Check for duplicate node IDs (top-level only; loop bodies checked separately)
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

    // Step 4: Validate loop nodes (nested loops, body IDs, body references, body cycles)
    for (const node of workflow.nodes) {
      if (node.type === "loop") {
        this.validateLoopNode(node, nodeIds, errors);
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    // Step 5: Check for invalid node references (top-level only)
    const nodeIndex = new Map(workflow.nodes.map((n, i) => [n.id, i]));
    for (const node of workflow.nodes) {
      const idx = nodeIndex.get(node.id);
      this.validateNodeReferences(node, nodeIds, `nodes[${idx}]`, errors);
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    // Step 6: Detect cycles in the outer DAG (loop bodies are opaque)
    const cycleResult = this.detectCycles(workflow.nodes);
    if (cycleResult.hasCycle) {
      errors.push({
        type: "cycle",
        message: `Cycle detected: ${cycleResult.cyclePath?.join(" -> ")}`,
        details: { cycle: cycleResult.cyclePath },
      });
      return { valid: false, errors };
    }

    // Step 7: Warnings for potential issues
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
   * Validate that no node IDs contain the pipe character (reserved as composite key separator).
   */
  private validateNodeIdChars(
    nodes: WorkflowNode[],
    errors: WorkflowValidationError[],
    pathPrefix: string
  ): void {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.id.includes("|")) {
        errors.push({
          type: "schema",
          message: `Node ID '${node.id}' must not contain '|' (reserved separator)`,
          path: `${pathPrefix}[${i}].id`,
        });
      }
      if (node.type === "loop") {
        this.validateNodeIdChars(node.body, errors, `${pathPrefix}[${i}].body`);
      }
    }
  }

  /**
   * Validate a loop node: reject nested loops, validate body IDs, body references, body cycles.
   */
  private validateLoopNode(
    loopNode: LoopNode,
    outerNodeIds: Set<string>,
    errors: WorkflowValidationError[]
  ): void {
    // Reject nested loops
    for (const bodyNode of loopNode.body) {
      if (bodyNode.type === "loop") {
        errors.push({
          type: "loop",
          message: `Nested loop nodes are not supported (loop '${loopNode.id}' contains loop '${bodyNode.id}')`,
          path: `loop '${loopNode.id}'.body`,
        });
        return;
      }
    }

    // Validate body node IDs are unique within the body
    const bodyNodeIds = new Set<string>();
    for (const bodyNode of loopNode.body) {
      if (bodyNodeIds.has(bodyNode.id)) {
        errors.push({
          type: "duplicate",
          message: `Duplicate body node ID '${bodyNode.id}' in loop '${loopNode.id}'`,
          path: `loop '${loopNode.id}'.body`,
        });
      }
      bodyNodeIds.add(bodyNode.id);
    }

    // Validate body node IDs do not collide with outer node IDs
    for (const bodyNodeId of bodyNodeIds) {
      if (outerNodeIds.has(bodyNodeId)) {
        errors.push({
          type: "duplicate",
          message: `Body node ID '${bodyNodeId}' in loop '${loopNode.id}' conflicts with outer node ID`,
          path: `loop '${loopNode.id}'.body`,
        });
      }
    }

    // Validate body node references only point to other body nodes
    for (const bodyNode of loopNode.body) {
      this.validateNodeReferences(bodyNode, bodyNodeIds, `loop '${loopNode.id}'.body`, errors);
    }

    // Detect cycles within loop body
    const bodyCycleResult = this.detectCycles(loopNode.body);
    if (bodyCycleResult.hasCycle) {
      errors.push({
        type: "cycle",
        message: `Cycle detected in loop '${loopNode.id}' body: ${bodyCycleResult.cyclePath?.join(" -> ")}`,
        details: { cycle: bodyCycleResult.cyclePath },
      });
    }
  }

  /**
   * Validate that a node's references (dependencies, onSuccess, onFailure, conditions)
   * only point to known node IDs within a given scope.
   */
  private validateNodeReferences(
    node: WorkflowNode,
    validIds: Set<string>,
    pathPrefix: string,
    errors: WorkflowValidationError[]
  ): void {
    for (const depId of node.dependencies || []) {
      if (!validIds.has(depId)) {
        errors.push({
          type: "reference",
          message: `Node '${node.id}' references unknown dependency: ${depId}`,
          path: `${pathPrefix}.dependencies`,
        });
      }
    }

    for (const nextId of node.onSuccess || []) {
      if (!validIds.has(nextId)) {
        errors.push({
          type: "reference",
          message: `Node '${node.id}' references unknown onSuccess node: ${nextId}`,
          path: `${pathPrefix}.onSuccess`,
        });
      }
    }

    for (const nextId of node.onFailure || []) {
      if (!validIds.has(nextId)) {
        errors.push({
          type: "reference",
          message: `Node '${node.id}' references unknown onFailure node: ${nextId}`,
          path: `${pathPrefix}.onFailure`,
        });
      }
    }

    for (const condition of node.conditions || []) {
      if (condition.taskId && !validIds.has(condition.taskId)) {
        errors.push({
          type: "reference",
          message: `Node '${node.id}' condition references unknown task: ${condition.taskId}`,
          path: `${pathPrefix}.conditions`,
        });
      }
    }
  }

  /**
   * Detect cycles in a node graph using DFS.
   * Builds an adjacency list from dependencies and routing edges (onSuccess/onFailure).
   * Works on both the outer workflow graph and loop body sub-graphs.
   */
  private detectCycles(nodes: WorkflowNode[]): {
    hasCycle: boolean;
    cyclePath?: string[];
  } {
    // Build a forward-directed adjacency list:
    // - dependencies: depNode → this node (dep must run first)
    // - onSuccess/onFailure: this node → target (this node triggers target)
    const adj = new Map<string, string[]>();
    for (const node of nodes) {
      if (!adj.has(node.id)) adj.set(node.id, []);
      // Forward routing edges
      for (const target of [...(node.onSuccess || []), ...(node.onFailure || [])]) {
        adj.get(node.id)!.push(target);
      }
      // Dependency edges: dependency → this node (forward execution order)
      for (const depId of node.dependencies || []) {
        if (!adj.has(depId)) adj.set(depId, []);
        adj.get(depId)!.push(node.id);
      }
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
