// Database contributions and their declared queries.

import { z } from "zod";
import { SAFE_ID_PATTERN } from "../pluginIdentifiers.js";
import {
  AGENT_MCP_MAX_DESCRIPTION_BYTES,
  AGENT_MCP_TOOL_NAME_PATTERN,
} from "../../../shared/types/plugin.js";
import { declaredQueryProblems } from "../../services/pluginAgentMcp/declaredQueries.js";
import { isSafePluginAssetPath, utf8Length } from "./common.js";

const DATABASE_FILE_EXTENSION = /\.(db|sqlite|sqlite3)$/;

/** Most params one declared query may take. */
export const DATABASE_QUERY_MAX_PARAMS = 16;

/** The JSON Schema formats a declared string param may require; the host's validator knows each. */
export const DATABASE_QUERY_PARAM_FORMATS = [
  "date",
  "time",
  "date-time",
  "email",
  "uri",
  "uuid",
] as const;

const STRING_PARAM_CONSTRAINTS = ["minLength", "maxLength", "pattern", "format"] as const;

const NUMBER_PARAM_CONSTRAINTS = ["minimum", "maximum"] as const;

/** Whether `value` is a value of the declared param type, as the input schema checks it. */
function isParamValue(type: string, value: unknown): boolean {
  return type === "integer" ? Number.isSafeInteger(value) : typeof value === type;
}

/**
 * One param of a declared query: its JSON type, what it means, and the JSON
 * Schema constraints its value must meet. Each constraint is refused on a type
 * it cannot apply to, so a rule the author wrote is never silently skipped.
 */
export const DatabaseQueryParamSchema = z
  .object({
    type: z.enum(["string", "number", "integer", "boolean"]),
    description: z.string().min(1).max(400).optional(),
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(0).optional(),
    pattern: z.string().min(1).max(1024).optional(),
    format: z.enum(DATABASE_QUERY_PARAM_FORMATS).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    not: z
      .object({ const: z.union([z.string(), z.number(), z.boolean()]) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((param, ctx) => {
    const fail = (path: string, message: string): void => {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message,
        params: { errorCode: "database_query_param_constraint" },
      });
    };
    const numeric = param.type === "number" || param.type === "integer";
    for (const key of STRING_PARAM_CONSTRAINTS) {
      if (param[key] !== undefined && param.type !== "string") {
        fail(key, `${key} applies only to a "string" param, not "${param.type}"`);
      }
    }
    for (const key of NUMBER_PARAM_CONSTRAINTS) {
      const bound = param[key];
      if (bound === undefined) continue;
      if (!numeric) {
        fail(key, `${key} applies only to a "number" or "integer" param, not "${param.type}"`);
      } else if (param.type === "integer" && !Number.isSafeInteger(bound)) {
        fail(
          key,
          `${key} of an "integer" param must be an integer no larger than 2^53 - 1 in magnitude`
        );
      }
    }
    if (
      param.minLength !== undefined &&
      param.maxLength !== undefined &&
      param.minLength > param.maxLength
    ) {
      fail("minLength", `minLength ${param.minLength} is more than maxLength ${param.maxLength}`);
    }
    if (
      param.minimum !== undefined &&
      param.maximum !== undefined &&
      param.minimum > param.maximum
    ) {
      fail("minimum", `minimum ${param.minimum} is more than maximum ${param.maximum}`);
    }
    if (param.pattern !== undefined) {
      // The host's validator compiles a pattern as a Unicode expression.
      try {
        new RegExp(param.pattern, "u");
      } catch {
        fail("pattern", "pattern must be a valid Unicode regular expression");
      }
    }
    if (param.not !== undefined && !isParamValue(param.type, param.not.const)) {
      fail("not", `not.const must be a value of the param's type, "${param.type}"`);
    }
  });

/**
 * `contributes.databases[].queries` entry — one parameterised statement the
 * host serves to agents as a tool named `name`, with no plugin code. Whether
 * the host can serve it safely is decided here, from the SQL as written,
 * because the database need not exist yet: one statement, of the kind its
 * `mode` names, and placeholders that match `params` exactly. Each failure
 * names the query.
 */
export const DatabaseQueryContributionSchema = z
  .object({
    name: z.string().regex(AGENT_MCP_TOOL_NAME_PATTERN, {
      message:
        "query name must be 1-32 lowercase letters, digits and underscores, starting with a letter",
    }),
    mode: z.enum(["read", "write"]),
    description: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, { message: "description must not be blank" })
      .refine((value) => utf8Length(value) <= AGENT_MCP_MAX_DESCRIPTION_BYTES, {
        message: `description must be at most ${AGENT_MCP_MAX_DESCRIPTION_BYTES} UTF-8 bytes`,
      }),
    params: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, {
          message:
            "param names must be 1-64 letters, digits and underscores, not starting with a digit",
        }),
        DatabaseQueryParamSchema
      )
      .refine((params) => Object.keys(params).length <= DATABASE_QUERY_MAX_PARAMS, {
        message: `a query may take at most ${DATABASE_QUERY_MAX_PARAMS} params`,
      })
      .default({}),
    sql: z
      .string()
      .min(1)
      .max(65536)
      .refine((value) => !value.includes("\0"), { message: "sql must not contain NUL" }),
  })
  .strict()
  .superRefine((query, ctx) => {
    for (const problem of declaredQueryProblems(query)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [problem.field],
        message: problem.message,
        params: { errorCode: "database_query_unservable" },
      });
    }
  });

/**
 * `contributes.databases` manifest entry — a SQLite file the plugin opens
 * through `host.db`. The declaration is what names the file, discloses it, and
 * decides where it lives, so the host can resolve and contain the path before
 * the plugin ever sees it.
 *
 * `path` is only meaningful for a `"project"` database: it is relative to the
 * project root, so the committed data contract an agent reads can name the
 * same file. A `"local"` database always lives in the plugin's own data
 * directory. Strict, so a stray `url` or `driver` is refused rather than read
 * as a backend the host does not have.
 */
export const DatabaseContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    description: z.string().min(1).max(400).optional(),
    location: z.enum(["project", "local"]).default("project"),
    path: z
      .string()
      .min(1)
      .max(512)
      .refine(isSafePluginAssetPath, {
        message:
          "path must be a relative project path (no leading /, backslash, URL scheme, NUL, or .. segments)",
      })
      .refine((value) => !/(^|\/)\.git(\/|$)/i.test(value.replace(/^\.\//, "")), {
        message: "path must not be inside .git",
      })
      .refine((value) => DATABASE_FILE_EXTENSION.test(value), {
        message: "path must end in .db, .sqlite or .sqlite3",
      })
      .optional(),
    journalMode: z.enum(["delete", "wal"]).default("delete"),
    schemaVersion: z.number().int().min(0).max(100_000).optional(),
    // Capped across all of the plugin's databases by the manifest check, which
    // names the query past the limit; a per-entry cap would report first, and
    // name none.
    queries: z.array(DatabaseQueryContributionSchema).optional(),
  })
  .strict();
