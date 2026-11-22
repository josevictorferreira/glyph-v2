// RareUI-inspired VoiceNote (rareui.com) — reimplemented on the Glyph design system.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";

export interface VoiceNoteProps {
  src?: string;
  duration?: number;
  waveform?: number[];
  playing?: boolean;
  defaultPlaying?: boolean;
  onPlayingChange?: (playing: boolean) => void;
  onEnded?: () => void;
  accent?: string;
  size?: "sm" | "md" | "lg";
  seekable?: boolean;
  className?: string;
}

const SPEEDS = [1, 1.5, 2] as const;
type PlaybackSpeed = (typeof SPEEDS)[number];

export function generateWaveform(bars = 36, seed = 7): number[] {
  const count = Math.max(1, Math.floor(bars));
  let state = seed >>> 0 || 1;
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    // Mulberry32 step
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const rand = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    // Shape into natural voice-like envelope in [0.18, 1]
    const envelope = 0.18 + rand * 0.82;
    result.push(Math.min(1, Math.max(0, Number(envelope.toFixed(3)))));
  }
  return result;
}

export function clampSeek(time: number, duration: number): number {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  return Math.min(duration, Math.max(0, time));
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

const SIZE_STYLES = {
  sm: {
    container: "px-2.5 py-1.5 gap-2",
    button: "h-7 w-7",
    icon: 12,
    waveHeight: "h-6",
    barWidth: "w-[2px]",
    text: "text-[11px]",
  },
  md: {
    container: "px-3 py-2 gap-2.5",
    button: "h-9 w-9",
    icon: 14,
    waveHeight: "h-8",
    barWidth: "w-[2.5px]",
    text: "text-xs",
  },
  lg: {
    container: "px-3.5 py-2.5 gap-3",
    button: "h-11 w-11",
    icon: 16,
    waveHeight: "h-10",
    barWidth: "w-[3px]",
    text: "text-xs",
  },
} as const;

export function VoiceNote({
  src,
  duration = 24,
  waveform,
  playing,
  defaultPlaying = false,
  onPlayingChange,
  onEnded,
  accent = "var(--c-accent)",
  size = "md",
  seekable = true,
  className,
}: VoiceNoteProps) {
  const reducedMotion = Boolean(useReducedMotion());
  const bars = useMemo(() => waveform ?? generateWaveform(36, 7), [waveform]);

  const [internalPlaying, setInternalPlaying] = useState(defaultPlaying);
  const isPlayingControlled = playing !== undefined;
  const isPlaying = isPlayingControlled ? playing : internalPlaying;

  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const totalDuration = src && audioDuration !== null ? audioDuration : duration;

  const [currentTime, setCurrentTime] = useState(0);
  const [speedIndex, setSpeedIndex] = useState(0);
  const speed: PlaybackSpeed = SPEEDS[speedIndex] ?? 1;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const waveRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const onPlayingChangeRef = useRef(onPlayingChange);
  const onEndedRef = useRef(onEnded);
  const currentTimeRef = useRef(currentTime);

  useEffect(() => {
    onPlayingChangeRef.current = onPlayingChange;
    onEndedRef.current = onEnded;
    currentTimeRef.current = currentTime;
  });

  const setPlayingState = useCallback(
    (next: boolean) => {
      if (!isPlayingControlled) {
        setInternalPlaying(next);
      }
      onPlayingChangeRef.current?.(next);
    },
    [isPlayingControlled],
  );

  const seekTo = useCallback(
    (nextTime: number) => {
      const clamped = clampSeek(nextTime, totalDuration);
      setCurrentTime(clamped);
      if (src && audioRef.current) {
        audioRef.current.currentTime = clamped;
      }
    },
    [src, totalDuration],
  );

  // Sync <audio> element when src is provided
  useEffect(() => {
    if (!src || !audioRef.current) return;
    const audio = audioRef.current;
    audio.playbackRate = speed;
    if (isPlaying) {
      const p = audio.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {});
      }
    } else {
      audio.pause();
    }
  }, [src, isPlaying, speed]);

  // Timer-driven simulation when src is absent
  useEffect(() => {
    if (src || !isPlaying || totalDuration <= 0) return;

    const tickMs = 50;
    const id = window.setInterval(() => {
      // Read the live position each tick so scrubs/arrow-key seeks made while
      // playing are respected instead of being overwritten by a stale closure.
      const next = currentTimeRef.current + (tickMs / 1000) * speed;
      if (next >= totalDuration - 1e-6) {
        window.clearInterval(id);
        currentTimeRef.current = 0;
        setCurrentTime(0);
        setPlayingState(false);
        onEndedRef.current?.();
      } else {
        currentTimeRef.current = next;
        setCurrentTime(next);
      }
    }, tickMs);

    return () => window.clearInterval(id);
  }, [src, isPlaying, totalDuration, speed, setPlayingState]);

  const scrubFromClientX = useCallback(
    (clientX: number) => {
      if (!seekable || !waveRef.current || totalDuration <= 0) return;
      const rect = waveRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      seekTo(ratio * totalDuration);
    },
    [seekable, totalDuration, seekTo],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!seekable) return;
    draggingRef.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    scrubFromClientX(e.clientX);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    scrubFromClientX(e.clientX);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!seekable) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      seekTo(currentTime - 5);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      seekTo(currentTime + 5);
    } else if (e.key === "Home") {
      e.preventDefault();
      seekTo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      seekTo(totalDuration);
    }
  };

  const cycleSpeed = () => {
    setSpeedIndex((prev) => (prev + 1) % SPEEDS.length);
  };

  const progress = totalDuration > 0 ? Math.min(1, Math.max(0, currentTime / totalDuration)) : 0;
  const styles = SIZE_STYLES[size];

  return (
    <div
      className={cn(
        "relative inline-flex items-center overflow-hidden rounded-full border border-border bg-surface-2 text-ink",
        styles.container,
        className,
      )}
    >
      {src && (
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setAudioDuration(d);
          }}
          onTimeUpdate={(e) => {
            setCurrentTime(e.currentTarget.currentTime);
          }}
          onEnded={() => {
            setCurrentTime(0);
            setPlayingState(false);
            onEndedRef.current?.();
          }}
        />
      )}

      {/* Soft lights sweep across interior while playing */}
      {isPlaying && !reducedMotion && (
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 w-1/2 opacity-20"
          style={{
            background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
          }}
          initial={{ x: "-100%" }}
          animate={{ x: "250%" }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "linear" }}
        />
      )}

      <button
        type="button"
        onClick={() => setPlayingState(!isPlaying)}
        aria-label={isPlaying ? "Pause" : "Play"}
        style={{ backgroundColor: accent }}
        className={cn(
          "relative z-10 inline-flex shrink-0 items-center justify-center rounded-full text-on-accent transition-opacity",
          "hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          styles.button,
        )}
      >
        {/* Fixed-size box; icons overlap absolutely for a true crossfade. */}
        <span
          aria-hidden="true"
          className="relative inline-flex items-center justify-center"
          style={{ width: styles.icon, height: styles.icon }}
        >
          <AnimatePresence initial={false}>
            {isPlaying ? (
              <motion.svg
                key="pause"
                className="absolute inset-0 m-auto"
                width={styles.icon}
                height={styles.icon}
                viewBox="0 0 24 24"
                fill="currentColor"
                initial={reducedMotion ? false : { opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reducedMotion ? undefined : { opacity: 0, scale: 0.6 }}
                transition={{ duration: reducedMotion ? 0 : 0.15 }}
              >
                <rect x="6" y="4" width="4" height="16" rx="1.2" />
                <rect x="14" y="4" width="4" height="16" rx="1.2" />
              </motion.svg>
            ) : (
              <motion.svg
                key="play"
                className="absolute inset-0 m-auto"
                width={styles.icon}
                height={styles.icon}
                viewBox="0 0 24 24"
                fill="currentColor"
                initial={reducedMotion ? false : { opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reducedMotion ? undefined : { opacity: 0, scale: 0.6 }}
                transition={{ duration: reducedMotion ? 0 : 0.15 }}
              >
                <path d="M7 4.5 19.5 12 7 19.5z" />
              </motion.svg>
            )}
          </AnimatePresence>
        </span>
      </button>

      <div
        ref={waveRef}
        role="slider"
        tabIndex={seekable ? 0 : -1}
        aria-label="Audio progress"
        aria-valuemin={0}
        aria-valuemax={totalDuration}
        aria-valuenow={Math.round(currentTime * 10) / 10}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onKeyDown={handleKeyDown}
        className={cn(
          "relative z-10 flex items-center gap-[2px] select-none",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent rounded",
          seekable ? "cursor-pointer" : "cursor-default",
          styles.waveHeight,
        )}
      >
        {bars.map((height, index) => {
          const barRatio = (index + 0.5) / bars.length;
          const isFilled = barRatio <= progress;
          const clampedHeight = Math.min(1, Math.max(0.12, height));
          return (
            <span
              key={index}
              aria-hidden="true"
              style={{
                height: `${Math.round(clampedHeight * 100)}%`,
                backgroundColor: isFilled ? accent : undefined,
              }}
              className={cn(
                "rounded-full transition-colors duration-75",
                styles.barWidth,
                !isFilled && "bg-border-strong",
              )}
            />
          );
        })}
      </div>

      <button
        type="button"
        onClick={cycleSpeed}
        aria-label={`Playback speed ${speed}x, click to change`}
        className={cn(
          "relative z-10 inline-flex shrink-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 font-mono tabular-nums text-ink-muted transition-colors",
          "hover:bg-surface-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          styles.text,
        )}
      >
        <span>
          {formatTime(currentTime)} / {formatTime(totalDuration)}
        </span>
        <span className="rounded bg-surface-3 px-1 py-0.2 text-[10px] font-semibold text-ink">
          {speed}×
        </span>
      </button>
    </div>
  );
}
