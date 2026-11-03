import { DECISIONS_REMOVE_TERMINAL_PREFIX } from "./terminalScreenPersistence.js";

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const REMOVABLE_ORIGIN = new RegExp(`^https://${LABEL}(?:\\.${LABEL})+$`);
const REMOVE_TERMINAL_ID = new RegExp(
  `^${DECISIONS_REMOVE_TERMINAL_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`
);

/**
 * An origin the guided relay removal (#16202) can be handed: https, a DNS
 * name of two labels or more, no port, as `URL.origin` writes it. It is the one
 * thing from outside on the removal's command line, and nothing in it means
 * anything to a shell. A local `http://` development relay has no Cloudflare
 * Worker to remove.
 */
export function isRemovableRelayOrigin(origin: string): boolean {
  return origin.length <= 261 && REMOVABLE_ORIGIN.test(origin);
}

/** A removal pane's id: the prefix, then a fresh UUID. */
export function isRelayRemovalTerminalId(terminalId: string): boolean {
  return REMOVE_TERMINAL_ID.test(terminalId);
}

const REMOVE_COMMAND =
  /^(npx|npx\.cmd) --yes (@daintreehq\/decisions-cli@\d+\.\d+\.\d+) remove (\S+)$/;

/**
 * The guided removal's command line, as the renderer builds it, taken apart
 * into the argv it runs, or null for anything else. The spawn runs a removal
 * pane only from this, so nothing but the pinned CLI's `remove` of a relay
 * origin ever runs under a removal id.
 */
export function parseRelayRemovalCommand(command: string): string[] | null {
  const match = REMOVE_COMMAND.exec(command);
  if (!match) return null;
  const [, npx, cli, origin] = match;
  if (!npx || !cli || !origin || !isRemovableRelayOrigin(origin)) return null;
  return [npx, "--yes", cli, "remove", origin];
}
