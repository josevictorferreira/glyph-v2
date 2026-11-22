// RareUI-inspired Folder (rareui.com) — reimplemented on the Glyph design system.
import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export interface FolderProps {
  color?: "accent" | "light" | "dark";
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SCALES = { sm: 0.65, md: 1, lg: 1.35 } as const;
const CARD_COUNT = 3;

const PALETTES = {
  accent: {
    back: "color-mix(in srgb, var(--c-accent) 74%, black)",
    front: "var(--c-accent)",
    border: "transparent",
  },
  light: {
    back: "var(--c-surface-3)",
    front: "var(--c-surface)",
    border: "var(--c-border-strong)",
  },
  dark: {
    back: "color-mix(in srgb, var(--c-ink) 68%, var(--c-canvas))",
    front: "var(--c-ink)",
    border: "transparent",
  },
} as const;

/**
 * An animated folder with paper cards peeking out: hover fans the cards,
 * click opens the lid (3D tilt) and lifts the cards, click again closes.
 */
export function Folder({ color = "accent", size = "md", className }: FolderProps) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const reduce = useReducedMotion() ?? false;
  const transition = reduce
    ? { duration: 0.01 }
    : { type: "spring" as const, stiffness: 320, damping: 26 };

  const s = SCALES[size];
  const width = 150 * s;
  const folderH = 84 * s;
  const pocketH = 58 * s;
  const peek = 28 * s; // space above the folder for the cards to peek/lift
  const containerH = folderH + peek; // ~112px at md
  const cardW = 92 * s;
  const cardH = 104 * s;
  const pocketTop = containerH - pocketH;
  const cardTopRest = pocketTop - 24 * s;
  const pal = PALETTES[color];

  return (
    <motion.button
      type="button"
      aria-pressed={open}
      aria-label="Toggle folder"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => setOpen((o) => !o)}
      whileTap={{ scale: 0.97 }}
      className={cn(
        "relative cursor-pointer appearance-none rounded-card border-0 bg-transparent p-0",
        "outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
        className,
      )}
      style={{ width, height: containerH }}
    >
      {/* Back panel: tilts back like a lid when open. */}
      <motion.div
        aria-hidden
        className="absolute left-0 z-[1] rounded-t-md"
        style={{
          top: peek,
          width,
          height: folderH,
          backgroundColor: pal.back,
          border: `1px solid ${pal.border}`,
          transformPerspective: 700 * s,
          transformOrigin: `50% ${folderH - pocketH}px`,
        }}
        animate={{ rotateX: open ? -55 : 0 }}
        transition={transition}
      />

      {/* Paper cards: peeking at rest, fanned on hover, lifted when open. */}
      {Array.from({ length: CARD_COUNT }, (_, i) => {
        const fan = i - (CARD_COUNT - 1) / 2;
        const target = open
          ? { x: fan * 26 * s, y: -22 * s, rotate: fan * 13 }
          : hovered
            ? { x: fan * 13 * s, y: -7 * s, rotate: fan * 8 }
            : { x: 0, y: 0, rotate: fan * 1.5 };
        return (
          <motion.div
            key={i}
            aria-hidden
            className="absolute z-[2]"
            style={{
              left: (width - cardW) / 2 + fan * 3 * s,
              top: cardTopRest,
              width: cardW,
              height: cardH,
              borderRadius: 5 * s,
              backgroundColor: "var(--c-surface)",
              border: "1px solid var(--c-border-strong)",
              boxShadow: "0 2px 6px rgb(0 0 0 / 0.14)",
              padding: 9 * s,
              transformOrigin: "50% 95%",
            }}
            animate={target}
            transition={transition}
          >
            <div style={{ paddingTop: 8 * s }}>
              {[0.72, 0.9, 0.55, 0.38].map((frac, k) => (
                <div
                  key={k}
                  style={{
                    width: `${frac * 100}%`,
                    height: 5 * s,
                    borderRadius: 999,
                    marginBottom: 7 * s,
                    backgroundColor: k === 0 ? "var(--c-accent-soft)" : "var(--c-surface-3)",
                  }}
                />
              ))}
            </div>
          </motion.div>
        );
      })}

      {/* Front pocket with slanted top edges. */}
      <div
        aria-hidden
        className="absolute left-0 z-[3]"
        style={{
          top: pocketTop,
          width,
          height: pocketH,
          backgroundColor: pal.front,
          border: `1px solid ${pal.border}`,
          borderRadius: `0 0 ${10 * s}px ${10 * s}px`,
          clipPath: "polygon(0 26%, 16% 0, 84% 0, 100% 26%, 100% 100%, 0 100%)",
          boxShadow: "0 10px 18px -8px rgb(0 0 0 / 0.3)",
        }}
      />
    </motion.button>
  );
}
