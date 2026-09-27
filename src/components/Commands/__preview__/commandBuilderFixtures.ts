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
    title: "Create GitHub Issue",
    description:
      "Create a well-structured issue that provides enough context for developers or AI agents to implement autonomously",
    fields: [
      {
        name: "title",
        label: "Issue Title",
        type: "text",
        placeholder: "Optional - agent can generate from your explanation",
        helpText: "Leave empty to let the agent generate a title from your explanation",
      },
      {
        name: "body",
        label: "Explanation",
        type: "textarea",
        placeholder: "Explain what you want to create an issue about...",
        helpText:
          "Describe the issue in natural language. The agent will interpret and format appropriately.",
      },
      {
        name: "labels",
        label: "Labels",
        type: "text",
        placeholder: "enhancement, ui",
        helpText:
          "Common labels: bug, enhancement, documentation, refactor, testing, ui, api, performance",
      },
    ],
  },
];

const WORK_ISSUE_STEPS: BuilderStep[] = [
  {
    id: "issue",
    title: "Work on GitHub Issue",
    description:
      "Create an isolated worktree for the issue. By default, the worktree is created in a sibling " +
      "directory, allowing you to work on multiple issues simultaneously without conflicts.",
    fields: [
      {
        name: "issueNumber",
        label: "Issue Number",
        type: "number",
        placeholder: "e.g., 123",
        validation: { min: 1, message: "Issue number must be a positive integer" },
        helpText: "The GitHub issue number. Leave empty to let the agent help you find one.",
      },
      {
        name: "branchName",
        label: "Branch Name (Optional)",
        type: "text",
        placeholder: "issue-1234-add-dark-mode",
        helpText:
          "Leave empty to auto-generate from issue title. Format: issue-{number}-{slugified-title}. " +
          "If the branch already exists, a suffix will be added automatically.",
      },
      {
        name: "baseBranch",
        label: "Base Branch (Optional)",
        type: "text",
        placeholder: "develop",
        helpText:
          "Branch to start from. Auto-detects: uses 'develop' if it exists, otherwise tries 'trunk', 'main', then 'master'. " +
          "Override for hotfixes (use 'main') or feature branches (use specific branch).",
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
        validation: { pattern: "^[a-z0-9-]+$", message: "Use lowercase letters, numbers and dashes" },
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
        success: { success: true, message: "Issue #12482 created successfully" },
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
          message:
            "Created worktree for issue #12391: Command builder success state restates the dialog title instead of naming the result",
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
        success: { success: true, message: "spring-cleanup is rolling out to Canary" },
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
