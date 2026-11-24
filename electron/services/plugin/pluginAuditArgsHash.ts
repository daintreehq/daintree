import { boundedStableArgsSha256 } from "../../utils/pluginMcpHash.js";
import { estimatePayloadBytes } from "./pluginPayloadLimits.js";

/**
 * Largest argument payload a plugin dispatch audit record hashes. Hashing
 * sorts every object's keys, serializes the result and digests it, all
 * synchronously on main; invoke args may be up to 4 MiB, and a record is
 * written on every dispatch, success included.
 */
export const PLUGIN_AUDIT_ARGS_HASH_MAX_BYTES = 64 * 1024;

/**
 * SHA-256 of dispatch args for forensic grouping, best-effort. Args over
 * {@link PLUGIN_AUDIT_ARGS_HASH_MAX_BYTES} are left unhashed: first by their
 * clone size, which the size walk decides after about that many bytes however
 * large they are, then by what canonicalizing them would produce, which can
 * be far larger (deep nesting, typed-array views sharing one buffer). A
 * serialization throw must not mask the handler error being audited. All of
 * these record `""`, the audit schema's "not hashed" value.
 */
export function safeArgsHash(args: unknown): string {
  try {
    if (
      estimatePayloadBytes(args, PLUGIN_AUDIT_ARGS_HASH_MAX_BYTES) >
      PLUGIN_AUDIT_ARGS_HASH_MAX_BYTES
    ) {
      return "";
    }
    return boundedStableArgsSha256(args, PLUGIN_AUDIT_ARGS_HASH_MAX_BYTES) ?? "";
  } catch {
    return "";
  }
}
