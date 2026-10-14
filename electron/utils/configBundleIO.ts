import { findSecretInValue } from "../../shared/utils/secretScrubber.js";
import { isSensitiveEnvKey } from "../../shared/utils/envVars.js";
import { isFileBundleSectionId } from "../../shared/config/portableSettings.js";
import { stripUtf8Bom } from "./stripUtf8Bom.js";
import {
  CONFIG_BUNDLE_APP_ID,
  CONFIG_BUNDLE_MAX_BYTES,
  CONFIG_BUNDLE_SCHEMA_VERSION,
  ConfigBundleEnvelopeSchema,
  type ConfigBundleSectionId,
} from "../../shared/types/configBundle.js";

/**
 * Pure build/parse half of the config bundle (#11889). No `fs`, no `dialog`, no
 * store access — those live in the IPC handler and `ConfigBundleService`, which
 * keeps this file trivially unit-testable.
 *
 * Shape follows `keybindingProfileIO.ts` (schemaVersion / exportedAt / app /
 * size cap / zod validation) but deliberately drops its exact-version-equality
 * gate: a multi-section bundle has to survive its own schema history, so an
 * unrecognised version downgrades to per-section validation rather than
 * rejecting the whole file.
 */

/** A secret was found; the containing key is dropped rather than redacted. */
const OMIT = Symbol("omit-secret");

type OmitWalkResult = typeof OMIT | unknown;

function childPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

/** `scheme://user:password@host`: credentials inside a connection string, whatever the scheme. */
const URI_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]+:[^\s/?#@]+@/i;

const CREDENTIAL_WORD = "(?:token|secret|password|passwd|passphrase|api-?key|credentials?)";

/** A flag named for a credential on its own (`--token`): the next argument is the secret. */
const CREDENTIAL_FLAG = new RegExp(`^--?[a-z0-9-]*${CREDENTIAL_WORD}[a-z0-9-]*$`, "i");

/** A credential flag with its value in the same string (`--api-key=…`, `--token abc`). */
const CREDENTIAL_FLAG_WITH_VALUE = new RegExp(
  `(?:^|\\s)--?[a-z0-9-]*${CREDENTIAL_WORD}[a-z0-9-]*(?:=|\\s+)\\S`,
  "i"
);

function looksSecret(value: string): boolean {
  return (
    Boolean(findSecretInValue(value)) ||
    URI_USERINFO.test(value) ||
    CREDENTIAL_FLAG_WITH_VALUE.test(value)
  );
}

/** Keys whose value is an environment map: agent and preset `env`, an agent's `globalEnv`. */
const ENV_MAP_KEYS: ReadonlySet<string> = new Set(["env", "globalEnv"]);

/** Sections whose whole payload is an environment map. */
const ENV_MAP_SECTIONS: ReadonlySet<string> = new Set<ConfigBundleSectionId>(["globalEnvironment"]);

function walk(value: unknown, path: string, omitted: string[], envMap = false): OmitWalkResult {
  if (typeof value === "string") {
    // Value-level detection everywhere, since a secret can sit in a flag or an
    // argument as well as an env map; names are checked only inside env maps.
    if (looksSecret(value)) {
      omitted.push(path);
      return OMIT;
    }
    return value;
  }

  if (Array.isArray(value)) {
    // ["--token", "<secret>"]: the secret is the argument after a credential flag.
    const flagIndex = value.findIndex(
      (item, i) => typeof item === "string" && CREDENTIAL_FLAG.test(item) && i < value.length - 1
    );
    if (flagIndex !== -1) {
      omitted.push(`${path}[${flagIndex + 1}]`);
      return OMIT;
    }
    const next: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const result = walk(value[i], `${path}[${i}]`, omitted);
      // Dropping one element and keeping the rest would silently rewrite a
      // positional list — an agent's `args` of ["--token", "<secret>"] would
      // export as ["--token"], which is a different (broken) command rather
      // than a redacted one. Withhold the whole array instead.
      if (result === OMIT) return OMIT;
      next.push(result);
    }
    return next;
  }

  if (value !== null && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      // A value pattern won't recognise an arbitrary password, so an env entry
      // whose NAME says it holds a credential is withheld whatever it contains.
      if (envMap && isSensitiveEnvKey(key)) {
        omitted.push(childPath(path, key));
        continue;
      }
      const result = walk(child, childPath(path, key), omitted, ENV_MAP_KEYS.has(key));
      if (result === OMIT) continue;
      // defineProperty, not `next[key] = …`: a key literally named `__proto__`
      // would otherwise hit the legacy prototype setter, changing the object's
      // prototype and losing the value. Agent settings allow arbitrary keys.
      Object.defineProperty(next, key, {
        value: result,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return next;
  }

  return value;
}

/**
 * Strip every secret-bearing value from `value`, returning the survivors plus
 * the dotted paths that were withheld.
 *
 * Omits the key outright instead of writing `[REDACTED]`: a redaction marker is
 * still importable data, and importing it would overwrite a working credential
 * on the target machine with a literal placeholder.
 */
export function omitSecretValues<T>(
  value: T,
  pathPrefix = "",
  options: { envMap?: boolean } = {}
): { value: T; omitted: string[] } {
  const omitted: string[] = [];
  const result = walk(value, pathPrefix, omitted, options.envMap ?? false);
  return { value: (result === OMIT ? undefined : result) as T, omitted };
}

export type ConfigBundleSections = Partial<Record<ConfigBundleSectionId, unknown>>;

/**
 * Withhold every secret-bearing value from each section before it leaves this
 * machine, by value pattern and, inside environment maps, by name. A withheld
 * entry is absent rather than blanked, and the target merges env maps per key,
 * so its own value for that name is left as it was.
 */
export function omitSectionSecrets(sections: ConfigBundleSections): {
  sections: ConfigBundleSections;
  omittedSecretPaths: string[];
} {
  const omittedSecretPaths: string[] = [];
  const cleaned: ConfigBundleSections = {};
  for (const [id, payload] of Object.entries(sections) as [ConfigBundleSectionId, unknown][]) {
    if (payload === undefined) continue;
    const { value, omitted } = omitSecretValues(payload, id, {
      envMap: ENV_MAP_SECTIONS.has(id),
    });
    omittedSecretPaths.push(...omitted);
    if (value !== undefined) cleaned[id] = value;
  }
  return { sections: cleaned, omittedSecretPaths };
}

export interface BuildConfigBundleResult {
  json: string;
  omittedSecretPaths: string[];
  sections: ConfigBundleSectionId[];
}

/**
 * Serialize the portable sections into a bundle, withholding secret-bearing
 * values. `exportedAt` is injected by the caller in tests; production passes the
 * current time.
 */
export function buildConfigBundle(
  sections: ConfigBundleSections,
  exportedAt: string
): BuildConfigBundleResult {
  // Only what a file may carry: a section that travels only when someone asks
  // for it (permission bypass, global environment) never lands in a file
  // that is later imported with no per-section choice.
  const fileSections: ConfigBundleSections = {};
  for (const [id, payload] of Object.entries(sections) as [ConfigBundleSectionId, unknown][]) {
    if (isFileBundleSectionId(id)) fileSections[id] = payload;
  }
  const { sections: cleaned, omittedSecretPaths } = omitSectionSecrets(fileSections);
  // A section can be withheld entirely (its whole value looked like a secret).
  // JSON.stringify would drop the undefined key anyway, so reporting the
  // section as included would overstate what the file actually carries.
  const included = Object.keys(cleaned) as ConfigBundleSectionId[];

  const json = JSON.stringify(
    {
      schemaVersion: CONFIG_BUNDLE_SCHEMA_VERSION,
      exportedAt,
      app: CONFIG_BUNDLE_APP_ID,
      sections: cleaned,
    },
    null,
    2
  );

  return { json, omittedSecretPaths, sections: included };
}

export interface ParseConfigBundleResult {
  ok: boolean;
  exportedAt?: string;
  schemaVersion?: number;
  /** Payloads keyed by section id — only ids this build recognises. */
  sections: Partial<Record<ConfigBundleSectionId, unknown>>;
  /** Section keys present in the file but unknown here. Reported, not applied. */
  unknownSections: string[];
  errors: string[];
}

function failure(error: string): ParseConfigBundleResult {
  return { ok: false, sections: {}, unknownSections: [], errors: [error] };
}

/**
 * Validate the envelope and split out the recognised sections.
 *
 * Envelope problems are fatal (there is nothing to apply). A section payload
 * this build doesn't recognise is not — it is listed in `unknownSections` and
 * left alone, so a bundle from a newer build still applies what overlaps.
 */
export function parseConfigBundle(json: string): ParseConfigBundleResult {
  // Byte length, not string length: a bundle full of multi-byte characters
  // would otherwise sail past a cap that advertises itself in bytes.
  if (Buffer.byteLength(json, "utf8") > CONFIG_BUNDLE_MAX_BYTES) {
    return failure(`File too large (max ${Math.floor(CONFIG_BUNDLE_MAX_BYTES / 1024)}KB)`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripUtf8Bom(json));
  } catch {
    return failure("Invalid JSON");
  }

  const envelope = ConfigBundleEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    return failure("Not a Daintree configuration bundle");
  }

  if (envelope.data.app !== CONFIG_BUNDLE_APP_ID) {
    return failure(`Not a Daintree configuration bundle (app: ${envelope.data.app})`);
  }

  // Deliberately NOT an equality check. A newer bundle still applies whatever
  // sections this build recognises; only a version from the future's future
  // (which we cannot reason about at all) is worth refusing outright.
  if (envelope.data.schemaVersion > CONFIG_BUNDLE_SCHEMA_VERSION) {
    return {
      ok: false,
      exportedAt: envelope.data.exportedAt,
      schemaVersion: envelope.data.schemaVersion,
      sections: {},
      unknownSections: [],
      errors: [
        `Bundle was written by a newer version of Daintree (format ${envelope.data.schemaVersion}, this build understands ${CONFIG_BUNDLE_SCHEMA_VERSION}). Update Daintree and try again.`,
      ],
    };
  }

  const sections: Partial<Record<ConfigBundleSectionId, unknown>> = {};
  const unknownSections: string[] = [];

  for (const [key, payload] of Object.entries(envelope.data.sections)) {
    // A section only Copy settings sends (permission bypass, global
    // environment) is refused from a file like any section this build doesn't
    // know: a hand-edited file must not turn on what Export never writes.
    if (isFileBundleSectionId(key)) {
      sections[key] = payload;
    } else {
      unknownSections.push(key);
    }
  }

  return {
    ok: true,
    exportedAt: envelope.data.exportedAt,
    schemaVersion: envelope.data.schemaVersion,
    sections,
    unknownSections,
    errors: [],
  };
}
