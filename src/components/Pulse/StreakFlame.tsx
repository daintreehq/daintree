import { type SVGProps } from "react";
import { Flame } from "lucide-react";

const STREAK_TIERS = [
  { min: 240, color: "var(--color-accent-primary)" },
  { min: 120, color: "#C026D3" },
  { min: 60, color: "#DC2626" },
  { min: 30, color: "#EF4444" },
  { min: 15, color: "#F97316" },
  { min: 8, color: "#FB923C" },
  { min: 0, color: "#F59E0B" },
] as const;

export function getStreakColor(days: number): string {
  for (const tier of STREAK_TIERS) {
    if (days >= tier.min) return tier.color;
  }
  return "#F59E0B";
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
