import { formatErrorMessage } from "./errorMessage.js";

/**
 * Utilities for ensuring data is safe for structured clone serialization (IPC transport).
 *
 * The structured clone algorithm (used by Electron's MessagePort.postMessage)
 * cannot serialize:
 * - Functions
 * - Symbols
 * - Class instances
 * - Circular references
 * - Error objects (in some cases)
 * - Proxy objects
 */

/**
 * Deep clone data using JSON serialization to ensure it's structured-clone compatible.
 * This removes any non-serializable fields like functions, class instances, etc.
 *
 * Note: This will:
 * - Drop undefined object properties (kept in arrays as null)
 * - Remove functions and symbols
 * - Throw on circular references or BigInt
 * - Lose prototype information (class instances become plain objects)
 * - Convert Date to ISO string, NaN/Infinity to null
 *
 * May throw on BigInt or circular references - caller must handle.
 */
export function ensureSerializable<T>(data: T): unknown {
  try {
    return JSON.parse(JSON.stringify(data));
  } catch (error) {
    throw new Error(formatErrorMessage(error, "Failed to serialize data"));
  }
}

/**
 * Validate that data can be serialized via structured clone.
 * Returns validation result with details if invalid.
 *
 * Note: Uses JSON.stringify which has different semantics than structured clone.
 * This will accept some values that postMessage rejects (BigInt, symbols as object keys)
 * and may reject some values that postMessage accepts (certain Error shapes).
 */
export function validateSerializable(
  data: unknown
): { valid: true } | { valid: false; error: string; path?: string } {
  try {
    JSON.stringify(data);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: formatErrorMessage(error, "Failed to serialize data"),
    };
  }
}
