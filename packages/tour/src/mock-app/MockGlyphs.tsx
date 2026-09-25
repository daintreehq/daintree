import { cn } from "../kit/cn.js";
import {
  resolveMockAgent,
  resolveMockState,
  useMockKit,
  type MockAgent,
  type MockAgentId,
  type MockStateId,
} from "./MockKitContext.js";

export function MockAgentIcon({
  agent,
  className,
}: {
  /** A known id, or a full descriptor for an agent the kit hasn't been given. */
  agent: MockAgentId | MockAgent;
  className?: string;
}) {
  const { Icon, color } = resolveMockAgent(useMockKit(), agent);
  return (
    <span style={{ color }} className="inline-flex shrink-0">
      {Icon ? (
        <Icon className={cn("size-3.5", className)} />
      ) : (
        <span className={cn("size-3.5", className)} aria-hidden="true" />
      )}
    </span>
  );
}

/** An agent's bare glyph, uncoloured, as a menu row or a line of text draws it. */
export function MockAgentGlyph({
  agent,
  className,
}: {
  agent: MockAgentId | MockAgent;
  className?: string;
}) {
  const { Icon } = resolveMockAgent(useMockKit(), agent);
  return Icon ? <Icon className={className} /> : null;
}

/** The host app's own mark, the one its assistant button wears. */
export function MockAppMark({ className }: { className?: string }) {
  const { assistantIcon: Icon } = useMockKit();
  return Icon ? <Icon className={className} /> : null;
}

export function MockStateGlyph({ state }: { state: MockStateId | null }) {
  const kit = useMockKit();
  const visual = state === null ? undefined : resolveMockState(kit, state);
  // Reserved box, as in the real header: the glyph never shifts the title.
  if (!visual?.Icon) return <span className="size-3.5 shrink-0" aria-hidden="true" />;
  const { Icon, colorClass, iconClassName } = visual;
  return (
    <span className={cn("inline-flex size-3.5 shrink-0 items-center", colorClass)}>
      <Icon className={cn("size-3.5", iconClassName)} />
    </span>
  );
}
