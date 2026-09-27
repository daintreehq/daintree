import type { BuilderStep, CommandManifestEntry, CommandResult } from "@shared/types/commands";
import { CREATE_ISSUE, WORK_ISSUE } from "./commandPickerFixtures";

/**
 * Builder manifests for the command builder harness.
 *
 * `create-issue` and `work-issue` mirror the shipped builders in
 * `electron/services/commands/github*.ts` — the renderer cannot import them, so
 * they are copied here and must be kept in step with the copy there. `wizard`
 * is a plugin-shaped three-step manifest that reaches every field type, a long
 * label, a step with no description and a bounded number, which the shipped
 * commands never do. `empty` is a command whose builder has no steps.
 */

export const BUILDER_FIXTURES = ["create-issue", "work-issue", "wizard", "empty"] as const;
export type BuilderFixture = (typeof BUILDER_FIXTURES)[number];

export function isBuilderFixture(value: string | null): value is BuilderFixture {
  return value !== null && (BUILDER_FIXTURES as readonly string[]).includes(value);
}

const CREATE_ISSUE_STEPS: BuilderStep[] = [
  {
    id: "issue-details",
    title: "Create a GitHub issue",
    description: "Give it a title, an explanation, or both.",
    submitLabel: "Create issue",
    fields: [
      {
        name: "title",
        label: "Title",
        type: "text",
        placeholder: "Add dark mode toggle to settings",
        helpText: "Leave blank to use the first line of the explanation.",
      },
      {
        name: "body",
        label: "Explanation",
        type: "textarea",
        placeholder: "What should change, and why",
        helpText: "Becomes the issue body. Leave blank to use the title.",
      },
      {
        name: "labels",
        label: "Labels",
        type: "text",
        placeholder: "enhancement, ui",
        helpText: "Separate labels with commas.",
      },
    ],
  },
];

const WORK_ISSUE_STEPS: BuilderStep[] = [
  {
    id: "issue",
    title: "Work on a GitHub issue",
    description: "Creates a worktree for the issue and switches to it.",
    submitLabel: "Create worktree",
    fields: [
      {
        name: "issueNumber",
        label: "Issue number",
        type: "number",
        placeholder: "123",
        required: true,
        helpText: "Required. The branch is named after this issue.",
        validation: {
          min: 1,
          integer: true,
          message: "Enter a whole issue number, like 123",
        },
      },
      {
        name: "branchName",
        label: "Branch name",
        type: "text",
        placeholder: "issue-123-add-dark-mode",
        helpText: "Leave blank to name it from the issue title.",
      },
      {
        name: "baseBranch",
        label: "Base branch",
        type: "text",
        placeholder: "develop",
        helpText: "Leave blank to use develop, trunk, main or master, whichever exists first.",
      },
    ],
  },
];

const WIZARD_STEPS: BuilderStep[] = [
  {
    id: "target",
    title: "Choose a target",
    description: "Pick where the release goes. Everything here can be changed later.",
    fields: [
      {
        name: "environment",
        label: "Environment",
        type: "select",
        placeholder: "Choose an environment",
        options: [
          { value: "staging", label: "Staging" },
          { value: "canary", label: "Canary (5% of production)" },
          { value: "production", label: "Production" },
        ],
      },
      {
        name: "releaseName",
        label: "Release name shown to everyone watching the deploy channel",
        type: "text",
        placeholder: "spring-cleanup",
        helpText: "Lowercase letters, numbers and dashes.",
        validation: {
          pattern: "^[a-z0-9-]+$",
          message: "Use lowercase letters, numbers and dashes",
        },
      },
    ],
  },
  {
    id: "rollout",
    title: "Rollout",
    fields: [
      {
        name: "percentage",
        label: "Rollout %",
        type: "number",
        placeholder: "25",
        validation: { min: 1, max: 100 },
        helpText: "Share of traffic that gets the release first.",
      },
      {
        name: "notes",
        label: "Release notes",
        type: "textarea",
        placeholder: "What changed, in a sentence or two",
      },
    ],
  },
  {
    id: "confirm",
    title: "Notifications",
    submitLabel: "Start rollout",
    description: "Who hears about it once the rollout settles.",
    fields: [
      {
        name: "notify",
        label: "Notify channel",
        type: "checkbox",
        helpText: "Posts a summary to the team channel when the rollout finishes.",
      },
      { name: "dryRun", label: "Dry run", type: "checkbox" },
    ],
  },
];

export const WIZARD_COMMAND: CommandManifestEntry = {
  id: "deploy:release",
  label: "/deploy:release",
  description: "Roll a release out to an environment in stages.",
  category: "workflow",
  hasBuilder: true,
  enabled: true,
};

export const EMPTY_COMMAND: CommandManifestEntry = {
  id: "workflow:broken",
  label: "/workflow:broken",
  description: "A command whose builder declares no steps.",
  category: "workflow",
  hasBuilder: true,
  enabled: true,
};

export interface BuilderFixtureData {
  command: CommandManifestEntry;
  steps: BuilderStep[];
  success: CommandResult;
  failure: CommandResult;
}

export function builderFixture(fixture: BuilderFixture): BuilderFixtureData {
  switch (fixture) {
    case "create-issue":
      return {
        command: CREATE_ISSUE,
        steps: CREATE_ISSUE_STEPS,
        success: {
          success: true,
          message: "Issue #12482 created",
          detail: "Command builder loses focus on Execute",
        },
        failure: {
          success: false,
          error: {
            code: "NETWORK_ERROR",
            message: "Cannot reach GitHub. Check your internet connection.",
          },
        },
      };
    case "work-issue":
      return {
        command: WORK_ISSUE,
        steps: WORK_ISSUE_STEPS,
        success: {
          success: true,
          message: "Worktree created for #12391",
          detail: "Switched to issue-12391-command-builder-success-state-restates-the-dialog-title",
        },
        failure: {
          success: false,
          error: { code: "ISSUE_NOT_FOUND", message: "Issue #99999 not found" },
        },
      };
    case "wizard":
      return {
        command: WIZARD_COMMAND,
        steps: WIZARD_STEPS,
        success: {
          success: true,
          message: "Rollout started",
          detail: "spring-cleanup is going to Canary first",
        },
        failure: {
          success: false,
          error: { code: "EXECUTION_ERROR", message: "Deploy service returned 503" },
        },
      };
    case "empty":
      return {
        command: EMPTY_COMMAND,
        steps: [],
        success: { success: true },
        failure: { success: false },
      };
  }
}
