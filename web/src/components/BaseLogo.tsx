/**
 * Base's mark: a circle with a squared-off right edge. Drawn inline so it inherits `currentColor`
 * and needs no asset request (the CSP on a deployed artifact would block one anyway).
 */
export function BaseLogo({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 111 111" fill="none" className={className} aria-hidden>
      <path
        d="M54.921 110.034c30.438 0 55.117-24.647 55.117-55.047C110.038 24.588 85.359 0 54.921 0 26.043 0 2.353 22.171 0 50.392h72.847v9.25H0c2.353 28.222 26.043 50.392 54.921 50.392Z"
        fill="currentColor"
      />
    </svg>
  );
}
