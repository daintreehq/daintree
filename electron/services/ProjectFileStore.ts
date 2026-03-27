import type { TerminalRecipe, WorkflowDefinition } from "../types/index.js";
import { workflowLoader } from "./WorkflowLoader.js";
import fs from "fs/promises";
import { existsSync } from "fs";
import { resilientRename, resilientAtomicWriteFile } from "../utils/fs.js";
import { getProjectStateDir, recipesFilePath, workflowsFilePath } from "./projectStorePaths.js";

export class ProjectFileStore {
  constructor(private projectsConfigDir: string) {}

  // --- Recipes ---

  async getRecipes(projectId: string): Promise<TerminalRecipe[]> {
    const filePath = recipesFilePath(this.projectsConfigDir, projectId);
    if (!filePath || !existsSync(filePath)) {
      return [];
    }

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);

      if (!Array.isArray(parsed)) {
        console.warn(`[ProjectFileStore] Invalid recipes format for ${projectId}, expected array`);
        return [];
      }

      return parsed.filter(
        (recipe: unknown): recipe is TerminalRecipe =>
          recipe !== null &&
          typeof recipe === "object" &&
          typeof (recipe as TerminalRecipe).id === "string" &&
          typeof (recipe as TerminalRecipe).name === "string" &&
          Array.isArray((recipe as TerminalRecipe).terminals)
      );
    } catch (error) {
      console.error(`[ProjectFileStore] Failed to load recipes for ${projectId}:`, error);
      try {
        const quarantinePath = `${filePath}.corrupted`;
        await resilientRename(filePath, quarantinePath);
        console.warn(`[ProjectFileStore] Corrupted recipes file moved to ${quarantinePath}`);
      } catch {
        // Ignore
      }
      return [];
    }
  }

  async saveRecipes(projectId: string, recipes: TerminalRecipe[]): Promise<void> {
    const stateDir = getProjectStateDir(this.projectsConfigDir, projectId);
    if (!stateDir) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const filePath = recipesFilePath(this.projectsConfigDir, projectId);
    if (!filePath) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const attemptSave = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(stateDir, { recursive: true });
      }
      await resilientAtomicWriteFile(filePath, JSON.stringify(recipes, null, 2), "utf-8");
    };

    try {
      await attemptSave(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) {
        console.error(`[ProjectFileStore] Failed to save recipes for ${projectId}:`, error);
        throw error;
      }

      try {
        await attemptSave(true);
      } catch (retryError) {
        console.error(`[ProjectFileStore] Failed to save recipes for ${projectId}:`, retryError);
        throw retryError;
      }
    }
  }

  async addRecipe(projectId: string, recipe: TerminalRecipe): Promise<void> {
    const recipes = await this.getRecipes(projectId);
    recipes.push(recipe);
    await this.saveRecipes(projectId, recipes);
  }

  async updateRecipe(
    projectId: string,
    recipeId: string,
    updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
  ): Promise<void> {
    const recipes = await this.getRecipes(projectId);
    const index = recipes.findIndex((r) => r.id === recipeId);
    if (index === -1) {
      throw new Error(`Recipe ${recipeId} not found in project ${projectId}`);
    }
    recipes[index] = { ...recipes[index], ...updates };
    await this.saveRecipes(projectId, recipes);
  }

  async deleteRecipe(projectId: string, recipeId: string): Promise<void> {
    const recipes = await this.getRecipes(projectId);
    const filtered = recipes.filter((r) => r.id !== recipeId);
    await this.saveRecipes(projectId, filtered);
  }

  // --- Workflows ---

  async getWorkflows(projectId: string): Promise<WorkflowDefinition[]> {
    const filePath = workflowsFilePath(this.projectsConfigDir, projectId);
    if (!filePath || !existsSync(filePath)) {
      return [];
    }

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);

      if (!Array.isArray(parsed)) {
        console.warn(
          `[ProjectFileStore] Invalid workflows format for ${projectId}, expected array`
        );
        return [];
      }

      return parsed.filter((workflow: unknown): workflow is WorkflowDefinition => {
        const validation = workflowLoader.validate(workflow);
        if (!validation.valid) {
          const workflowId =
            workflow &&
            typeof workflow === "object" &&
            "id" in workflow &&
            typeof (workflow as { id: unknown }).id === "string"
              ? (workflow as { id: string }).id
              : "unknown";
          const errors = validation.errors?.map((e) => e.message).join("; ");
          console.warn(`[ProjectFileStore] Filtering invalid workflow ${workflowId}: ${errors}`);
          return false;
        }
        return true;
      });
    } catch (error) {
      console.error(`[ProjectFileStore] Failed to load workflows for ${projectId}:`, error);
      try {
        const quarantinePath = `${filePath}.corrupted`;
        await resilientRename(filePath, quarantinePath);
        console.warn(`[ProjectFileStore] Corrupted workflows file moved to ${quarantinePath}`);
      } catch {
        // Ignore
      }
      return [];
    }
  }

  async saveWorkflows(projectId: string, workflows: WorkflowDefinition[]): Promise<void> {
    const stateDir = getProjectStateDir(this.projectsConfigDir, projectId);
    if (!stateDir) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const filePath = workflowsFilePath(this.projectsConfigDir, projectId);
    if (!filePath) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    for (const workflow of workflows) {
      const validation = workflowLoader.validate(workflow);
      if (!validation.valid) {
        const errors = validation.errors?.map((e) => e.message).join("; ");
        throw new Error(`Invalid workflow ${workflow.id}: ${errors}`);
      }
    }

    const attemptSave = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(stateDir, { recursive: true });
      }
      await resilientAtomicWriteFile(filePath, JSON.stringify(workflows, null, 2), "utf-8");
    };

    try {
      await attemptSave(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) {
        console.error(`[ProjectFileStore] Failed to save workflows for ${projectId}:`, error);
        throw error;
      }

      try {
        await attemptSave(true);
      } catch (retryError) {
        console.error(`[ProjectFileStore] Failed to save workflows for ${projectId}:`, retryError);
        throw retryError;
      }
    }
  }

  async addWorkflow(projectId: string, workflow: WorkflowDefinition): Promise<void> {
    const validation = workflowLoader.validate(workflow);
    if (!validation.valid) {
      const errors = validation.errors?.map((e) => e.message).join("; ");
      throw new Error(`Invalid workflow: ${errors}`);
    }

    const workflows = await this.getWorkflows(projectId);

    if (workflows.some((w) => w.id === workflow.id)) {
      throw new Error(`Workflow with ID ${workflow.id} already exists`);
    }

    workflows.push(workflow);
    await this.saveWorkflows(projectId, workflows);
  }

  async updateWorkflow(
    projectId: string,
    workflowId: string,
    updates: Partial<Omit<WorkflowDefinition, "id">>
  ): Promise<void> {
    const workflows = await this.getWorkflows(projectId);
    const index = workflows.findIndex((w) => w.id === workflowId);
    if (index === -1) {
      throw new Error(`Workflow ${workflowId} not found in project ${projectId}`);
    }

    const updated = { ...workflows[index], ...updates };

    const validation = workflowLoader.validate(updated);
    if (!validation.valid) {
      const errors = validation.errors?.map((e) => e.message).join("; ");
      throw new Error(`Invalid workflow update: ${errors}`);
    }

    workflows[index] = updated;
    await this.saveWorkflows(projectId, workflows);
  }

  async deleteWorkflow(projectId: string, workflowId: string): Promise<void> {
    const workflows = await this.getWorkflows(projectId);
    const filtered = workflows.filter((w) => w.id !== workflowId);
    await this.saveWorkflows(projectId, filtered);
  }

  async getWorkflow(projectId: string, workflowId: string): Promise<WorkflowDefinition | null> {
    const workflows = await this.getWorkflows(projectId);
    return workflows.find((w) => w.id === workflowId) || null;
  }
}
