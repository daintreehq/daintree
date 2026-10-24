import { type MouseEvent } from "react";
import type { PluginForgePerson } from "@shared/types/plugin-sdk-react";
import { safeDetailsUrl } from "@/components/Worktree/ReviewHub/prChecks";
import { field, nonEmpty } from "./kitProps";
import { pluginKitDates } from "./PluginKitDates";
import { pluginKitOverlays } from "./PluginKitOverlays";
import { getPluginKitHost } from "./kitHost";
import { reportPluginFault } from "./kitDiagnostics";

export const KitAvatar = pluginKitOverlays.Avatar;
export const KitTimeAgo = pluginKitDates.TimeAgo;

export const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary";

export function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Runs a host action for a press, logging a refusal: dispatch resolves `{ ok: false }` rather than throwing. */
export function dispatchFromKit(actionId: string, args: Record<string, unknown>): void {
  getPluginKitHost()
    .dispatchAction(actionId, args, { source: "user" })
    .then(
      (result) => {
        if (!result.ok) reportPluginFault(`${actionId} failed`, result.error);
      },
      (error: unknown) => reportPluginFault(`${actionId} failed`, error)
    );
}

export function dispatchOpen(
  actionId: "browser.openExternal" | "browser.openUrl",
  url: string
): void {
  dispatchFromKit(actionId, { url });
}

/** An http(s) URL a forge or CI provider handed over, opened in the system browser. */
export function openForgeUrl(url: string | undefined): void {
  const safe = safeDetailsUrl(url);
  if (safe) dispatchOpen("browser.openExternal", safe);
}

/**
 * Keeps a press from moving DOM focus: Chromium focuses a pressed button or
 * link even at tabIndex -1, which would pull focus out of a list's own field.
 */
export function preventFocusSteal(event: MouseEvent<HTMLElement>): void {
  event.preventDefault();
}

/** The middot between a row's metadata, kept inside the item it introduces. */
export function Dot() {
  return (
    <span aria-hidden="true" className="shrink-0">
      &middot;
    </span>
  );
}

export function readPerson(value: unknown): PluginForgePerson | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const name = nonEmpty(field(value, "name"));
  if (!name) return undefined;
  return {
    name,
    avatarUrl: nonEmpty(field(value, "avatarUrl")),
    email: nonEmpty(field(value, "email")),
  };
}

export function readPeople(value: unknown): PluginForgePerson[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const person = readPerson(raw);
    return person ? [person] : [];
  });
}
