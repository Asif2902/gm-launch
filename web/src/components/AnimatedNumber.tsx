import { useEffect, useRef, useState } from "react";

/**
 * Renders a formatted value and flashes green/orange when it changes, the way a trading terminal
 * does. The direction of the flash is derived from the underlying numeric value, and the text
 * itself never changes colour permanently — colour here is a transient cue layered on a value
 * that is always legible on its own.
 */
export function AnimatedNumber({
  value,
  format,
  className = "",
}: {
  /** Raw comparable value; drives flash direction. */
  value: bigint | number;
  /** Display string for the current value. */
  format: string;
  className?: string;
}) {
  const previous = useRef<bigint | number>(value);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (value === previous.current) return;
    setFlash(value > previous.current ? "up" : "down");
    previous.current = value;

    const timer = setTimeout(() => setFlash(null), 900);
    return () => clearTimeout(timer);
  }, [value]);

  return (
    <span
      className={`tnum inline-block rounded px-1 -mx-1 ${
        flash === "up" ? "animate-flash-up" : flash === "down" ? "animate-flash-down" : ""
      } ${className}`}
    >
      {format}
    </span>
  );
}

/**
 * Eases a number up to its target on mount. Used for headline stats where the count-up reads as
 * "this is live", not as decoration.
 */
export function CountUp({
  value,
  decimals = 0,
  suffix = "",
  className = "",
}: {
  value: number;
  decimals?: number;
  suffix?: string;
  className?: string;
}) {
  const [display, setDisplay] = useState(0);
  const frame = useRef<number>();

  useEffect(() => {
    const start = performance.now();
    const from = display;
    const duration = 900;

    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(from + (value - from) * eased);
      if (progress < 1) frame.current = requestAnimationFrame(step);
    };

    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <span className={`tnum ${className}`}>
      {display.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
      {suffix}
    </span>
  );
}
