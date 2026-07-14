import { type SVGProps } from "react";
import { Flame } from "lucide-react";

type StreakTier = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export function getStreakTier(days: number): StreakTier {
  if (days >= 240) return 7;
  if (days >= 120) return 6;
  if (days >= 60) return 5;
  if (days >= 30) return 4;
  if (days >= 15) return 3;
  if (days >= 8) return 2;
  return 1;
}

// Per-theme streak stops (pulse-streak-1..7), warm at the short end and cool at
// the long end. Each is OPTIONAL and bakes the original ramp in as its fallback,
// so a theme that never authors them renders exactly the flame it always did.
// Static per-tier references (not a template literal over the tier index) so the
// EXTENSION_KEYS drift scanner registers each stop as a consumer.
export function getStreakColor(days: number): string {
  switch (getStreakTier(days)) {
    case 7:
      return "var(--pulse-streak-7, #9333EA)";
    case 6:
      return "var(--pulse-streak-6, #C026D3)";
    case 5:
      return "var(--pulse-streak-5, #DC2626)";
    case 4:
      return "var(--pulse-streak-4, #EF4444)";
    case 3:
      return "var(--pulse-streak-3, #F97316)";
    case 2:
      return "var(--pulse-streak-2, #FB923C)";
    default:
      return "var(--pulse-streak-1, #F59E0B)";
  }
}

interface StreakFlameProps extends Omit<SVGProps<SVGSVGElement>, "ref"> {
  streakDays: number;
  size?: number;
}

export function StreakFlame({ streakDays, size = 14, className, ...svgProps }: StreakFlameProps) {
  const color = getStreakColor(streakDays);
  return (
    <Flame
      className={className}
      style={{ color, width: size, height: size }}
      aria-hidden
      {...(svgProps as Record<string, unknown>)}
    />
  );
}
