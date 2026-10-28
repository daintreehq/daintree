// The project plugin `application` descriptor.

import { z } from "zod";
import { SAFE_ID_PATTERN } from "../pluginIdentifiers.js";
import {
  AGENT_MCP_MAX_ENDPOINTS_PER_PLUGIN,
  PLUGIN_APPLICATION_ARRANGEMENTS,
  PLUGIN_APPLICATION_DESTINATIONS,
  PLUGIN_APPLICATION_NAVIGATION_LIMITS,
} from "../../../shared/types/plugin.js";
import {
  PRESENTATION_FEATURE_IDS,
  PRESENTATION_LEVELS,
  isLevelAllowed,
  isPresentationFeatureId,
} from "../../../shared/config/presentationProfile.js";
import { isReservedNavigationParamName } from "../../../shared/utils/applicationNavigation.js";

/** `application.welcomeTour`: a tour of this plugin and its welcome revision. */
export const PluginApplicationTourRefSchema = z.strictObject({
  id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});

const NAVIGATION = PLUGIN_APPLICATION_NAVIGATION_LIMITS;

const navigationParamFlags = {
  required: z.boolean().optional(),
  persist: z.boolean().optional(),
};

/** One declared section parameter: an identifier string, a safe integer or a flag (#14108). */
export const PluginApplicationNavigationParamSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("string"),
    ...navigationParamFlags,
    maxLength: z.number().int().min(1).max(NAVIGATION.maxStringLength).optional(),
  }),
  z.strictObject({ type: z.literal("integer"), ...navigationParamFlags }),
  z.strictObject({ type: z.literal("boolean"), ...navigationParamFlags }),
]);

export const PluginApplicationSectionSchema = z.strictObject({
  id: z.string().min(1).max(NAVIGATION.maxIdLength).regex(SAFE_ID_PATTERN),
  title: z.string().trim().min(1).max(NAVIGATION.maxTitleLength),
  params: z
    .record(
      z
        .string()
        .min(1)
        .max(NAVIGATION.maxParamNameLength)
        .regex(SAFE_ID_PATTERN)
        .refine((name) => !isReservedNavigationParamName(name), {
          message: "A parameter can't be named __proto__, constructor or prototype.",
        }),
      PluginApplicationNavigationParamSchema
    )
    .refine((params) => Object.keys(params).length <= NAVIGATION.maxParamsPerSection, {
      message: `A section declares at most ${NAVIGATION.maxParamsPerSection} parameters.`,
    })
    .optional(),
});

/**
 * `application.navigation` (#14108): the sections the application's views
 * navigate between. Self-contained — a section names no view or command, so
 * it is checked here rather than against the rest of the manifest.
 */
export const PluginApplicationNavigationSchema = z
  .strictObject({
    version: z.number().int().min(1).max(NAVIGATION.maxVersion),
    defaultSectionId: z.string().min(1).max(NAVIGATION.maxIdLength).regex(SAFE_ID_PATTERN),
    sections: z.array(PluginApplicationSectionSchema).min(1).max(NAVIGATION.maxSections),
  })
  .superRefine((navigation, ctx) => {
    const seen = new Set<string>();
    navigation.sections.forEach((section, index) => {
      if (seen.has(section.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sections", index, "id"],
          message: `application.navigation declares section "${section.id}" twice.`,
          params: { errorCode: "application_navigation_section_duplicate" },
        });
      }
      seen.add(section.id);
    });
    const fallback = navigation.sections.find(
      (section) => section.id === navigation.defaultSectionId
    );
    if (fallback === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultSectionId"],
        message: `application.navigation.defaultSectionId "${navigation.defaultSectionId}" matches no section.`,
        params: { errorCode: "application_navigation_default_unknown" },
      });
    } else if (Object.values(fallback.params ?? {}).some((param) => param.required === true)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultSectionId"],
        message: `application.navigation.defaultSectionId "${fallback.id}" requires parameters — the default is where a location that no longer resolves lands, so it must open with none.`,
        params: { errorCode: "application_navigation_default_requires_params" },
      });
    }
  });

/** Longest `application.name`, matching a sidebar view's name. */
export const PLUGIN_APPLICATION_NAME_MAX = 64;

/**
 * The top-level `application` descriptor (#14097). Every reference is a bare
 * id the same manifest declares; the manifest `superRefine` resolves each one
 * and confines the block to `scope: "project"`. The presentation vocabulary
 * needs only the block itself, so it is checked here.
 */
export const PluginApplicationSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(PLUGIN_APPLICATION_NAME_MAX),
    iconId: z.string().min(1).max(200).optional(),
    destination: z.enum(PLUGIN_APPLICATION_DESTINATIONS),
    arrangement: z.enum(PLUGIN_APPLICATION_ARRANGEMENTS).optional(),
    sidebarViewId: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    settingsViewId: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    welcomeTour: PluginApplicationTourRefSchema.optional(),
    firstWorkflow: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    // Capped at the endpoints a plugin may declare, so each names a different one.
    requiredTools: z
      .array(z.string().min(1).max(64).regex(SAFE_ID_PATTERN))
      .max(AGENT_MCP_MAX_ENDPOINTS_PER_PLUGIN)
      .optional(),
    presentation: z.record(z.string(), z.enum(PRESENTATION_LEVELS)).optional(),
    navigation: PluginApplicationNavigationSchema.optional(),
  })
  .superRefine((application, ctx) => {
    if (application.arrangement !== undefined && application.destination !== "home") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["arrangement"],
        message:
          'application.arrangement arranges a Home, so it needs destination "home"; a grid destination has nothing to arrange.',
        params: { errorCode: "application_arrangement_needs_home" },
      });
    }
    for (const [feature, level] of Object.entries(application.presentation ?? {})) {
      if (!isPresentationFeatureId(feature)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["presentation", feature],
          message: `application.presentation names "${feature}", which is not a presentation feature (${PRESENTATION_FEATURE_IDS.join(", ")}).`,
          params: { errorCode: "application_presentation_unknown" },
        });
      } else if (!isLevelAllowed(feature, level)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["presentation", feature],
          message: `application.presentation sets "${feature}" to "${level}", a level that feature does not offer.`,
          params: { errorCode: "application_presentation_level" },
        });
      }
    }
  });
