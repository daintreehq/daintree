import { Circle, Globe, XCircle } from "lucide-react";
import type {
  PluginDevServerState,
  PluginDevServerStatusProps,
  PluginPortLinkProps,
} from "@shared/types/plugin-sdk-react";
import { isLocalhostUrl } from "@shared/utils/urlUtils";
import { CopyButton } from "@/components/ui/CopyButton";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { hasContent, node, nonEmpty, oneOf, pickRootProps, str } from "./kitProps";
import { FOCUS_RING, dispatchOpen } from "./kitGitShared";

// ---------------------------------------------------------------------------
// PortLink and DevServerStatus

/** The loopback URL a `PortLink` opens, or null. Exported for tests. */
export function portLinkUrl(url: unknown, port: unknown): string | null {
  const given = nonEmpty(url);
  if (given !== undefined) {
    if (!isLocalhostUrl(given)) return null;
    const parsed = new URL(given);
    // Credentials would ride along to the panel unseen: the label hides them.
    return parsed.username || parsed.password ? null : parsed.toString();
  }
  if (typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535) {
    return `http://localhost:${port}/`;
  }
  return null;
}

function addressOf(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.host}${path}${parsed.search}`;
}

export function KitPortLink({
  url,
  port,
  target,
  copyable,
  children,
  className,
  ...rest
}: PluginPortLinkProps) {
  const href = portLinkUrl(url, port);
  const external = target === "external";
  const shown = hasContent(children) ? node(children) : href ? addressOf(href) : (str(url) ?? "");
  if (!href) {
    return (
      <span
        {...pickRootProps(rest)}
        className={cn("font-mono text-xs text-text-secondary", str(className))}
      >
        {shown}
      </span>
    );
  }
  return (
    <span
      {...pickRootProps(rest)}
      data-kit-port-link=""
      className={cn("inline-flex min-w-0 max-w-full items-center gap-0.5", str(className))}
    >
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          dispatchOpen(external ? "browser.openExternal" : "browser.openUrl", href);
        }}
        onAuxClick={(event) => event.preventDefault()}
        aria-label={`Open ${addressOf(href)}${external ? " in your browser" : " in a browser panel"}`}
        className={cn(
          "min-w-0 truncate rounded-xs font-mono text-xs text-text-link underline decoration-1 underline-offset-2 hover:decoration-2",
          FOCUS_RING
        )}
      >
        {shown}
      </a>
      {copyable !== false ? (
        <CopyButton text={href} aria-label={`Copy ${addressOf(href)}`} tooltip="Copy address" />
      ) : null}
    </span>
  );
}

const DEV_STATES = [
  "starting",
  "installing",
  "running",
  "crashed",
  "stopping",
  "stopped",
] as const satisfies readonly PluginDevServerState[];

const DEV_WORD: Record<PluginDevServerState, string> = {
  starting: "Starting…",
  installing: "Installing dependencies…",
  running: "Running",
  crashed: "Crashed",
  stopping: "Stopping…",
  stopped: "Stopped",
};

function DevGlyph({ status }: { status: PluginDevServerState }) {
  switch (status) {
    case "running":
      return <Globe aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-activity-working" />;
    case "crashed":
      return <XCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-status-error" />;
    case "stopped":
      return <Circle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-secondary" />;
    default:
      return <Spinner size="xs" className="text-text-secondary" />;
  }
}

export function KitDevServerStatus({
  status,
  name,
  url,
  port,
  error,
  target,
  actions,
  className,
  ...rest
}: PluginDevServerStatusProps) {
  const at = oneOf(status, DEV_STATES) ?? "stopped";
  const label = nonEmpty(name) ?? "Dev server";
  const href = at === "running" ? portLinkUrl(url, port) : null;
  const reason = at === "crashed" ? nonEmpty(error) : undefined;
  return (
    <div
      {...pickRootProps(rest)}
      data-dev-server-status={at}
      className={cn("flex min-w-0 flex-col gap-0.5 text-xs", str(className))}
    >
      <div className="flex min-h-6 min-w-0 items-center gap-2">
        <DevGlyph status={at} />
        <span role="status" className="flex min-w-0 shrink items-baseline gap-1.5">
          <span className="truncate font-medium text-text-primary">{label}</span>
          <span
            className={cn(
              "shrink-0",
              at === "crashed" ? "text-status-error" : "text-text-secondary"
            )}
          >
            {DEV_WORD[at]}
          </span>
        </span>
        {href ? (
          <KitPortLink
            url={href}
            target={oneOf(target, ["panel", "external"] as const)}
            className="min-w-0"
          />
        ) : null}
        <span className="flex-1" />
        {hasContent(actions) ? (
          <span className="flex shrink-0 items-center gap-0.5">{node(actions)}</span>
        ) : null}
      </div>
      {reason ? (
        <p className="m-0 line-clamp-2 break-words pl-5.5 font-mono text-2xs text-text-secondary">
          {reason}
        </p>
      ) : null}
    </div>
  );
}
