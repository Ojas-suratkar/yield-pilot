import { clearSavedQueries } from "../lib/query";
import { Component, createContext, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpDown, Check, Info, Loader2, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@yield/core/ui/tooltip";
import { FLOW } from "../lib/project";
import type { Step } from "../lib/query";
import { can, useSession } from "../lib/auth";

/** Each part of the workflow has its own companion colour (CSS variable holding an HSL triplet). */
export const TONE: Record<string, string> = {
  home: "--c-home", data: "--c-data", audit: "--c-audit", setup: "--c-setup", features: "--c-features",
  train: "--c-train", results: "--c-results", scenarios: "--c-scenarios", reports: "--c-reports",
};
export const tone = (key?: string, alpha = 1) => `hsl(var(${TONE[key ?? "home"] ?? "--c-home"}) / ${alpha})`;

/** Where we are in the flow, and what comes before and after. */
export function useFlow() {
  const { pathname } = useLocation();
  const i = FLOW.findIndex((f) => f.sub.path === pathname);
  return { here: FLOW[i], prev: i > 0 ? FLOW[i - 1] : undefined, next: FLOW[i + 1] };
}

/** The label on the main button: the mockup's wording between steps, "Next: …" inside a step. */
export function nextLabel(from = FLOW[0], to?: (typeof FLOW)[number]) {
  if (!to) return "Done";
  if (to.section.key === from.section.key) return `Next: ${to.sub.label}`;
  return to.section.cta;
}

const Footer = createContext<HTMLElement | null>(null);

const WIDTH = { narrow: "max-w-[820px]", normal: "max-w-[1180px]", wide: "max-w-[1560px]" };

/**
 * Every page is a frame the height of the window: header, content, and the action bar docked
 * at the bottom. Content only scrolls when it truly can't fit.
 *  - center: short pages sit in the middle of the frame instead of hugging the top
 *  - fill:   dashboards stretch to exactly the frame's height
 *  - top:    long lists start at the top
 */
export function Page({
  title,
  description,
  children,
  actions,
  wide,
  width = wide ? "wide" : "normal",
  mode = "center",
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
  wide?: boolean;
  width?: keyof typeof WIDTH;
  mode?: "center" | "fill" | "top";
}) {
  const { here } = useFlow();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const body = (
    <>
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          {here && here.section.key !== "home" && (
            <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold" style={{ color: tone(here.section.key) }}>
              <span className="grid h-6 w-6 place-items-center rounded-md" style={{ background: tone(here.section.key, 0.12) }}>
                <here.section.icon className="h-3.5 w-3.5" />
              </span>
              {here.section.step ? `Step ${here.section.step} · ` : ""}
              {here.section.label}
            </div>
          )}
          <h1 className="text-[23px] font-semibold leading-tight tracking-[-0.03em]">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-[14px] leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
      </header>
      <div className={cn("flex min-h-0 flex-col", mode === "fill" ? "mt-5 flex-1" : "mt-6")}>{children}</div>
    </>
  );
  return (
    <Footer.Provider value={slot}>
      <div key={here?.sub.path ?? String(title)} className="page-enter flex h-full flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className={cn("mx-auto flex w-full flex-col px-6 py-6 lg:px-10", WIDTH[width], mode === "fill" ? "h-full" : "min-h-full")}>
            {mode === "center" ? <div className="my-auto pb-[4vh]">{body}</div> : body}
          </div>
        </div>
        <div ref={setSlot} className="shrink-0 empty:hidden" />
      </div>
    </Footer.Provider>
  );
}

/** The bar docked under every page: Back on the left, the one next action on the right. */
export function NextBar({ label, onNext, to, note, disabled }: { label?: string; onNext?: () => unknown; to?: string; note?: string; disabled?: boolean }) {
  const nav = useNavigate();
  const slot = useContext(Footer);
  const { here, prev, next } = useFlow();
  const target = to ?? next?.sub.path;
  if (!slot) return null;
  return createPortal(
    <div className="border-t bg-card/95">
      <div className="flex items-center gap-2 px-4 py-3 sm:gap-4 sm:px-6 lg:px-10">
        {prev && (
          <Button variant="ghost" size="sm" className="h-9 shrink-0 text-muted-foreground hover:text-foreground" onClick={() => nav(prev.sub.path)}>
            <ArrowLeft /> Back
          </Button>
        )}
        {note && <span className="hidden text-[13px] text-muted-foreground md:block">{note}</span>}
        {target && (
          <Button
            className="group ml-auto h-10 min-w-0 rounded-full px-5 shadow-[0_6px_16px_-6px_hsl(var(--primary)/0.6)]"
            disabled={disabled}
            onClick={() => {
              const r = onNext?.();
              if (r instanceof Promise) r.then(() => nav(target)).catch((e: Error) => toast.error(e.message));
              else nav(target);
            }}
          >
            <span className="truncate">{label ?? nextLabel(here, next)}</span> <ArrowRight className="transition-transform duration-200 group-hover:translate-x-0.5" />
          </Button>
        )}
      </div>
    </div>,
    slot,
  );
}

/** The sub-step tracker, shown in the top bar. */
export function StepTrack() {
  const { here } = useFlow();
  const s = here?.section;
  if (!s) return null;
  return (
    <div className="flex min-w-0 items-center gap-3">
      {s.step ? (
        <span className="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold tracking-[0.04em]" style={{ background: tone(s.key, 0.12), color: tone(s.key) }}>
          STEP {s.step}/7
        </span>
      ) : null}
      <span className="shrink-0 text-[13.5px] font-semibold">{s.label}</span>
      {s.subs.length > 1 && (
        <ol className="hidden min-w-0 items-center gap-1 md:flex" aria-label="Progress in this step">
          {s.subs.map((sub, i) => {
            const on = sub.key === here.sub.key;
            const done = i < here.index;
            return (
              <li key={sub.key} className="flex items-center gap-1">
                <span className={cn("h-px w-4", done || on ? "bg-primary/40" : "bg-border")} />
                <span
                  className={cn(
                    "flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium transition-colors duration-200",
                    on ? "bg-primary/10 font-semibold text-primary" : done ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {done ? <Check className="h-3.5 w-3.5 text-good" strokeWidth={3} /> : <sub.icon className="h-3.5 w-3.5" />}
                  {sub.label}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** A choice card: big, tappable, with a radio or checkbox mark in the corner. */
export function Tile({
  on,
  onClick,
  icon,
  title,
  text,
  badge,
  multi,
  children,
  className,
  iconTone,
}: {
  iconTone?: string;
  on: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  title: React.ReactNode;
  text?: React.ReactNode;
  badge?: React.ReactNode;
  multi?: boolean;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={on}
      onClick={onClick}
      className={cn("surface-btn group relative flex flex-col p-5", on && "surface-on", className)}
    >
      <span
        className={cn(
          "absolute right-4 top-4 grid h-5 w-5 place-items-center border-2 transition-colors duration-200",
          multi ? "rounded-md" : "rounded-full",
          on ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card group-hover:border-primary/50",
        )}
      >
        {on && <Check className="h-3 w-3" strokeWidth={3.5} />}
      </span>
      {icon && (
        <span
          className={cn(
            "mb-4 grid h-11 w-11 place-items-center rounded-xl transition-colors duration-200 [&>svg]:h-[22px] [&>svg]:w-[22px]",
            iconTone ?? (on ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary"),
          )}
        >
          {icon}
        </span>
      )}
      <span className="flex items-center gap-2 pr-7 text-[15px] font-semibold tracking-[-0.01em]">
        {title}
        {badge}
      </span>
      {text && <span className="mt-1 block text-[13px] leading-relaxed text-muted-foreground">{text}</span>}
      {children}
    </button>
  );
}

/** A big, friendly choice row. Tap anywhere on it. */
export function Option({
  on,
  onClick,
  icon,
  title,
  text,
  badge,
}: {
  on: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  title: string;
  text?: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn("surface-btn group flex w-full items-center gap-3.5 px-4 py-3", on && "surface-on")}
    >
      {icon && (
        <span
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-lg transition-colors [&>svg]:h-5 [&>svg]:w-5",
            on ? "bg-primary text-primary-foreground" : "bg-muted text-foreground/70 group-hover:text-primary",
          )}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[15px] font-semibold">
          {title}
          {badge && <span className="rounded-full bg-good/15 px-2 py-0.5 text-[11px] font-semibold text-good">{badge}</span>}
        </span>
        {text && <span className="mt-0.5 block text-sm text-muted-foreground">{text}</span>}
      </span>
      <span
        className={cn(
          "grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 transition-colors",
          on ? "border-primary bg-primary text-primary-foreground" : "border-input",
        )}
      >
        {on && <Check className="h-3 w-3" strokeWidth={3.5} />}
      </span>
    </button>
  );
}

export function Section({
  title,
  description,
  children,
  className,
  aside,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  aside?: React.ReactNode;
}) {
  return (
    <section className={cn("mt-6 first:mt-0", className)}>
      {(title || aside) && (
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            {title && <h2 className="text-[14.5px] font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
          </div>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/** A small uppercase label for card headings. */
export function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground", className)}>{children}</div>;
}

export function Ring({
  value,
  size = 132,
  stroke = 12,
  label,
  sub,
  color = "hsl(var(--primary))",
}: {
  value: number;
  size?: number;
  stroke?: number;
  label: string;
  sub?: string;
  color?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="hsl(var(--muted))" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.max(0, Math.min(1, value)))}
          className="transition-[stroke-dashoffset] duration-700 ease-out"
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="font-semibold leading-none tracking-[-0.03em] tabular-nums" style={{ fontSize: Math.max(16, size * 0.2) }}>
            {label}
          </div>
          {sub && <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>}
        </div>
      </div>
    </div>
  );
}

export function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger className="inline-flex align-middle text-muted-foreground hover:text-primary" aria-label="More information">
        <Info className="h-4 w-4" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-sm leading-relaxed">{text}</TooltipContent>
    </Tooltip>
  );
}

/** The standard card surface. */
export function Soft({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("surface p-5", className)}>{children}</div>;
}

export function Loading({ text = "One moment…" }: { text?: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-3 py-24 text-muted-foreground">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" /> {text}
    </div>
  );
}

/** A whole page's empty state: what's missing and the one button that fixes it. Never a blank screen. */
export function Blocked({ title, text, cta, to, icon = <Info /> }: { title: string; text: string; cta: string; to: string; icon?: React.ReactNode }) {
  const nav = useNavigate();
  return (
    <div className="page-enter flex h-full items-center justify-center px-6">
      <div className="surface flex max-w-md flex-col items-center px-8 py-10 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-secondary text-primary [&>svg]:h-6 [&>svg]:w-6">{icon}</span>
        <h1 className="mt-4 text-[18px] font-semibold tracking-[-0.02em]">{title}</h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">{text}</p>
        <Button className="mt-5 rounded-full px-5" onClick={() => nav(to)}>
          {cta} <ArrowRight />
        </Button>
      </div>
    </div>
  );
}

/** A request failed: say so plainly and offer a retry, instead of spinning forever. */
export function Failed({ error, retry }: { error: string; retry: () => unknown }) {
  return (
    <div className="flex h-full items-center justify-center py-20">
      <div className="surface max-w-md px-6 py-5 text-center">
        <p className="text-[13.5px] text-muted-foreground">{error}</p>
        <Button size="sm" variant="outline" className="mt-3 rounded-full" onClick={() => void retry()}>
          Try again
        </Button>
      </div>
    </div>
  );
}

export const NeedsData = () => (
  <Blocked title="Add your data first" text="Upload a file or connect a system. Every step after this one works from your data." cta="Add data" to="/data/source" />
);
export const NeedsForecast = () => (
  <Blocked title="No forecast yet" text="Run a prediction to see projected enrollment, scenarios and reports." cta="Go to Train & Predict" to="/train/review" />
);

/* ---------------------------------------------------------------- tables */

export type SortState = { key: string; desc: boolean };

/** A column header that sorts its table: click to sort, click again to flip. */
export function SortTh({ label, k, sort, onSort, className }: { label: React.ReactNode; k: string; sort: SortState; onSort: (s: SortState) => void; className?: string }) {
  const on = sort.key === k;
  const Icon = !on ? ArrowUpDown : sort.desc ? ArrowDown : ArrowUp;
  return (
    <th className={cn("px-4", className)} aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button
        onClick={() => onSort({ key: k, desc: on ? !sort.desc : true })}
        className={cn("inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground", on && "text-foreground")}
      >
        {label}
        <Icon className={cn("h-3 w-3", !on && "opacity-40")} />
      </button>
    </th>
  );
}

/** Sort and filter rows held in the browser (tables of up to a few thousand rows). Numbers sort as numbers. */
export function useTable<T extends Record<string, unknown>>(rows: T[], initial: SortState, text: (r: T) => string = (r) => Object.values(r).join(" ")) {
  const [sort, setSort] = useState<SortState>(initial);
  const [q, setQ] = useState("");
  const shown = rows
    .filter((r) => !q.trim() || text(r).toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      if (x == null || x === "") return 1;
      if (y == null || y === "") return -1;
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return sort.desc ? -c : c;
    });
  return { shown, sort, setSort, q, setQ };
}

/** The small search box that filters a table. */
export function TableSearch({ value, onChange, placeholder = "Filter", className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <div className={cn("relative w-48", className)}>
      <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-8 w-full rounded-full border border-input bg-background pl-8 pr-3 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  );
}

/** Choices only some roles can change: everyone else sees them as they are, without being able to click them. */
export function ViewOnlyArea({ role, children }: { role: Parameters<typeof can>[1]; children: React.ReactNode }) {
  const ok = can(useSession().me, role);
  return <div className={cn("contents", !ok && "[&_*]:pointer-events-none")} aria-disabled={!ok || undefined}>{children}</div>;
}

/** Delete with a second click to confirm (no browser pop-ups). The confirm state resets after a few seconds. */
export function ConfirmDelete({
  label,
  confirm = "Click again to delete",
  onConfirm,
  className,
}: {
  label?: string;
  confirm?: string;
  onConfirm: () => Promise<unknown> | void;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const click = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!armed) return setArmed(true);
    setBusy(true);
    try {
      await onConfirm();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };
  return (
    <button
      onClick={(e) => void click(e)}
      disabled={busy}
      aria-label={armed ? confirm : label ?? "Delete"}
      title={armed ? confirm : label ?? "Delete"}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full text-[12.5px] font-medium transition-colors",
        armed ? "bg-destructive px-3 py-1.5 text-white" : label ? "border border-destructive/30 px-3 py-1.5 text-destructive hover:bg-destructive/5" : "p-1.5 text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive",
        className,
      )}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
      {armed ? confirm : label}
    </button>
  );
}

const clock = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

/** A real progress bar: the percentage is what the server reports (bytes sent, rows read, trees trained, steps
 * finished), never a guess. The timer shows the task is alive during steps that can't be measured, like the AI review. */
export function ProgressBar({ step, className }: { step?: Step; className?: string }) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const pct = Math.min(100, Math.max(0, Math.round(step?.pct ?? 0)));
  return (
    <div className={cn("w-full", className)} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={step?.label || "Working"}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-[13.5px] font-medium leading-snug">{step?.label || "Starting"}</span>
        <span className="text-[15px] font-semibold tabular-nums">{pct}%</span>
      </div>
      <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-primary/10">
        <div
          className={cn("h-full rounded-full bg-primary transition-[width] duration-500 ease-out", pct < 100 && "yp-live")}
          style={{ width: `${Math.max(pct, 1.5)}%` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between gap-3 text-[12px] tabular-nums text-muted-foreground">
        <span className="truncate">{step?.detail}</span>
        <span className="shrink-0">{clock(Math.round((now - start) / 1000))}</span>
      </div>
    </div>
  );
}

/** If a page ever fails to render, show a plain message and a way back instead of a blank screen. */
export class ErrorBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: Error) {
    console.error(e);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="surface max-w-md px-8 py-8 text-center">
          <div className="text-[16px] font-semibold">This page didn't load properly</div>
          <p className="mt-1.5 text-[13.5px] text-muted-foreground">Your data and forecasts are safe. Reload to try again.</p>
          <Button className="mt-5" onClick={() => (clearSavedQueries(true), location.reload())}>
            Reload
          </Button>
        </div>
      </div>
    );
  }
}
