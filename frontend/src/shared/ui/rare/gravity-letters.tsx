// RareUI-inspired GravityLetters (rareui.com) — reimplemented on the Glyph design system.
import { useCallback, useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export interface GlyphParticle {
  id: number;
  char: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  vAngle: number;
  radius: number;
  opacity: number;
  fading?: boolean;
}

export interface GravityBounds {
  width: number;
  height: number;
}

export interface GravityLettersProps {
  type?: "letters" | "numbers" | "both";
  items?: string[];
  gravity?: number;
  size?: number;
  color?: string;
  maxGlyphs?: number;
  className?: string;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const NUMBERS = "0123456789".split("");
const BOTH = [...LETTERS, ...NUMBERS];

const FLOOR_RESTITUTION = 0.35;
const PARTICLE_RESTITUTION = 0.3;

export function stepParticles(
  particles: GlyphParticle[],
  dt: number,
  gravity: number,
  bounds: GravityBounds,
): GlyphParticle[] {
  const clampedDt = Math.min(Math.max(dt, 0), 0.05);
  if (clampedDt === 0 || bounds.width <= 0 || bounds.height <= 0) {
    return particles;
  }

  const next: GlyphParticle[] = [];
  for (const p of particles) {
    const opacity = p.fading ? p.opacity - clampedDt * 2.5 : p.opacity;
    if (opacity <= 0) continue;

    let vy = p.vy + gravity * clampedDt;
    let vx = p.vx;
    let x = p.x + vx * clampedDt;
    let y = p.y + vy * clampedDt;
    let vAngle = p.vAngle;
    const angle = p.angle + vAngle * clampedDt;

    // Wall collisions
    if (x - p.radius < 0) {
      x = p.radius;
      vx = Math.abs(vx) * 0.4;
    } else if (x + p.radius > bounds.width) {
      x = bounds.width - p.radius;
      vx = -Math.abs(vx) * 0.4;
    }

    // Floor collision
    if (y + p.radius >= bounds.height) {
      y = bounds.height - p.radius;
      if (vy > 0) {
        vy = -vy * FLOOR_RESTITUTION;
        if (Math.abs(vy) < 18) {
          vy = 0;
        }
      }
      vx *= 0.86;
      vAngle *= 0.8;
      if (Math.abs(vx) < 2) vx = 0;
      if (Math.abs(vAngle) < 0.05) vAngle = 0;
    }

    next.push({
      ...p,
      x,
      y,
      vx,
      vy,
      angle,
      vAngle,
      opacity,
    });
  }

  // Pairwise circle collision so glyphs pile into rounded hills
  for (let i = 0; i < next.length; i++) {
    const a = next[i];
    if (!a) continue;
    for (let j = i + 1; j < next.length; j++) {
      const b = next[j];
      if (!b) continue;

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const minDist = a.radius + b.radius;

      if (dist < minDist) {
        const nx = dist > 0.0001 ? dx / dist : 0;
        const ny = dist > 0.0001 ? dy / dist : -1;
        const overlap = (minDist - dist) * 0.5;

        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;

        const rvx = b.vx - a.vx;
        const rvy = b.vy - a.vy;
        const velAlongNormal = rvx * nx + rvy * ny;

        if (velAlongNormal < 0) {
          const impulse = (-(1 + PARTICLE_RESTITUTION) * velAlongNormal) * 0.5;
          a.vx -= impulse * nx;
          a.vy -= impulse * ny;
          b.vx += impulse * nx;
          b.vy += impulse * ny;

          // Tangential damping for stable piles
          a.vx *= 0.94;
          b.vx *= 0.94;
          a.vAngle *= 0.9;
          b.vAngle *= 0.9;
        }

        // Re-clamp to bounds after separation
        a.x = Math.min(Math.max(a.x, a.radius), bounds.width - a.radius);
        a.y = Math.min(a.y, bounds.height - a.radius);
        b.x = Math.min(Math.max(b.x, b.radius), bounds.width - b.radius);
        b.y = Math.min(b.y, bounds.height - b.radius);
      }
    }
  }

  return next;
}

function pickGlyph(type: "letters" | "numbers" | "both", items?: string[]): string {
  const pool = items && items.length > 0 ? items : type === "numbers" ? NUMBERS : type === "both" ? BOTH : LETTERS;
  return pool[Math.floor(Math.random() * pool.length)] ?? "A";
}

export function GravityLetters({
  type = "letters",
  items,
  gravity = 1800,
  size = 28,
  color = "currentColor",
  maxGlyphs = 60,
  className,
}: GravityLettersProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<GlyphParticle[]>([]);
  const nextIdRef = useRef(1);
  const pourTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pointerXRef = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();

  const spawnAt = useCallback(
    (x: number, y?: number) => {
      const canvas = canvasRef.current;
      const width = canvas?.clientWidth || 320;
      const radius = size * 0.46;
      const clampedX = Math.min(Math.max(x, radius), Math.max(radius, width - radius));

      const particle: GlyphParticle = {
        id: nextIdRef.current++,
        char: pickGlyph(type, items),
        x: clampedX,
        y: y ?? radius + 4,
        vx: (Math.random() - 0.5) * 90,
        vy: 20 + Math.random() * 40,
        angle: (Math.random() - 0.5) * 0.5,
        vAngle: (Math.random() - 0.5) * 5,
        radius,
        opacity: 1,
      };

      const list = [...particlesRef.current, particle];
      // Mark oldest active particles as fading past maxGlyphs
      let activeCount = list.filter((p) => !p.fading).length;
      for (const p of list) {
        if (activeCount <= maxGlyphs) break;
        if (!p.fading) {
          p.fading = true;
          activeCount -= 1;
        }
      }
      particlesRef.current = list;
    },
    [items, maxGlyphs, size, type],
  );

  const stopPour = useCallback(() => {
    if (pourTimerRef.current) {
      clearInterval(pourTimerRef.current);
      pourTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const syncSize = () => {
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const w = canvas.clientWidth || 320;
      const h = canvas.clientHeight || 200;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      return { w, h, dpr };
    };

    const draw = () => {
      const { w, h, dpr } = syncSize();
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const resolvedColor =
        color === "currentColor" && typeof getComputedStyle === "function"
          ? getComputedStyle(canvas).color || "#1c1c21"
          : color;

      ctx.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = resolvedColor;

      for (const p of particlesRef.current) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, p.opacity));
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillText(p.char, 0, 0);
        ctx.restore();
      }
      ctx.restore();
    };

    if (reducedMotion) {
      const { w, h } = syncSize();
      if (particlesRef.current.length === 0) {
        const radius = size * 0.46;
        const count = Math.min(14, maxGlyphs);
        const seeded: GlyphParticle[] = [];
        for (let i = 0; i < count; i++) {
          const frac = (i + 0.5) / count;
          seeded.push({
            id: nextIdRef.current++,
            char: pickGlyph(type, items),
            x: radius + frac * Math.max(1, w - radius * 2),
            y: h - radius - (i % 3) * (radius * 0.4),
            vx: 0,
            vy: 0,
            angle: ((i % 5) - 2) * 0.12,
            vAngle: 0,
            radius,
            opacity: 1,
          });
        }
        particlesRef.current = seeded;
      }
      draw();
      return;
    }

    // Seed a few initial glyphs so the field isn't empty on mount
    if (particlesRef.current.length === 0) {
      const w = canvas.clientWidth || 320;
      for (let i = 0; i < 6; i++) {
        spawnAt(w * (0.2 + i * 0.12), size * 0.6 + (i % 2) * 18);
      }
    }

    let rafId = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      const { w, h } = syncSize();
      particlesRef.current = stepParticles(particlesRef.current, dt, gravity, {
        width: w,
        height: h,
      });
      draw();
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      stopPour();
    };
  }, [color, gravity, items, maxGlyphs, reducedMotion, size, spawnAt, stopPour, type]);

  const getLocalX = (clientX: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? clientX - rect.left : 160;
  };

  return (
    <div
      className={cn(
        "relative h-52 w-full overflow-hidden rounded-card border border-border bg-surface-2/50 text-ink select-none",
        className,
      )}
    >
      <canvas
        ref={canvasRef}
        aria-label="Interactive gravity letters field. Click or hold to drop glyphs."
        onPointerDown={(e) => {
          const x = getLocalX(e.clientX);
          pointerXRef.current = x;
          spawnAt(x);
          if (!reducedMotion) {
            stopPour();
            pourTimerRef.current = setInterval(() => {
              if (pointerXRef.current !== null) {
                spawnAt(pointerXRef.current);
              }
            }, 125);
          }
        }}
        onPointerMove={(e) => {
          if (pourTimerRef.current) {
            pointerXRef.current = getLocalX(e.clientX);
          }
        }}
        onPointerUp={stopPour}
        onPointerLeave={stopPour}
        onPointerCancel={stopPour}
        className="block h-full w-full cursor-crosshair touch-none"
      />
      <span className="pointer-events-none absolute bottom-2 right-2.5 text-[11px] text-ink-subtle">
        Click or hold to drop
      </span>
    </div>
  );
}
