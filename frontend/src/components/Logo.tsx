import { cn } from "@yield/core";

/** YieldPilot mark: a paper plane climbing, guided forward. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("h-9 w-9 shrink-0", className)} role="img" aria-label="YieldPilot">
      <defs>
        <linearGradient id="yp-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8B6CF0" />
          <stop offset="1" stopColor="#5B3FD0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#yp-g)" />
      <path d="M7.5 17.2 24.5 8.5l-4.6 15.3-4.1-5.3-8.3-1.3Z" fill="#fff" />
      <path d="M15.8 18.5 24.5 8.5" stroke="#D8CCFF" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M15.8 18.5v4.3l2.1-2.6" fill="#EEE8FF" />
    </svg>
  );
}

export function Logo({ className, tagline = true, inverted }: { className?: string; tagline?: boolean; inverted?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <Mark />
      <span className="leading-none">
        <span className={cn("block font-display text-[19px] font-extrabold tracking-[-0.02em]", inverted ? "text-white" : "text-foreground")}>
          Yield<span className={inverted ? "text-violet-300" : "text-primary"}>Pilot</span>
        </span>
        {tagline && (
          <span className={cn("mt-1 block text-[11px]", inverted ? "text-white/60" : "text-muted-foreground")}>Admission Yield Prediction Made Simple</span>
        )}
      </span>
    </span>
  );
}
