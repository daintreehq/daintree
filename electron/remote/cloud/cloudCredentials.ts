import {
  MAX_CLOUD_CREDENTIAL_LINE_BYTES,
  MAX_CLOUD_CREDENTIAL_TEXT_BYTES,
  type CloudCredentialField,
  type CloudCredentialValues,
} from "../../../shared/types/cloudHosts.js";
import { AppError } from "../../utils/errorTypes.js";

export { credentialFieldsProblem } from "../../../shared/utils/cloudProviderDeclaration.js";

const MAX_SET_BYTES = 256 * 1024;
/** A hint shows at most half of a secret. */
const MIN_HINTED_LENGTH = 8;

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message, userMessage: message });
}

/** Whether `value` holds a control character other than those in `allowed`. */
function hasControl(value: string, allowed: string): boolean {
  for (const ch of value) {
    if ((ch < " " || ch === "\x7f") && !allowed.includes(ch)) return true;
  }
  return false;
}

/** One field's value as entered, or null when it was left blank. */
function normalizeValue(field: CloudCredentialField, raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw invalid(`${field.label} must be text.`);
  if (field.input === "single-line") {
    const value = raw.trim();
    if (value.length === 0) return null;
    if (
      Buffer.byteLength(value, "utf8") > MAX_CLOUD_CREDENTIAL_LINE_BYTES ||
      hasControl(value, "")
    ) {
      throw invalid(`${field.label} should be one line of text.`);
    }
    // A key squeezed onto one line is never what a one-line field asks for.
    if (/PRIVATE KEY/.test(value)) throw invalid(`${field.label} can't be a private key.`);
    return value;
  }
  // Pasted or read text is handed over exactly as it is; only an empty one counts as blank.
  if (raw.trim().length === 0) return null;
  if (Buffer.byteLength(raw, "utf8") > MAX_CLOUD_CREDENTIAL_TEXT_BYTES) {
    throw invalid(
      field.input === "key-file"
        ? `${field.label} is larger than a key file should be.`
        : `${field.label} is too long.`
    );
  }
  if (hasControl(raw, "\t\n\r")) throw invalid(`${field.label} doesn't look like text.`);
  return raw;
}

/**
 * What was entered, checked field by field against what the provider
 * declares: a value for every required field, nothing it didn't ask for, and
 * blank optional fields left out. Whether a value is the right shape for the
 * provider (a token's alphabet, a key file's format) is the provider's own
 * check, which runs next.
 */
export function normalizeCloudCredentials(
  fields: readonly CloudCredentialField[],
  value: unknown
): CloudCredentialValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("Fill in the account's credentials.");
  }
  const entered = value as Record<string, unknown>;
  const declared = new Set(fields.map((field) => field.id));
  if (Object.keys(entered).some((id) => !declared.has(id))) {
    throw invalid("Those credentials include a value this provider doesn't ask for.");
  }
  const values: CloudCredentialValues = {};
  let bytes = 0;
  for (const field of fields) {
    const normalized = normalizeValue(
      field,
      Object.hasOwn(entered, field.id) ? entered[field.id] : undefined
    );
    if (normalized === null) {
      if (field.required) throw invalid(`${field.label} is required.`);
      continue;
    }
    bytes += Buffer.byteLength(normalized, "utf8");
    values[field.id] = normalized;
  }
  if (Object.keys(values).length === 0) throw invalid("Fill in the account's credentials.");
  if (bytes > MAX_SET_BYTES) throw invalid("Those credentials are too large to keep.");
  return values;
}

/** The end of the first one-line secret, so two sets can be told apart; null when there's none. */
export function cloudCredentialHint(
  fields: readonly CloudCredentialField[],
  values: CloudCredentialValues
): string | null {
  for (const field of fields) {
    if (!field.secret || field.input !== "single-line") continue;
    const value = Object.hasOwn(values, field.id) ? values[field.id] : undefined;
    const chars = typeof value === "string" ? [...value] : [];
    if (chars.length >= MIN_HINTED_LENGTH) return chars.slice(-4).join("");
  }
  return null;
}
