import { useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

const PARTICLE_COLORS = [
  "bg-emerald-400",
  "bg-amber-400",
  "bg-sky-400",
  "bg-rose-400",
  "bg-violet-400",
  "bg-teal-400",
];

interface Particle {
  id: number;
  x: number;
  y: number;
  rotate: number;
  size: number;
  color: string;
}

function generateParticles(): Particle[] {
  const count = 6 + Math.floor(Math.random() * 3); // 6-8 particles
  return Array.from({ length: count }, (_, i) => {
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
    const distance = 80 + Math.random() * 120;
    return {
      id: i,
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance,
      rotate: Math.random() * 360,
      size: 6 + Math.random() * 6,
      color: PARTICLE_COLORS[i % PARTICLE_COLORS.length],
    };
  });
}

export function CelebrationConfetti() {
  const reducedMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const [particles] = useState(generateParticles);

  if (reducedMotion) return null;

  return createPortal(
    <div className="fixed inset-0 pointer-events-none z-[var(--z-toast)] flex items-center justify-center">
      <AnimatePresence>
        {particles.map((p) => (
          <motion.div
            key={p.id}
            className={`absolute rounded-full ${p.color}`}
            style={{ width: p.size, height: p.size }}
            initial={{ x: 0, y: 0, scale: 0, opacity: 1 }}
            animate={{
              x: p.x,
              y: p.y,
              scale: [0, 1.5, 1],
              rotate: p.rotate,
              opacity: [1, 1, 0],
            }}
            exit={{ opacity: 0, scale: 0 }}
            transition={{
              type: "spring",
              stiffness: 60,
              damping: 15,
              mass: 0.5,
              opacity: { duration: 0.6, ease: "easeOut" },
            }}
          />
        ))}
      </AnimatePresence>
    </div>,
    document.body
  );
}
