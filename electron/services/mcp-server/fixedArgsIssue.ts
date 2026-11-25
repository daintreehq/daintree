import { z } from "zod";

/** Most accepted values a refusal lists before it stops. */
const MAX_LISTED_VALUES = 8;

/** The schemas one path step can lead to: none past anything the schema doesn't name itself. */
function stepInto(schema: z.ZodType, key: PropertyKey): z.ZodType[] {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodNonOptional ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodLazy
  ) {
    return stepInto(schema.unwrap() as z.ZodType, key);
  }
  if (schema instanceof z.ZodPipe) return stepInto(schema.in as z.ZodType, key);
  if (schema instanceof z.ZodObject) {
    return typeof key === "string" && Object.hasOwn(schema.shape, key)
      ? [schema.shape[key] as z.ZodType]
      : [];
  }
  if (schema instanceof z.ZodArray) {
    return typeof key === "number" ? [schema.element as z.ZodType] : [];
  }
  // Every option, since a discriminated union's later branch may be the one the path runs through.
  if (schema instanceof z.ZodUnion) {
    return (schema.options as readonly z.ZodType[]).flatMap((option) => stepInto(option, key));
  }
  return [];
}

/** How many leading steps of a path the schema declares itself. */
function declaredDepth(schema: z.ZodType, path: readonly PropertyKey[]): number {
  if (path.length === 0) return 0;
  let deepest = 0;
  for (const next of stepInto(schema, path[0]!)) {
    deepest = Math.max(deepest, 1 + declaredDepth(next, path.slice(1)));
    if (deepest === path.length) break;
  }
  return deepest;
}

/**
 * The longest start of an issue's path that the schema declares itself: its
 * own field names and array positions, never a record's key or anything else
 * the caller chose, so a refusal that reaches the audit log repeats nothing sent.
 */
function declaredPath(
  schema: z.ZodType,
  path: readonly PropertyKey[]
): { path: PropertyKey[]; whole: boolean } {
  const depth = declaredDepth(schema, path);
  return { path: path.slice(0, depth), whole: depth === path.length };
}

/**
 * A union none of whose branches took the input names the one branch whose
 * shape it had, when only one did: `includeOutput: { lines: "10" }` is a
 * wrong `lines`, not a wrong `includeOutput`.
 */
function innermost(issue: z.core.$ZodIssue): z.core.$ZodIssue {
  if (issue.code !== "invalid_union") return issue;
  const shaped = issue.errors.filter((branch) => {
    const first = branch[0];
    return first !== undefined && !(first.code === "invalid_type" && first.path.length === 0);
  });
  const inner = shaped.length === 1 ? shaped[0]![0]! : null;
  return inner === null ? issue : innermost({ ...inner, path: [...issue.path, ...inner.path] });
}

function valueAt(args: unknown, path: readonly PropertyKey[]): unknown {
  let at = args;
  for (const key of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<PropertyKey, unknown>)[key];
  }
  return at;
}

function typeName(expected: string): string {
  switch (expected) {
    case "record":
      return "an object";
    case "object":
    case "array":
    case "integer":
      return `an ${expected}`;
    case "int":
      return "an integer";
    default:
      return `a ${expected}`;
  }
}

function plural(count: number | bigint, one: string): string {
  return `${count} ${one}${Number(count) === 1 ? "" : "s"}`;
}

/** A bound as the schema states it: never the value that missed it. */
function bound(
  issue: { origin: string; inclusive?: boolean },
  limit: number | bigint,
  side: "least" | "most"
): string {
  switch (issue.origin) {
    case "array":
    case "set":
      return `should have at ${side} ${plural(limit, "item")}`;
    case "string":
      return `should be at ${side} ${plural(limit, "character")} long`;
    default: {
      const inclusive = issue.inclusive !== false;
      const word = side === "least" ? "less" : "more";
      return inclusive
        ? `should be no ${word} than ${limit}`
        : `should be ${side === "least" ? "more" : "less"} than ${limit}`;
    }
  }
}

/** What went wrong at a field the schema declares, in words drawn from the schema alone. */
function predicateFor(issue: z.core.$ZodIssue, present: boolean, plainSubject: boolean): string {
  switch (issue.code) {
    case "invalid_type":
      if (!present) return plainSubject ? "are missing" : "is required";
      return `should be ${typeName(issue.expected)}`;
    case "too_small":
      return bound(issue, issue.minimum, "least");
    case "too_big":
      return bound(issue, issue.maximum, "most");
    case "invalid_value": {
      const listed = issue.values
        .slice(0, MAX_LISTED_VALUES)
        .map((value) => (typeof value === "string" ? JSON.stringify(value) : String(value)));
      const more = issue.values.length > MAX_LISTED_VALUES ? ", ..." : "";
      return listed.length === 1
        ? `should be ${listed[0]}`
        : `should be one of ${listed.join(", ")}${more}`;
    }
    case "invalid_format":
      return `should be a valid ${issue.format}`;
    case "not_multiple_of":
      return `should be a multiple of ${issue.divisor}`;
    case "invalid_union":
      return plainSubject
        ? "match none of the accepted forms"
        : "matches none of its accepted forms";
    case "unrecognized_keys":
      return plainSubject
        ? "have a field this tool doesn't take"
        : "has a field this tool doesn't take";
    case "invalid_key":
    case "invalid_element":
      return "has an entry that doesn't fit";
  }
  // A rule the schema names itself (#18164) carries its own fixed words, never zod's.
  const reason: unknown = issue.code === "custom" ? issue.params?.reason : undefined;
  if (typeof reason === "string") return reason;
  return plainSubject ? "don't pass one of this tool's checks" : "doesn't pass one of its checks";
}

/**
 * The first issue a failed parse found, as fixed words: the field by the
 * schema's own names (the action tools' `targets[0].hostId` form) and a reason
 * built from the issue's code and what the schema states (#18164). Never
 * zod's own message, an unrecognized key's name, or any value sent.
 */
export function describeArgsIssue(
  schema: z.ZodType,
  args: unknown,
  error: z.ZodError,
  lead: string
): string {
  const first = error.issues[0];
  if (first === undefined) return `${lead}.`;
  const issue = innermost(first);
  const { path, whole } = declaredPath(schema, issue.path);
  const plainSubject = path.length === 0;
  const subject = plainSubject ? "the arguments" : `'${z.core.toDotPath(path)}'`;
  const predicate = whole
    ? predicateFor(issue, valueAt(args, path) !== undefined, plainSubject)
    : plainSubject
      ? "don't fit this tool's schema"
      : "has an entry that doesn't fit";
  return `${lead}: ${subject} ${predicate}.`;
}
