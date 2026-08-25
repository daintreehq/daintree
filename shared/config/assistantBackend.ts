/**
 * The backends the Daintree Assistant can be pointed at.
 *
 * Shared because both processes need it and must not disagree: main resolves the URL it
 * spawns the engine and the CLI against, and the renderer draws the picker. Two copies
 * of this table is how "signed in to staging, asking production" happens.
 *
 * ## Why this is a closed list rather than a URL field
 *
 * The assistant carries every prompt, file path and command the user types, so what it
 * talks to is a security boundary, not a preference. A free-text endpoint would make
 * "somewhere else entirely" a typo away, and the value would be persisted — so a
 * mistake is permanent rather than momentary. A closed list of endpoints we operate
 * says what it means: this is a choice between OUR environments.
 *
 * A developer running something else still can: `DAINTREE_BACKEND_URL` moves the
 * endpoint within loopback (see `resolveBackendUrl`), and the CLI itself takes an
 * arbitrary `--backend-url` outside Daintree entirely.
 */

export type AssistantBackendEnvironment = "local" | "staging" | "production";

export interface AssistantBackendEnvironmentInfo {
  id: AssistantBackendEnvironment;
  /** Sentence case, no trailing period — it labels a picker option. */
  label: string;
  /** What choosing it means, in one clause. */
  description: string;
  url: string;
  /** Whether choosing this sends prompts off this machine. */
  remote: boolean;
  /**
   * Whether this is a choice a user may still make.
   *
   * A LEGACY entry stays in the table — it has to, because someone's settings file
   * already names it — but it never appears in the picker. Deleting the row instead
   * would be the destructive option: the id would stop validating, the stored value
   * would be discarded as unrecognised, and a remote install would silently fall back
   * to the local default. Kept and hidden, a stored legacy id keeps resolving to
   * exactly the endpoint it always did.
   */
  legacy?: true;
}

/**
 * `local` FIRST, and the default.
 *
 * The panel is pre-release. Nothing should start talking to an endpoint we pay for
 * because a default moved underneath it — the remote environments are opt-in, per
 * install, by someone who went to Settings and chose one.
 */
/**
 * The one remote backend this rollout has.
 *
 * Named here so the table cannot drift from it, and stated plainly because the
 * neighbouring name is a trap: `staging.daintree.org` is the WEBSITE — the marketing and
 * account pages — and it serves none of `/v1/daintree/*`, `/version` or `/readyz`.
 * Pointing the assistant at it returns HTML where JSON was expected, which surfaces as a
 * parse failure rather than as "wrong host". Browser destinations come from the CLI's own
 * validated discovery manifest, never from this table.
 */
const ASSISTANT_BACKEND_ORIGIN = "https://assistant.daintree.org";

export const ASSISTANT_BACKEND_ENVIRONMENTS: readonly AssistantBackendEnvironmentInfo[] = [
  {
    id: "local",
    label: "Local",
    description: "A backend running on this machine. Nothing leaves the device.",
    url: "http://127.0.0.1:8473",
    remote: false,
  },
  {
    id: "staging",
    label: "Staging",
    description: "Daintree's hosted backend. Turns run against real models and cost money.",
    url: ASSISTANT_BACKEND_ORIGIN,
    remote: true,
  },
  {
    // The rollout has ONE remote backend, and this used to be its name. The row stays so
    // a settings file that already says "production" keeps working, pointed at the same
    // URL it has always been pointed at — a rename, not a repoint, so nobody's endpoint
    // moves. It is not offered as a choice: two visible options resolving to one
    // endpoint is a picker that cannot mean what it says.
    id: "production",
    label: "Production",
    description: "The deployed backend. Turns run against real models and cost money.",
    // Unreachable copy — this row is never rendered. Kept so the entry stays readable
    // beside its neighbour rather than being a bare id.
    url: ASSISTANT_BACKEND_ORIGIN,
    remote: true,
    legacy: true,
  },
];

/**
 * The environments a user may actually pick, in picker order.
 *
 * Separate from the table above rather than a filter at each call site: the table
 * answers "what does this stored id mean", the list answers "what may be chosen", and
 * for a legacy id those are different questions with different answers.
 */
export const SELECTABLE_ASSISTANT_BACKEND_ENVIRONMENTS: readonly AssistantBackendEnvironmentInfo[] =
  ASSISTANT_BACKEND_ENVIRONMENTS.filter((e) => !e.legacy);

export const DEFAULT_ASSISTANT_BACKEND_ENVIRONMENT: AssistantBackendEnvironment = "local";

const BY_ID = new Map(ASSISTANT_BACKEND_ENVIRONMENTS.map((e) => [e.id, e]));

export function isAssistantBackendEnvironment(
  value: unknown
): value is AssistantBackendEnvironment {
  return typeof value === "string" && BY_ID.has(value as AssistantBackendEnvironment);
}

/**
 * The entry for an id, falling back to the default for anything unrecognised.
 *
 * Never throws. A stored value is the input here, and a settings file that has been
 * hand-edited, downgraded, or corrupted must not stop the assistant launching — it
 * should launch somewhere SAFE, which is the local default.
 */
export function assistantBackendEnvironment(
  id: AssistantBackendEnvironment | undefined
): AssistantBackendEnvironmentInfo {
  return (
    (id === undefined ? undefined : BY_ID.get(id)) ??
    BY_ID.get(DEFAULT_ASSISTANT_BACKEND_ENVIRONMENT)!
  );
}

/**
 * Whether an id may be WRITTEN as a new choice.
 *
 * Deliberately narrower than `isAssistantBackendEnvironment`, which answers whether a
 * stored id can be READ. A legacy id has to keep resolving; it does not have to keep
 * being writable, and letting one be written again would recreate the duplicate-choice
 * state this split exists to end.
 */
export function isSelectableAssistantBackendEnvironment(
  value: unknown
): value is AssistantBackendEnvironment {
  return isAssistantBackendEnvironment(value) && !assistantBackendEnvironment(value).legacy;
}

/**
 * The id a stored value should be treated as.
 *
 * A legacy id collapses onto the selectable environment resolving to the same URL, so
 * the rest of the app only ever sees a live choice. Without this the picker is handed a
 * value with no matching option and renders blank — the control looks broken, and the
 * setting behind it looks unset.
 *
 * Falls back to the default for anything unrecognised, for the same reason
 * `assistantBackendEnvironment` does: a corrupted settings file must not stop the
 * assistant launching, and the safe place to launch is local.
 */
export function canonicalAssistantBackendEnvironment(value: unknown): AssistantBackendEnvironment {
  if (!isAssistantBackendEnvironment(value)) return DEFAULT_ASSISTANT_BACKEND_ENVIRONMENT;
  const info = assistantBackendEnvironment(value);
  if (!info.legacy) return value;
  const equivalent = SELECTABLE_ASSISTANT_BACKEND_ENVIRONMENTS.find((e) => e.url === info.url);
  return equivalent?.id ?? DEFAULT_ASSISTANT_BACKEND_ENVIRONMENT;
}
