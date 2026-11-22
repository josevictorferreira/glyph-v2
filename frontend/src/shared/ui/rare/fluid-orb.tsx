// RareUI-inspired FluidOrb (rareui.com) — reimplemented on the Glyph design system.
import { useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";

const ORB_DEFAULT = "#5B5BD6";

/** Parse #rgb / #rrggbb into channels; null when not a hex color. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return null;
  const digits =
    m[1].length === 3
      ? m[1]
          .split("")
          .map((c) => c + c)
          .join("")
      : m[1];
  const n = Number.parseInt(digits, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Linear mix of two hex colors; t=0 → a, t=1 → b. Unparseable input falls back to the accent. */
export function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a) ?? hexToRgb(ORB_DEFAULT) ?? { r: 91, g: 91, b: 214 };
  const cb = hexToRgb(b) ?? { r: 255, g: 255, b: 255 };
  const k = Math.min(1, Math.max(0, t));
  const ch = (from: number, to: number) =>
    Math.round(from + (to - from) * k)
      .toString(16)
      .padStart(2, "0");
  return `#${ch(ca.r, cb.r)}${ch(ca.g, cb.g)}${ch(ca.b, cb.b)}`;
}

export interface OrbPalette {
  /** Near-white body the blobs drift over. */
  base: string;
  /** Pale highlight blob. */
  tint: string;
  /** Brighter accent blob. */
  glow: string;
  /** Deep shading blob. */
  shade: string;
  /** Near-white top band. */
  band: string;
}

/** Derive the lava-lamp palette (pale tint + deep shade + near-white band) from a base hex. */
export function deriveOrbPalette(color: string): OrbPalette {
  const c = hexToRgb(color) ? color : ORB_DEFAULT;
  return {
    base: mixHex(c, "#ffffff", 0.86),
    tint: mixHex(c, "#ffffff", 0.6),
    glow: mixHex(c, "#ffffff", 0.3),
    shade: mixHex(c, "#000000", 0.38),
    band: mixHex(c, "#ffffff", 0.94),
  };
}

function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex) ?? { r: 91, g: 91, b: 214 };
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface OrbBlob {
  kind: "tint" | "glow" | "shade";
  radius: number;
  ampX: number;
  ampY: number;
  fx: number;
  fy: number;
  phase: number;
}

// Hand-tuned drift parameters: slow sin/cos paths for a lava-lamp feel.
const BLOBS: OrbBlob[] = [
  { kind: "tint", radius: 0.36, ampX: 0.14, ampY: 0.1, fx: 0.62, fy: 0.41, phase: 0.0 },
  { kind: "glow", radius: 0.28, ampX: 0.12, ampY: 0.14, fx: 0.83, fy: 0.55, phase: 2.1 },
  { kind: "shade", radius: 0.42, ampX: 0.1, ampY: 0.12, fx: 0.47, fy: 0.66, phase: 4.2 },
  { kind: "tint", radius: 0.24, ampX: 0.16, ampY: 0.08, fx: 0.71, fy: 0.5, phase: 1.3 },
  { kind: "glow", radius: 0.31, ampX: 0.09, ampY: 0.15, fx: 0.58, fy: 0.87, phase: 5.0 },
  { kind: "shade", radius: 0.27, ampX: 0.13, ampY: 0.11, fx: 0.9, fy: 0.38, phase: 3.3 },
];

function drawFluidOrb(
  ctx: CanvasRenderingContext2D,
  size: number,
  palette: OrbPalette,
  t: number,
): void {
  const r = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.arc(r, r, r - 0.5, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = palette.base;
  ctx.fillRect(0, 0, size, size);
  for (const blob of BLOBS) {
    const cx = (0.5 + blob.ampX * Math.sin(t * blob.fx + blob.phase)) * size;
    const cy = (0.55 + blob.ampY * Math.cos(t * blob.fy + blob.phase * 1.7)) * size;
    const rr = blob.radius * size;
    const color =
      blob.kind === "shade" ? palette.shade : blob.kind === "glow" ? palette.glow : palette.tint;
    const alpha = blob.kind === "shade" ? 0.55 : 0.85;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
    grad.addColorStop(0, rgba(color, alpha));
    grad.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  // The top band stays near-white, like light falling on the orb.
  const band = ctx.createLinearGradient(0, 0, 0, size * 0.62);
  band.addColorStop(0, rgba(palette.band, 0.95));
  band.addColorStop(1, rgba(palette.band, 0));
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, size, size * 0.62);
  ctx.restore();
}

export interface FluidOrbProps {
  /** Base hex color the palette is derived from. */
  color?: string;
  size?: number;
  className?: string;
}

/** Ambient orb with drifting fluid shading (ChatGPT voice-mode vibe). */
export function FluidOrb({ color = ORB_DEFAULT, size = 120, className }: FluidOrbProps) {
  const reduced = useReducedMotion() ?? false;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [canvasSupported, setCanvasSupported] = useState(true);
  const palette = useMemo(() => deriveOrbPalette(color), [color]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      // jsdom / headless without a 2D canvas implementation.
      setCanvasSupported(false);
      return;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (reduced) {
      drawFluidOrb(ctx, size, palette, 1.25);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const loop = (now: number) => {
      if (!document.hidden) drawFluidOrb(ctx, size, palette, (now - start) / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [palette, size, reduced]);

  return (
    <div
      data-testid="fluid-orb"
      aria-hidden="true"
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
    >
      {canvasSupported ? (
        <canvas ref={canvasRef} className="h-full w-full rounded-full" />
      ) : (
        <div
          className="h-full w-full rounded-full"
          style={{
            background: `radial-gradient(circle at 50% 36%, ${palette.band} 0%, ${palette.tint} 34%, ${palette.base} 58%, ${palette.shade} 118%)`,
          }}
        />
      )}
    </div>
  );
}
