import { useId, useRef, useEffect, useState, type SVGProps } from "react";
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

interface FlameColors {
  base: string;
  mid: string;
  tip: string;
}

interface MilestoneConfig {
  intensity: number;
  duration: number;
  colors: FlameColors;
  sparkInterval: number;
}

function getMilestoneConfig(days: number): MilestoneConfig | null {
  if (days >= 240)
    return {
      intensity: 2.5,
      duration: 30_000,
      colors: { base: "#FFFFFF", mid: "#B0C4FF", tip: "#0044FF" },
      sparkInterval: 800,
    };
  if (days >= 120)
    return {
      intensity: 1.8,
      duration: 25_000,
      colors: { base: "#FFD700", mid: "#FFFFFF", tip: "#B0C4FF" },
      sparkInterval: 1200,
    };
  if (days >= 60)
    return {
      intensity: 1.2,
      duration: 20_000,
      colors: { base: "#FF6600", mid: "#FFD700", tip: "#FFFFFF" },
      sparkInterval: 1600,
    };
  if (days >= 30)
    return {
      intensity: 0.8,
      duration: 15_000,
      colors: { base: "#FF3300", mid: "#FF6600", tip: "#FFD700" },
      sparkInterval: 2000,
    };
  return null;
}

function noise(t: number): number {
  return (Math.sin(t) + Math.sin(t * 1.618) + Math.sin(t * 2.718)) / 3;
}

function buildFlamePath(
  t: number,
  intensity: number,
  speed: number,
  phase: number
): string {
  const s = t * speed + phase;
  const amp = intensity;

  const bx1 = 4 + noise(s * 0.3) * amp * 0.3;
  const bx2 = 12 - noise(s * 0.3 + 1) * amp * 0.3;

  const mx1 = 2 + noise(s * 0.7 + 2) * amp * 0.8;
  const my1 = 12 + noise(s * 0.5 + 3) * amp * 1.2;
  const mx2 = 14 - noise(s * 0.7 + 4) * amp * 0.8;
  const my2 = 12 + noise(s * 0.5 + 5) * amp * 1.2;

  const tipX = 8 + noise(s * 1.1 + 6) * amp * 1.0;
  const wispBoost = Math.pow(Math.max(0, noise(s * 0.4 + 7)), 8) * amp * 4;
  const tipY = 2 - noise(s * 0.9 + 8) * amp * 0.8 - wispBoost;

  return `M ${bx1} 22 Q ${mx1} ${my1}, ${tipX} ${tipY} Q ${mx2} ${my2}, ${bx2} 22 Z`;
}

const FRAME_INTERVAL = 1000 / 14;
const LS_KEY = "streak-flame-last-played";

interface StreakFlameProps extends Omit<SVGProps<SVGSVGElement>, "ref"> {
  streakDays: number;
  size?: number;
}

export function StreakFlame({
  streakDays,
  size = 14,
  className,
  ...svgProps
}: StreakFlameProps) {
  const id = useId();
  const milestone = getMilestoneConfig(streakDays);
  const color = getStreakColor(streakDays);

  const svgRef = useRef<SVGSVGElement>(null);
  const outerRef = useRef<SVGPathElement>(null);
  const midRef = useRef<SVGPathElement>(null);
  const coreRef = useRef<SVGPathElement>(null);
  const sparksRef = useRef<SVGGElement>(null);

  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    if (!milestone) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    if (reducedMotion) return;

    const today = new Date().toISOString().slice(0, 10);
    try {
      if (localStorage.getItem(LS_KEY) === today) return;
    } catch {
      // localStorage unavailable — animate anyway
    }

    setAnimating(true);
  }, [milestone]);

  useEffect(() => {
    if (!animating || !milestone) return;

    const { intensity, duration, sparkInterval } = milestone;
    let rafId = 0;
    let lastFrame = 0;
    let startTime = 0;
    let paused = false;

    const update = (now: number) => {
      if (!startTime) startTime = now;
      if (paused) {
        rafId = requestAnimationFrame(update);
        return;
      }

      const elapsed = now - startTime;
      if (elapsed > duration) {
        setAnimating(false);
        try {
          localStorage.setItem(LS_KEY, new Date().toISOString().slice(0, 10));
        } catch {
          // ignore
        }
        return;
      }

      if (now - lastFrame < FRAME_INTERVAL) {
        rafId = requestAnimationFrame(update);
        return;
      }
      lastFrame = now;

      const t = elapsed / 1000;
      outerRef.current?.setAttribute(
        "d",
        buildFlamePath(t, intensity * 2.0, 0.8, 0)
      );
      midRef.current?.setAttribute(
        "d",
        buildFlamePath(t, intensity * 1.2, 1.2, 0.4)
      );
      coreRef.current?.setAttribute(
        "d",
        buildFlamePath(t, intensity * 0.5, 1.8, 0.9)
      );

      rafId = requestAnimationFrame(update);
    };

    rafId = requestAnimationFrame(update);

    // Spark spawner
    const sparkTimer = setInterval(() => {
      const container = sparksRef.current;
      if (!container || container.children.length >= 3) return;

      const circle = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "circle"
      );
      circle.setAttribute("cx", String(7 + Math.random() * 2));
      circle.setAttribute("cy", String(3 + Math.random() * 2));
      circle.setAttribute("r", "0.8");
      circle.setAttribute("fill", milestone.colors.tip);
      circle.setAttribute("class", "streak-spark");

      const cleanup = () => circle.remove();
      circle.addEventListener("animationend", cleanup);
      const fallback = setTimeout(cleanup, 1000);
      circle.addEventListener("animationend", () => clearTimeout(fallback));

      container.appendChild(circle);
    }, sparkInterval);

    // Intersection observer — pause when offscreen
    let observer: IntersectionObserver | undefined;
    const svg = svgRef.current;
    if (svg && "IntersectionObserver" in window) {
      observer = new IntersectionObserver(([entry]) => {
        paused = !entry.isIntersecting;
      });
      observer.observe(svg);
    }

    const onVisibility = () => {
      paused = document.hidden;
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(rafId);
      clearInterval(sparkTimer);
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [animating, milestone]);

  const gradId = `${id}-grad`;

  if (!milestone || !animating) {
    const isReducedMotionMilestone =
      milestone &&
      !animating &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    return (
      <Flame
        className={`${isReducedMotionMilestone ? "streak-flame-glow" : ""} ${className ?? ""}`}
        style={{ color, width: size, height: size }}
        aria-hidden
        {...(svgProps as Record<string, unknown>)}
      />
    );
  }

  return (
    <svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox="0 0 16 24"
      style={{ overflow: "visible", color }}
      aria-hidden
      className={className}
      {...svgProps}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor={milestone.colors.base} />
          <stop offset="50%" stopColor={milestone.colors.mid} />
          <stop offset="100%" stopColor={milestone.colors.tip} />
        </linearGradient>
      </defs>
      <g
        style={{
          willChange: "transform",
          transformBox: "fill-box" as const,
          transformOrigin: "center bottom",
        }}
      >
        <path ref={outerRef} fill={`url(#${gradId})`} opacity={0.4} />
        <path ref={midRef} fill={`url(#${gradId})`} opacity={0.65} />
        <path ref={coreRef} fill={`url(#${gradId})`} opacity={0.9} />
      </g>
      <g ref={sparksRef} />
    </svg>
  );
}
