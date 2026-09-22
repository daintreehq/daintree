// Aliased to avoid colliding with the ESM shim the bundler injects into every
// chunk (`import { createRequire } from 'module'`), as in PluginService.
import { createRequire as nodeCreateRequire } from "node:module";
import type { PluginMcpJsonSchema } from "../../../shared/types/plugin.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

/**
 * Checks one value against a compiled tool schema. `null` means the value
 * conforms; anything else describes why it does not. Never throws.
 */
export type AgentMcpSchemaCheck = (value: unknown) => string | null;

interface AjvErrorObject {
  instancePath: string;
  message?: string;
  params: Record<string, unknown>;
}

interface AjvValidateFunction {
  (data: unknown): boolean | Promise<unknown>;
  $async?: boolean;
  errors?: AjvErrorObject[] | null;
}

interface AjvInstance {
  compile(schema: Record<string, unknown>): AjvValidateFunction;
  validateSchema(schema: Record<string, unknown>): boolean | Promise<unknown>;
  errors?: AjvErrorObject[] | null;
}

type AjvConstructor = new (options?: Record<string, unknown>) => AjvInstance;

interface AjvModules {
  Ajv2020: AjvConstructor;
  AjvDraft07: AjvConstructor;
  addFormats: (ajv: AjvInstance) => void;
}

type Dialect = "2020-12" | "draft-07";

const DIALECT_BY_META_ID: Readonly<Record<string, Dialect>> = {
  "https://json-schema.org/draft/2020-12/schema": "2020-12",
  "http://json-schema.org/draft-07/schema": "draft-07",
};

/** Longest description of a failed check, in characters. */
const MAX_PROBLEM_CHARS = 1_000;

let ajvModules: AjvModules | undefined;

// Loaded on first compile: the plugin worker imports this module too, and most
// workers never register an agent MCP roster.
function loadAjv(): AjvModules {
  if (!ajvModules) {
    // CJS-only packages with `module.exports = Class`; see PluginService.
    const req = nodeCreateRequire(import.meta.url);
    ajvModules = {
      Ajv2020: req("ajv/dist/2020") as AjvConstructor,
      AjvDraft07: req("ajv") as AjvConstructor,
      addFormats: req("ajv-formats") as AjvModules["addFormats"],
    };
  }
  return ajvModules;
}

const metaValidators = new Map<Dialect, AjvInstance>();

/**
 * The instance that checks a schema against its dialect's meta-schema. Shared,
 * because it only ever caches the meta-schemas themselves — a plugin's schema
 * is the data it validates, never something it compiles or keeps.
 */
function metaValidatorFor(dialect: Dialect): AjvInstance {
  let instance = metaValidators.get(dialect);
  if (!instance) {
    const { Ajv2020, AjvDraft07 } = loadAjv();
    const Ajv = dialect === "2020-12" ? Ajv2020 : AjvDraft07;
    instance = new Ajv({ strict: false, logger: false });
    metaValidators.set(dialect, instance);
  }
  return instance;
}

function dialectOf(schema: PluginMcpJsonSchema): Dialect {
  const declared = schema.$schema;
  if (declared === undefined) return "2020-12";
  const dialect =
    typeof declared === "string" ? DIALECT_BY_META_ID[declared.replace(/#$/, "")] : undefined;
  if (!dialect) {
    throw new Error(
      `declares $schema ${JSON.stringify(declared)}; only JSON Schema 2020-12 (the default) and draft-07 are supported`
    );
  }
  return dialect;
}

function clip(text: string): string {
  return text.length > MAX_PROBLEM_CHARS ? `${text.slice(0, MAX_PROBLEM_CHARS)}…` : text;
}

function describeErrors(errors: readonly AjvErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "does not match the schema";
  return clip(
    errors
      .map((error) => {
        // Ajv's message says a property is unwelcome without saying which.
        const named =
          error.params.additionalProperty ??
          error.params.unevaluatedProperty ??
          error.params.propertyName;
        const suffix = typeof named === "string" ? ` (${JSON.stringify(named)})` : "";
        return `${error.instancePath || "/"} ${error.message ?? "is invalid"}${suffix}`;
      })
      .join("; ")
  );
}

/**
 * Compile a tool's frozen schema snapshot into a check, or throw describing why
 * the schema cannot be enforced. The message completes a sentence that starts
 * with the tool and field, e.g. `tool "list" inputSchema …`.
 *
 * Each schema gets its own compiler that knows no other schema — not the
 * meta-schemas, not the other tools' — so a `$ref` can only resolve inside the
 * schema that holds it, and nothing a roster compiles outlives the roster.
 * Values are checked as sent: nothing is coerced, defaulted or stripped.
 */
export function compileAgentMcpSchema(schema: PluginMcpJsonSchema): AgentMcpSchemaCheck {
  const dialect = dialectOf(schema);

  const meta = metaValidatorFor(dialect);
  if (meta.validateSchema(schema) !== true) {
    throw new Error(`is not a valid JSON Schema: ${describeErrors(meta.errors)}`);
  }

  const { Ajv2020, AjvDraft07, addFormats } = loadAjv();
  const Ajv = dialect === "2020-12" ? Ajv2020 : AjvDraft07;
  // With strict mode off Ajv only warns about a format it does not know, then
  // skips it — a constraint the plugin declared that would silently never run.
  const warnings: string[] = [];
  const collect = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(" "));
  };
  const ajv = new Ajv({
    meta: false,
    validateSchema: false,
    addUsedSchema: false,
    // Unknown keywords are annotations, as JSON Schema defines them; a vendor
    // `x-` keyword is not a reason to refuse a roster.
    strict: false,
    strictNumbers: true,
    allErrors: false,
    inlineRefs: false,
    ownProperties: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    logger: { log: () => {}, warn: collect, error: collect },
  });
  addFormats(ajv);

  let validate: AjvValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    const missingRef = (err as { missingRef?: unknown } | null)?.missingRef;
    if (typeof missingRef === "string") {
      throw new Error(
        `references ${JSON.stringify(missingRef)}, which is outside the schema; only references within the schema itself are supported`,
        { cause: err }
      );
    }
    throw new Error(`cannot be compiled: ${formatErrorMessage(err, "compilation failed")}`, {
      cause: err,
    });
  }
  if (warnings.length > 0) {
    throw new Error(`cannot be compiled: ${warnings[0]}`);
  }
  if (validate.$async === true) {
    throw new Error("is an async ($async) schema, which is not supported");
  }

  return (value) => {
    let valid: boolean | Promise<unknown>;
    try {
      valid = validate(value);
    } catch (err) {
      // A recursive schema can overflow the stack on deep enough input.
      return clip(`could not be checked: ${formatErrorMessage(err, "validation failed")}`);
    }
    return valid === true ? null : describeErrors(validate.errors);
  };
}
