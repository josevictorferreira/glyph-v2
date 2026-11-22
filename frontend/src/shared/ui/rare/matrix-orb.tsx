// RareUI-inspired MatrixOrb (rareui.com) — reimplemented on the Glyph design system.
import { useEffect, useMemo, useRef } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export type MatrixOrbState = "idle" | "listening" | "thinking";

/** Sunflower (phyllotaxis) layout: even dot coverage of the unit disc for any count. */
export function dotLayout(count: number): { x: number; y: number }[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: count }, (_, i) => ({
    x: Math.sqrt((i + 0.5) / count) * Math.cos(i * golden),
    y: Math.sqrt((i + 0.5) / count) * Math.sin(i * golden),
  }));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Internal bloom envelope (0–1) per state.
 * idle = gentle slow breathing; listening = reactive pulse (quick attack,
 * exponential decay, double-beat); thinking = quicker asymmetric
 * sawtooth-ish rise/fall.
 */
export function matrixEnvelope(state: MatrixOrbState, t: number): number {
  switch (state) {
    case "idle": {
      return clamp01(0.46 + 0.14 * Math.sin((2 * Math.PI * t) / 3.8 - Math.PI / 2));
    }
    case "listening": {
      const ph = ((t % 1.5) + 1.5) % 1.5;
      const beat = (p: number) => Math.exp(-5 * p);
      const echo = ph > 0.45 ? 0.55 * beat(ph - 0.45) : 0;
      return clamp01(0.3 + 0.6 * Math.max(beat(ph), echo));
    }
    case "thinking": {
      const cycle = (((t * 1.5) % 1) + 1) % 1;
      const saw = cycle < 0.3 ? cycle / 0.3 : 1 - (cycle - 0.3) / 0.7;
      return clamp01(0.35 + 0.55 * saw);
    }
  }
}

/** Travelling-wave speed per state (Hz-ish). */
const WAVE_SPEED: Record<MatrixOrbState, number> = { idle: 0.35, listening: 0.8, thinking: 1.4 };

/**
 * Brightness of one dot (0–1): the bloom level lifted/lowered by a radial
 * wave travelling from the center outwards.
 */
export function dotBrightness(
  dot: { x: number; y: number },
  level: number,
  t: number,
  speed: number,
): number {
  const dist = Math.hypot(dot.x, dot.y);
  return clamp01(level + 0.18 * Math.sin(2 * Math.PI * (t * speed - dist * 2)));
}

const VIEWBOX_SPAN = 100;

export const computeEnvelope = matrixEnvelope;

export interface MatrixOrbProps {
  state: MatrixOrbState;
  /** External bloom level 0–1; when omitted it is generated per `state`. */
  level?: number;
  size?: number;
  /** Any CSS color. */
  color?: string;
  dots?: number;
  /** Captions rendered under the orb, keyed by state. */
  labels?: Partial<Record<MatrixOrbState, string>>;
  className?: string;
}

/** Dot-matrix orb whose dots breathe in waves — an ambient AI activity indicator. */
export function MatrixOrb({
  state,
  level,
  size = 120,
  color = "var(--c-accent)",
  dots = 15,
  labels,
  className,
}: MatrixOrbProps) {
  const reduced = useReducedMotion() ?? false;
  const positions = useMemo(() => dotLayout(dots), [dots]);
  const circleRefs = useRef<(SVGCircleElement | null)[]>([]);
  const caption = labels?.[state];

  useEffect(() => {
    const speed = WAVE_SPEED[state];
    const start = performance.now();
    const applyFrame = (t: number) => {
      const bloom = level ?? matrixEnvelope(state, t);
      const baseR = (size / VIEWBOX_SPAN) * 2.6;
      positions.forEach((dot, i) => {
        const el = circleRefs.current[i];
        if (!el) return;
        const b = dotBrightness(dot, bloom, t, speed);
        el.setAttribute("r", String(baseR * (0.7 + 0.75 * b)));
        el.setAttribute("fill-opacity", String(0.35 + 0.65 * b));
      });
    };
    if (reduced || typeof requestAnimationFrame === "undefined") {
      applyFrame(0.9);
      return;
    }
    let raf = 0;
    const loop = (now: number) => {
      if (!document.hidden) applyFrame((now - start) / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [state, level, size, positions, reduced]);

  const radius = VIEWBOX_SPAN / 2 - 2;
  return (
    <div className={cn("flex shrink-0 flex-col items-center gap-2", className)}>
      <svg
        width={size}
        height={size}
        viewBox={`${-VIEWBOX_SPAN / 2} ${-VIEWBOX_SPAN / 2} ${VIEWBOX_SPAN} ${VIEWBOX_SPAN}`}
        role="img"
        aria-label={caption ? undefined : state}
        data-testid="matrix-orb"
        className="overflow-visible"
      >
        <circle
          cx={0}
          cy={0}
          r={radius}
          fill="none"
          stroke="var(--c-border)"
          strokeWidth={1}
          opacity={0.6}
        />
        {positions.map((dot, i) => (
          <circle
            key={i}
            ref={(el) => {
              circleRefs.current[i] = el;
            }}
            cx={dot.x * radius}
            cy={dot.y * radius}
            r={(size / VIEWBOX_SPAN) * 2.6}
            fill={color}
            fillOpacity={0.5}
          />
        ))}
      </svg>
      {caption && (
        <span className="text-xs text-ink-muted" data-testid="matrix-orb-caption">
          {caption}
        </span>
      )}
    </div>
  );
}
