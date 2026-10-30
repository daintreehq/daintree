// Content contributions: skills, assistant knowledge, themes, prompt templates and project templates.

import { z } from "zod";
import { SAFE_ID_PATTERN } from "../pluginIdentifiers.js";
import {
  PROMPT_TEMPLATE_ARG_NAME_PATTERN,
  PROMPT_TEMPLATE_MAX_ARGS,
  PROMPT_TEMPLATE_MAX_BODY_LENGTH,
} from "../../../shared/utils/pluginPromptTemplates.js";
import { isSafePluginAssetPath } from "./common.js";

/**
 * `contributes.skills` manifest entry (#10892). A skill is a plugin-shipped
 * markdown file surfaced to agents via the built-in MCP server's
 * `skills.search` / `skills.load` tools. `path` reuses the shared asset-path
 * grammar guard ({@link isSafePluginAssetPath}) — the file is realpath-contained
 * to the plugin dir at read time (`resolveContainedPath` in the skill registry),
 * so this parse-time check only rejects the obviously-malformed shapes. Skills
 * are inert declarative content and carry no capability requirement. Strict so
 * unknown fields from plugin authors are rejected loudly.
 */
export const SkillContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1),
    path: z.string().min(1).refine(isSafePluginAssetPath, {
      message:
        "path must be a relative plugin asset path (no leading /, backslash, URL scheme, NUL, or .. segments)",
    }),
    triggers: z.array(z.string().min(1)).max(50).optional(),
  })
  .strict();

const ASSISTANT_KNOWLEDGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ASSISTANT_KNOWLEDGE_PATH = z.string().min(1).max(512).refine(isSafePluginAssetPath, {
  message:
    "path must be a relative plugin asset path (no leading /, backslash, URL scheme, NUL, or .. segments)",
});

const ASSISTANT_KNOWLEDGE_MARKDOWN_PATH = ASSISTANT_KNOWLEDGE_PATH.refine(
  (value) => value.toLowerCase().endsWith(".md"),
  { message: "path must be a .md file" }
);

/**
 * One skill or reference file in `contributes.assistantKnowledge`. The id
 * becomes part of a skill's directory name, which Agent Skills limits to
 * lowercase letters, digits and single hyphens.
 */
export const AssistantKnowledgeSkillSchema = z
  .object({
    id: z.string().min(1).max(32).regex(ASSISTANT_KNOWLEDGE_ID_PATTERN),
    path: ASSISTANT_KNOWLEDGE_PATH,
  })
  .strict();

export const AssistantKnowledgeReferenceSchema = z
  .object({
    // `instructions` is where over-long instructions are handed over.
    id: z
      .string()
      .min(1)
      .max(32)
      .regex(ASSISTANT_KNOWLEDGE_ID_PATTERN)
      .refine((value) => value !== "instructions", {
        message: 'reference id "instructions" is reserved',
      }),
    path: ASSISTANT_KNOWLEDGE_MARKDOWN_PATH,
  })
  .strict();

/**
 * `contributes.assistantKnowledge` (#13828). Markdown only; every path is
 * realpath-contained to the plugin directory when it is read, as skills are.
 * Optional rather than defaulted, like `account`, so a manifest without it
 * parses exactly as before.
 */
export const AssistantKnowledgeContributionSchema = z
  .object({
    instructions: ASSISTANT_KNOWLEDGE_MARKDOWN_PATH.optional(),
    skills: z.array(AssistantKnowledgeSkillSchema).max(16).optional(),
    references: z.array(AssistantKnowledgeReferenceSchema).max(32).optional(),
  })
  .strict()
  .superRefine((knowledge, ctx) => {
    if (
      knowledge.instructions === undefined &&
      (knowledge.skills ?? []).length === 0 &&
      (knowledge.references ?? []).length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "assistantKnowledge must declare instructions, skills or references",
      });
    }
    for (const list of ["skills", "references"] as const) {
      const seen = new Set<string>();
      (knowledge[list] ?? []).forEach((entry, index) => {
        if (seen.has(entry.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [list, index, "id"],
            message: `Duplicate assistantKnowledge ${list} id "${entry.id}"`,
            params: { errorCode: "duplicate_contribution_id" },
          });
        }
        seen.add(entry.id);
      });
    }
  });

/**
 * `contributes.themes` manifest entry (#13832). A theme is a palette file the
 * plugin ships, offered in Appearance under `plugin:{pluginId}:{id}` once it
 * clears the contrast gate. `path` uses the same asset-path guard as skills and
 * is realpath-contained at read time; the file's contents are validated by the
 * theme registry, which refuses the theme rather than the plugin when they
 * fail. `type` is the declared polarity the palette must match. Inert
 * declarative content, so no capability is required. Strict so unknown fields
 * fail loudly.
 */
export const ThemeContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1).max(80),
    type: z.enum(["dark", "light"]),
    path: z.string().min(1).refine(isSafePluginAssetPath, {
      message:
        "path must be a relative plugin asset path (no leading /, backslash, URL scheme, NUL, or .. segments)",
    }),
  })
  .strict();

export const PromptTemplateArgumentSchema = z
  .object({
    name: z.string().regex(PROMPT_TEMPLATE_ARG_NAME_PATTERN, {
      message:
        "argument names are lowercase letters, digits and underscores, starting with a letter",
    }),
    label: z.string().min(1).max(80),
    required: z.boolean().optional(),
  })
  .strict();

/**
 * `contributes.promptTemplates` manifest entry (#13799). A template the
 * composer's `/` menu offers under the plugin's name; choosing it fills
 * the draft and never submits. The body's `{{name}}` references are checked
 * against `args` by the manifest-level `superRefine`. Inert declarative
 * content, so no capability is required. Strict so unknown fields fail loudly.
 */
export const PromptTemplateContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    title: z.string().min(1).max(80),
    description: z.string().min(1).max(300),
    body: z.string().min(1).max(PROMPT_TEMPLATE_MAX_BODY_LENGTH),
    args: z.array(PromptTemplateArgumentSchema).max(PROMPT_TEMPLATE_MAX_ARGS).default([]),
  })
  .strict();

/**
 * A template id names its payload folder, `project-templates/<id>/`, so it is
 * held to a portable directory name: lowercase letters, digits and single
 * hyphens. `SAFE_ID_PATTERN` would admit `.` and `..`.
 */
const PROJECT_TEMPLATE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * One `contributes.projectTemplates` entry (#13825): a starting set of files the
 * Create project dialog offers. The files are the plugin's
 * `project-templates/<id>/` folder; the host lists them before writing and
 * copies them as they are, so nothing here names code to run.
 */
export const ProjectTemplateContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(PROJECT_TEMPLATE_ID_PATTERN, {
      message: "id must be lowercase letters, digits and single hyphens",
    }),
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(300),
    iconId: z.string().min(1).max(200).optional(),
  })
  .strict();
