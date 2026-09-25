import { useHostPlatform } from "@/hooks/useHostPlatform";

/**
 * `@<host>` beside a terminal's title in a remote window, so it is never in
 * doubt which machine the shell runs on. Renders nothing for this machine.
 */
export function TerminalHostSuffix() {
  const { hostName } = useHostPlatform();
  if (!hostName) return null;
  return (
    <span
      data-testid="panel-host-suffix"
      className="shrink-0 truncate text-xs font-sans leading-6 text-text-secondary select-none"
    >
      @{hostName}
    </span>
  );
}
