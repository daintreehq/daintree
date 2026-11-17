// How a cloud provider call crosses from main to a plugin's impl and back
// (#17351). Pure, and loaded on both sides of the worker port: main shapes the
// call and reads the answer, the worker runs the impl and writes the answer.

import { isCloudHostErrorCode, type CloudHostErrorCode } from "../../../shared/types/cloudHosts.js";
import {
  CLOUD_PROVIDER_REQUIRED_METHODS,
  type CloudProviderContribution,
  type CloudProviderMethod,
} from "../../../shared/types/pluginCloudProvider.js";

/** The most one answer may hold once serialized: a list of machines, a catalog. */
export const CLOUD_PROVIDER_ANSWER_MAX_BYTES = 1024 * 1024;
const MAX_MESSAGE_LENGTH = 300;

/**
 * The provider itself answered with a failure. `code` is the one it named,
 * when it named one Daintree knows; the message is its own, cut to one line.
 */
export class PluginCloudProviderAnswerError extends Error {
  readonly code: CloudHostErrorCode | null;

  constructor(code: CloudHostErrorCode | null, message: string | null) {
    super(boundedProviderMessage(message) ?? "The provider failed without saying why");
    this.name = "PluginCloudProviderAnswerError";
    this.code = code;
  }

  static from(error: unknown): PluginCloudProviderAnswerError {
    if (error instanceof PluginCloudProviderAnswerError) return error;
    let code: unknown;
    let message: unknown;
    try {
      code = (error as { code?: unknown } | null)?.code;
      message = error instanceof Error ? error.message : typeof error === "string" ? error : null;
    } catch {
      // A throwing getter on a plugin's error is still a failure, just an unnamed one.
    }
    return new PluginCloudProviderAnswerError(
      isCloudHostErrorCode(code) ? code : null,
      typeof message === "string" ? message : null
    );
  }
}

/** No answer came back: the worker wasn't there, crashed, or the port refused the message. */
export class PluginCloudProviderTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginCloudProviderTransportError";
  }
}

/** A plugin's own words, safe to show on one line: no control characters, bounded. */
export function boundedProviderMessage(message: string | null | undefined): string | null {
  if (typeof message !== "string") return null;
  let text = "";
  for (const ch of message) {
    const code = ch.codePointAt(0)!;
    text += code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0) ? " " : ch;
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text;
}

/**
 * The impl's arguments for one call, from the arguments that crossed without
 * the signal. `checkCredentials` takes its signal last; every other method
 * takes the account's credentials first, and the signal travels in them.
 */
export function cloudProviderImplArgs(
  method: CloudProviderMethod,
  args: readonly unknown[],
  signal: AbortSignal
): unknown[] {
  if (method === "checkCredentials") return [args[0], args[1], signal];
  const credentials = (args[0] ?? {}) as Record<string, unknown>;
  return [Object.freeze({ ...credentials, signal }), ...args.slice(1)];
}

/** The reverse of {@link cloudProviderImplArgs}: what crosses, and the signal that stays. */
export function cloudProviderWireArgs(
  method: CloudProviderMethod,
  args: readonly unknown[]
): { args: unknown[]; signal: AbortSignal | undefined } {
  if (method === "checkCredentials") {
    return { args: [args[0], args[1]], signal: args[2] as AbortSignal | undefined };
  }
  const { signal, ...credentials } = (args[0] ?? {}) as Record<string, unknown> & {
    signal?: AbortSignal;
  };
  return { args: [credentials, ...args.slice(1)], signal };
}

type CloudProviderAnswer =
  { ok: true; value: unknown } | { ok: false; code: string | null; message: string | null };

/**
 * What the worker sends back for one call, as one JSON string: the value, or
 * the provider's failure with its code. A failure is still a delivered answer,
 * so it rides the transport's success path and keeps its code.
 */
export function encodeCloudProviderAnswer(
  outcome: { ok: true; value: unknown } | { ok: false; error: unknown }
): string {
  let answer: CloudProviderAnswer;
  if (outcome.ok) {
    answer = { ok: true, value: outcome.value === undefined ? null : outcome.value };
  } else {
    const failure = PluginCloudProviderAnswerError.from(outcome.error);
    answer = { ok: false, code: failure.code, message: failure.message };
  }
  const json = JSON.stringify(answer);
  if (json === undefined) throw new Error("the provider's answer can't be serialized to JSON");
  if (Buffer.byteLength(json, "utf8") > CLOUD_PROVIDER_ANSWER_MAX_BYTES) {
    throw new Error(
      `the provider's answer is over the ${CLOUD_PROVIDER_ANSWER_MAX_BYTES}-byte limit for one answer`
    );
  }
  return json;
}

/** The value of an answer from the worker; throws the provider's failure, or a transport one. */
export function decodeCloudProviderAnswer(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length > CLOUD_PROVIDER_ANSWER_MAX_BYTES) {
    throw new PluginCloudProviderTransportError("The plugin's answer couldn't be read");
  }
  let answer: unknown;
  try {
    answer = JSON.parse(raw);
  } catch {
    throw new PluginCloudProviderTransportError("The plugin's answer couldn't be read");
  }
  const envelope = (answer ?? {}) as Partial<Record<"ok" | "value" | "code" | "message", unknown>>;
  if (envelope.ok === true) return envelope.value;
  if (envelope.ok === false) {
    throw new PluginCloudProviderAnswerError(
      isCloudHostErrorCode(envelope.code) ? envelope.code : null,
      typeof envelope.message === "string" ? envelope.message : null
    );
  }
  throw new PluginCloudProviderTransportError("The plugin's answer couldn't be read");
}

/**
 * The methods a provider must have, given what its manifest declares: the
 * contract's required ones, `renewLifetime` for a renewable lifetime, and the
 * SSH method its key timing calls.
 */
export function cloudProviderMethodsNeeded(
  contribution: Pick<CloudProviderContribution, "capabilities">
): CloudProviderMethod[] {
  const { capabilities } = contribution;
  const needed: CloudProviderMethod[] = [...CLOUD_PROVIDER_REQUIRED_METHODS];
  if (capabilities.lifetime.kind === "renewable") needed.push("renewLifetime");
  needed.push(capabilities.provisioning.sshKey === "at-create" ? "sshAccess" : "authorizeSsh");
  return needed;
}
