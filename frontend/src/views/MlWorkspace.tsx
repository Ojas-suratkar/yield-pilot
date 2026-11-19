import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip as ChartTip, XAxis, YAxis } from "recharts";
import {
  BarChart3, Bot, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock, Download, FlaskConical, GitCompare, Info, Layers, Loader2,
  Play, Repeat, RotateCcw, Save, Search, Share2, SlidersHorizontal, Sparkles, Square, Star, Target, Trophy, Undo2, Upload, User, Users, Zap,
} from "lucide-react";
import { toast } from "sonner";
import { cn, fmtDate } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Slider } from "@yield/core/ui/slider";
import { Popover, PopoverContent, PopoverTrigger } from "@yield/core/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@yield/core/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@yield/core/ui/tooltip";
import { Failed, Loading, Page, ProgressBar, Soft } from "../components/ui";
import {
  API, type MlCandidate, type MlExperiment, type MlMember, type MlMetrics, type MlObjective, type MlParam, type MlResult, type MlSettings, type MlVal,
} from "../lib/api";
import { tuning, useTuning } from "../lib/tuning";
import { termName } from "../lib/labels";
import { can, useSession } from "../lib/auth";
import { runNow, useProject, useRunner } from "../lib/project";

/*
 * The ML workspace: tune the XGBoost model behind a prediction.
 * - Smart (AI): the AI proposes complete sets of settings (a value and a reason for every setting), tests them, studies the scores
 *   and tests a refined round; or apply its values to Model Settings, one by one or all at once.
 * - Custom: a person sets the values; tuning compares them with the defaults.
 * - Expert: a systematic search across chosen ranges, trials spread evenly, scored for the chosen goal.
 * Every experiment is logged with every number; any candidate can be used in this prediction's runs or made the workspace default.
 * Everything is read from and saved to the database.
 */

type Mode = "smart" | "custom" | "expert";
type State = "default" | "modified" | "unsaved";
type Space = Record<string, { on: boolean; from: string; to: string }>;

const SERVER_MODE: Record<Mode, string> = { smart: "recommended", custom: "custom", expert: "expert" };
const MODE_LABEL: Record<string, string> = { recommended: "Smart (AI)", custom: "Custom", expert: "Expert", default: "Defaults" };
const MODES: { k: Mode; label: React.ReactNode; text: string }[] = [
  { k: "smart", label: <><Bot className="h-4 w-4" /> Smart <span className="font-normal opacity-80">(AI)</span></>,
    text: "The AI proposes complete sets of settings, tests them, studies the scores and tests a refined round. Or apply its values to Model Settings yourself, one by one or all at once." },
  { k: "custom", label: <><User className="h-4 w-4" /> Custom</>,
    text: "You set the values in Model Settings. Run Tuning tests your settings against the defaults on last year's known outcomes." },
  { k: "expert", label: <><Search className="h-4 w-4" /> Expert</>,
    text: "A systematic search: choose which settings to explore and their ranges. Trials are spread evenly across the ranges and scored for your goal." },
];
const MAIN = ["n_estimators", "learning_rate", "max_depth", "min_child_weight", "gamma", "max_delta_step"];
const ADVANCED: [string, string[]][] = [
  ["Sampling and columns", ["subsample", "colsample_bytree", "colsample_bylevel", "colsample_bynode"]],
  ["Regularization and balance", ["reg_lambda", "reg_alpha", "scale_pos_weight", "max_leaves", "grow_policy"]],
  ["Training and cross-validation", ["recency_decay", "folds", "random_state"]],
];
const SEARCH_ON = ["n_estimators", "learning_rate", "max_depth", "min_child_weight", "subsample", "colsample_bytree"];
// the slider's useful span (the number box accepts the whole allowed range)
const SLIDE: Record<string, [number, number, number]> = {
  n_estimators: [50, 3000, 50], learning_rate: [0.005, 0.5, 0.005], max_depth: [1, 16, 1], min_child_weight: [0, 20, 0.5], gamma: [0, 10, 0.1],
  max_delta_step: [0, 10, 0.5], subsample: [0.1, 1, 0.01], colsample_bytree: [0.1, 1, 0.01], colsample_bylevel: [0.1, 1, 0.01],
  colsample_bynode: [0.1, 1, 0.01], reg_lambda: [0, 50, 0.5], reg_alpha: [0, 20, 0.1], scale_pos_weight: [0.1, 5, 0.05], max_leaves: [0, 256, 1],
  recency_decay: [0, 1, 0.01], folds: [2, 10, 1],
};
const METRICS: [keyof MlMetrics, string][] = [
  ["roc_auc", "ROC AUC"], ["pr_auc", "PR AUC"], ["accuracy", "Accuracy"], ["precision", "Precision"], ["recall", "Recall"], ["f1", "F1"],
  ["brier", "Brier"], ["log_loss", "Log loss"], ["error_pct", "Count error"],
];
const SHORT: Record<MlObjective, string> = { roc_auc: "ROC AUC", pr_auc: "PR AUC", f1: "F1 Score", brier: "Brier Score", error_pct: "Count Error" };
const LOWER: MlObjective[] = ["brier", "error_pct"];
const SCORES: [keyof MlMetrics, string][] = [["accuracy", "Accuracy"], ["f1", "F1 Score"], ["recall", "Recall"], ["precision", "Precision"]];

const show = (v: MlVal | undefined) => (v == null ? "–" : typeof v === "string" ? v : Number.isInteger(v) ? v.toLocaleString() : String(+v.toPrecision(4)));
const num = (s: string) => (s.trim() === "" ? null : Number(s));
const val = (x: MlParam, raw: string): MlVal => (x.kind === "choice" ? raw || null : num(raw));
const effective = (x: MlParam) => x.saved ?? x.default;
const fresh = (d: MlSettings) => Object.fromEntries(d.params.map((x) => [x.key, effective(x) == null ? "" : String(effective(x))]));
const fmtM = (k: string, v: number | null | undefined) => (v == null ? "–" : k === "error_pct" ? `${v > 0 ? "+" : ""}${v.toFixed(1)}%` : v.toFixed(3));
const decimals = (step: number) => (String(step).split(".")[1] ?? "").length;
/** A long stored number shown short (0.7452548834 as 0.7453); the box shows the exact value while it's being edited. */
const neat = (raw: string) => (/^-?\d+\.\d{5,}$/.test(raw.trim()) ? String(+Number(raw).toPrecision(4)) : raw);
/** Default (the workspace's or the lab's value), Modified (saved on this prediction) or Unsaved (edited here). A blank box means the default. */
function stateOf(x: MlParam, raw: string): State {
  const v = val(x, raw) ?? x.default;
  if (v !== effective(x)) return "unsaved";
  return x.saved != null ? "modified" : "default";
}
function problem(x: MlParam, raw: string): string | null {
  if (x.kind === "choice") return null;
  const v = num(raw);
  if (v === null) return null;
  if (Number.isNaN(v)) return "Enter a number";
  if (v < x.min || v > x.max) return `Between ${show(x.min)} and ${show(x.max)}`;
  if (x.kind === "int" && !Number.isInteger(v)) return "Whole number";
  return null;
}
/** A candidate's values as settings to use: a run records the random seed it happened to pick, which isn't a choice to keep
 * (unless the candidate set one on purpose). */
const settingsOf = (values: Record<string, MlVal>, params: Record<string, MlVal>): Record<string, MlVal> => ({ ...values, random_state: params.random_state ?? null });
/** How much better `b` is than `d` for the goal, as a share (positive is better). */
function gain(goal: MlObjective, b: number | null | undefined, d: number | null | undefined) {
  if (b == null || d == null) return null;
  if (goal === "error_pct") return Math.abs(d) ? (Math.abs(d) - Math.abs(b)) / Math.abs(d) : null;
  if (!d) return null;
  return LOWER.includes(goal) ? (d - b) / d : (b - d) / d;
}

const BADGE: Record<State, string> = {
  default: "bg-muted text-muted-foreground", modified: "bg-primary/10 text-primary", unsaved: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
};
const BAR: Record<State, string> = { default: "bg-transparent", modified: "bg-primary", unsaved: "bg-amber-500" };
const BADGE_TEXT: Record<State, string> = { default: "Default", modified: "Modified", unsaved: "Unsaved" };

function Help({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="text-muted-foreground/80 hover:text-foreground" aria-label="What this means"><Info className="h-3.5 w-3.5" /></button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[300px] text-[12px] leading-snug">{text}</TooltipContent>
    </Tooltip>
  );
}

function CardTitle({ icon: Icon, children, right, tone = "text-primary" }: { icon: typeof Bot; children: React.ReactNode; right?: React.ReactNode; tone?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]"><Icon className={cn("h-[18px] w-[18px]", tone)} /> {children}</div>
      {right}
    </div>
  );
}

/** One setting: name and explanation, Default / Modified / Unsaved, a slider with the default marked, the exact value and its range. */
function Setting({ x, raw, onChange, disabled, stack }: { x: MlParam; raw: string; onChange: (v: string) => void; disabled: boolean; stack?: boolean }) {
  const [focused, setFocused] = useState(false);
  const v = val(x, raw);
  const err = problem(x, raw);
  const st = stateOf(x, raw);
  const s = SLIDE[x.key];
  const current = typeof v === "number" && !Number.isNaN(v) ? v : typeof x.default === "number" ? x.default : s?.[0] ?? 0;
  const offDefault = (v ?? x.default) !== x.default;
  const tick = s && typeof x.default === "number" ? Math.min(100, Math.max(0, ((x.default - s[0]) / (s[1] - s[0])) * 100)) : null;
  const was = st === "unsaved" ? effective(x) : x.default;

  const label = (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[13px] font-medium">
        <span className="line-clamp-2 leading-tight" title={x.label}>{x.label}</span>
        <Help text={`${x.key}: ${x.help}${x.lab !== x.default ? ` The research lab's value is ${show(x.lab)}.` : ""}`} />
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
        <span className={cn("shrink-0 rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide", BADGE[st])}>{BADGE_TEXT[st]}</span>
        {st !== "default" && (
          <span className="truncate text-[11px] text-muted-foreground">
            {st === "unsaved" && x.saved != null ? "saved" : "default"} <b className="font-semibold tabular-nums text-foreground/80">{was == null ? "auto" : show(was)}</b>
          </span>
        )}
      </div>
    </div>
  );
  const slider = x.kind === "choice" || !s ? (
    <span className="text-[11.5px] text-muted-foreground">{x.kind === "choice" ? (x.options ?? []).join(" or ") : x.key === "random_state" ? "Blank: a new seed each run" : ""}</span>
  ) : (
    <div className="relative w-full">
      <Slider min={s[0]} max={s[1]} step={s[2]} value={[Math.min(s[1], Math.max(s[0], current))]} disabled={disabled} aria-label={`${x.label} slider`}
        onValueChange={([n]) => onChange(String(+n.toFixed(decimals(s[2]))))} className={cn(disabled && "opacity-60")} />
      {tick != null && (
        <span title={`Default: ${show(x.default)}`} className="pointer-events-none absolute top-1/2 h-3.5 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/35"
          style={{ left: `${tick}%` }} />
      )}
    </div>
  );
  const box = (
    <div className="flex items-center gap-1">
      {x.kind === "choice" ? (
        <select className={cn("h-9 w-full rounded-lg border bg-card px-2 text-right text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring", offDefault ? "border-primary/50" : "border-input")}
          value={raw || String(x.default ?? "")} disabled={disabled} aria-label={x.label} onChange={(e) => onChange(e.target.value)}>
          {(x.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input inputMode="decimal" value={focused ? raw : neat(raw)} disabled={disabled} aria-label={x.label} placeholder={x.default == null ? "auto" : show(x.default)}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={(e) => onChange(e.target.value)} title={raw}
          className={cn("h-9 w-full min-w-0 rounded-lg border bg-card px-1.5 text-center text-[13px] font-semibold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
            err ? "border-destructive" : st === "unsaved" ? "border-amber-500/60" : offDefault ? "border-primary/50 text-primary" : "border-input")} />
      )}
      {offDefault && !disabled ? (
        <button type="button" onClick={() => onChange(x.default == null ? "" : String(x.default))} title={`Back to the default (${show(x.default)})`}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`${x.label}: back to default`}>
          <Undo2 className="h-3.5 w-3.5" />
        </button>
      ) : <span className="w-7 shrink-0" />}
    </div>
  );
  const range = <span className="text-[11.5px] tabular-nums text-muted-foreground">{x.kind === "choice" ? "" : `${show(x.min)} – ${show(x.max)}`}</span>;
  const edge = <span className={cn("absolute inset-y-2 left-0 w-[3px] rounded-full", BAR[st])} />;
  if (stack)
    return (
      <div className="relative py-2.5 pl-3">
        {edge}
        <div className="flex items-start justify-between gap-2">{label}{range}</div>
        <div className="mt-1.5 grid grid-cols-[minmax(0,1fr)_120px] items-center gap-3">{slider}{box}</div>
        {err && <div className="mt-0.5 text-right text-[11px] text-destructive">{err}</div>}
      </div>
    );
  return (
    <div className="relative grid grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)_112px_70px] items-center gap-x-3 py-2.5 pl-3">
      {edge}
      {label}
      {slider}
      <div>{box}{err && <div className="mt-0.5 text-right text-[11px] text-destructive">{err}</div>}</div>
      <div className="text-right">{range}</div>
    </div>
  );
}

/** Latest Results: the best candidate's validation scores for the goal, its ROC curve, every candidate side by side, and feature importance. */
function Results({ d, tab, setTab }: { d: MlSettings; tab: "performance" | "importance" | "compare"; setTab: (t: "performance" | "importance" | "compare") => void }) {
  const t = d.test;
  const done = t?.status === "done" && t.results ? t : null;
  const goal = done?.config?.objective ?? "roc_auc";
  const bi = done?.best ?? null;
  const top: MlResult | null = done && bi != null ? done.results![bi] : null;
  const base = done ? done.results!.find((_, i) => done.candidates[i]?.source === "default") : null;
  const headline = top ? top.metrics[goal] : d.forecast?.evaluation?.roc_auc ?? null;
  const lift = top && base && top !== base ? gain(goal, top.metrics[goal], base.metrics[goal]) : null;
  const m = top?.metrics ?? d.forecast?.evaluation ?? null;
  const term = done?.holdout?.target ? termName(done.holdout.target) : null;
  return (
    <div id="ml-results" className="surface flex h-full scroll-mt-24 flex-col p-5">
      <CardTitle icon={Trophy} tone="text-amber-500"
        right={top && <span className="inline-flex items-center gap-1 rounded-full bg-good/10 px-2 py-0.5 text-[11.5px] font-semibold text-good"><Check className="h-3 w-3" /> Best Model</span>}>
        Latest Results
      </CardTitle>
      {m ? (
        <>
          <div className="mt-3 rounded-xl bg-primary/[0.06] px-4 py-3">
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              {top ? `${SHORT[goal]} (Validation)` : "ROC AUC (Latest Run)"}
              <Help text={top ? `The best settings for your goal, scored on ${term ?? "last year"}, a past term whose outcomes are known.${LOWER.includes(goal) ? " Lower is better." : " Higher is better."}`
                : "ROC AUC of the latest forecast's model on this term's known outcomes. Run Tuning to score other settings."} />
            </div>
            <div className="mt-0.5 flex items-end gap-2">
              <span className="text-[38px] font-semibold leading-none tracking-[-0.04em] text-primary tabular-nums">{fmtM(top ? goal : "roc_auc", headline)}</span>
              {lift != null && Math.abs(lift) >= 0.0005 && (
                <span className={cn("mb-1 rounded-full px-1.5 py-0.5 text-[11.5px] font-semibold", lift > 0 ? "bg-good/10 text-good" : "bg-destructive/10 text-destructive")}
                  title="Compared with the defaults">
                  {lift > 0 ? "▲" : "▼"} {Math.abs(lift * 100).toFixed(1)}% {lift > 0 ? "better" : "worse"}
                </span>
              )}
            </div>
            {top && <div className="mt-1 truncate text-[11.5px] text-muted-foreground">{done!.candidates[bi!].name}{term ? ` · validated on ${term}` : ""}</div>}
          </div>
          <div className="mt-3 grid grid-cols-4 gap-2 text-center">
            {(goal === "roc_auc" ? SCORES : ([["roc_auc", "ROC AUC"], ...SCORES.slice(0, 3)] as [keyof MlMetrics, string][])).map(([k, label]) => (
              <div key={k}>
                <div className="text-[11px] text-muted-foreground">{label}</div>
                <div className="text-[16px] font-semibold tabular-nums">{fmtM(k, m[k])}</div>
              </div>
            ))}
          </div>
          {top && top.predicted != null && top.actual != null && (
            <p className="mt-2 text-center text-[11.5px] text-muted-foreground">
              Forecast {Math.round(top.predicted).toLocaleString()} enrolled vs {top.actual.toLocaleString()} actual ({fmtM("error_pct", top.metrics.error_pct)})
            </p>
          )}
        </>
      ) : (
        <p className="mt-3 rounded-xl bg-muted/50 px-4 py-6 text-center text-[13px] text-muted-foreground">Run Tuning to score settings on last year, whose outcomes are known.</p>
      )}
      <div className="mt-4 flex border-b text-[12.5px]" role="tablist">
        {([["performance", "Performance"], ["importance", "Feature Importance"], ["compare", "Compare"]] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cn("-mb-px flex-1 whitespace-nowrap border-b-2 px-1.5 py-2 font-medium transition-colors", tab === k ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {label}
          </button>
        ))}
      </div>
      <div className="mt-3 min-h-[230px] flex-1">
        {tab === "performance" &&
          (top?.roc.length ? (
            <>
              <div className="text-center text-[12.5px] font-semibold">ROC Curve</div>
              <div className="relative h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={top.roc} margin={{ top: 8, right: 10, left: -6, bottom: 14 }}>
                    <defs>
                      <linearGradient id="roc-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.28} />
                        <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="fpr" type="number" domain={[0, 1]} ticks={[0, 0.2, 0.4, 0.6, 0.8, 1]} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false}
                      label={{ value: "False Positive Rate", position: "insideBottom", offset: -8, fontSize: 10.5, fill: "hsl(var(--muted-foreground))" }} />
                    <YAxis dataKey="tpr" type="number" domain={[0, 1]} ticks={[0, 0.2, 0.4, 0.6, 0.8, 1]} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false}
                      label={{ value: "True Positive Rate", angle: -90, position: "insideLeft", offset: 16, fontSize: 10.5, fill: "hsl(var(--muted-foreground))", style: { textAnchor: "middle" } }} />
                    <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" strokeOpacity={0.6} />
                    <ChartTip formatter={(v: number) => v.toFixed(3)} labelFormatter={(v: number) => `False positive rate ${Number(v).toFixed(2)}`}
                      contentStyle={{ fontSize: 12, borderRadius: 10, border: "1px solid hsl(var(--border))", background: "hsl(var(--card))" }} />
                    <Area dataKey="tpr" name="True positive rate" type="linear" stroke="hsl(var(--primary))" strokeWidth={2.25} fill="url(#roc-fill)" dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
                <span className="absolute bottom-10 right-4 inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-[11px] shadow-sm">
                  <span className="h-[2px] w-4 rounded bg-primary" /> AUC = {fmtM("roc_auc", top.metrics.roc_auc)}
                </span>
              </div>
            </>
          ) : (
            <p className="pt-10 text-center text-[12.5px] text-muted-foreground">The ROC curve of the best model appears after Run Tuning.</p>
          ))}
        {tab === "compare" &&
          (done ? (
            <ul className="space-y-2.5">
              {done.candidates.map((c, i) => {
                const raw = done.results![i]?.metrics[goal];
                const a = raw == null ? null : goal === "error_pct" ? Math.abs(raw) : raw;
                const all = done.results!.map((r) => (goal === "error_pct" ? Math.abs(r.metrics[goal] ?? 0) : r.metrics[goal] ?? 0));
                const good = LOWER.includes(goal) ? all.map((x) => Math.max(...all) - x) : all.map((x) => x - Math.min(...all));
                const span = Math.max(...good) || 1;
                const w = a == null ? 0 : Math.max(4, (good[i] / span) * 100);
                return (
                  <li key={i} className="text-[12.5px]">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={cn("flex min-w-0 items-center gap-1.5 truncate", i === done.best && "font-semibold")}>
                        {i === done.best && <Trophy className="h-3.5 w-3.5 shrink-0 text-amber-500" />}<span className="truncate">{c.name}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">{SHORT[goal]} {fmtM(goal, raw)}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-muted">
                      <div className={cn("h-full rounded-full", i === done.best ? "bg-primary" : "bg-primary/35")} style={{ width: `${w}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="pt-10 text-center text-[12.5px] text-muted-foreground">Every candidate's score appears here after Run Tuning.</p>
          ))}
        {tab === "importance" &&
          (d.forecast?.drivers.length ? (
            <ul className="space-y-2">
              {d.forecast.drivers.map((x) => (
                <li key={x.feature} className="text-[12.5px]">
                  <div className="flex justify-between gap-2"><span className="truncate">{x.feature}</span><span className="tabular-nums text-muted-foreground">{(x.share * 100).toFixed(0)}%</span></div>
                  <div className="mt-1 h-1.5 rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(3, (x.share * 100) / (d.forecast!.drivers[0].share || 1))}%` }} /></div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pt-10 text-center text-[12.5px] text-muted-foreground">Feature importance appears after a forecast Run.</p>
          ))}
      </div>
    </div>
  );
}

/** One AI set: every setting's suggested value with its reason; apply one value, or all of them. */
function AiSet({ c, params, draft, canEdit, onApply }: { c: MlCandidate; params: MlParam[]; draft: Record<string, string>; canEdit: boolean;
  onApply: (values: Record<string, MlVal>, label: string) => void }) {
  const [all, setAll] = useState(false);
  const values = c.values ?? Object.fromEntries(params.map((x) => [x.key, x.key in c.params ? c.params[x.key] : x.default]));
  const rows = params.filter((x) => x.key in values && x.key !== "random_state");
  const now = (x: MlParam) => val(x, draft[x.key] ?? "") ?? x.default;
  const differs = rows.filter((x) => values[x.key] !== now(x));
  const shown = all ? rows : differs;
  return (
    <div className="flex flex-col rounded-xl border bg-card">
      <div className="border-b px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[13.5px] font-semibold">
              {c.name}
              <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">{c.source === "ai" ? "AI" : "Proven"}</span>
            </div>
            <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{c.why}</p>
          </div>
          {canEdit && (
            <Button size="sm" className="h-8 shrink-0" disabled={!differs.length} onClick={() => onApply(values, `"${c.name}"`)}>
              <Zap className="h-3.5 w-3.5" /> Apply all
            </Button>
          )}
        </div>
        <div className="mt-1.5 text-[11.5px] text-muted-foreground">
          {differs.length ? `${differs.length} of ${rows.length} values differ from Model Settings` : "Model Settings already have all these values"}
        </div>
      </div>
      <ul className="max-h-[300px] flex-1 divide-y overflow-y-auto">
        {shown.map((x) => {
          const same = values[x.key] === now(x);
          return (
            <li key={x.key} className="flex items-center gap-2 px-4 py-2 text-[12.5px]">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{x.label}</div>
                {c.reasons?.[x.key] && <div className="truncate text-[11px] text-muted-foreground" title={c.reasons[x.key]}>{c.reasons[x.key]}</div>}
              </div>
              <span className="shrink-0 tabular-nums text-muted-foreground">{show(now(x))}</span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className={cn("w-[64px] shrink-0 text-right font-semibold tabular-nums", same ? "text-muted-foreground" : "text-primary")}>{show(values[x.key])}</span>
              {canEdit && (
                same ? <Check className="h-4 w-4 shrink-0 text-good" aria-label="Already set" /> : (
                  <button type="button" onClick={() => onApply({ [x.key]: values[x.key] }, x.label)} className="shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold text-primary hover:bg-primary/10">Apply</button>
                )
              )}
            </li>
          );
        })}
        {!shown.length && <li className="px-4 py-3 text-[12px] text-muted-foreground">Nothing to apply.</li>}
      </ul>
      <button type="button" onClick={() => setAll(!all)} className="border-t px-4 py-2 text-left text-[12px] font-medium text-primary hover:bg-muted/40">
        {all ? "Show only the values that differ" : `Show all ${rows.length} values`}
      </button>
    </div>
  );
}

/** Expert: the search space. Which settings to explore, from and to, and how many trials. */
function SearchSpace({ d, space, setSpace, trials, setTrials, disabled }: { d: MlSettings; space: Space; setSpace: (s: Space) => void; trials: number;
  setTrials: (n: number) => void; disabled: boolean }) {
  const byKey = Object.fromEntries(d.params.map((x) => [x.key, x]));
  const on = d.searchable.filter((x) => space[x.key]?.on).length;
  return (
    <Soft className="mt-4 p-5">
      <CardTitle icon={Search}
        right={
          <label className="flex items-center gap-2 text-[12.5px]">
            <span className="text-muted-foreground">Trials</span>
            <select className="h-9 rounded-lg border border-input bg-card px-2 text-[13px] font-semibold" value={trials} disabled={disabled} onChange={(e) => setTrials(Number(e.target.value))}>
              {[2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        }>
        Search Space
      </CardTitle>
      <p className="mt-0.5 text-[12px] text-muted-foreground">
        Each chosen setting's range is cut into {trials} slices and every slice is tried once, so the trials cover the ranges evenly (a Latin hypercube). Settings you don't search keep their value from Model Settings. Your settings and the defaults are tested too.
      </p>
      <div className="mt-3 grid grid-cols-[28px_minmax(0,1.4fr)_100px_100px_70px_minmax(0,1fr)] items-center gap-x-3 border-b pb-2 text-[11.5px] font-semibold text-muted-foreground">
        <span /><span>Setting</span><span>From</span><span>To</span><span>Scale</span><span className="text-right">Now · allowed</span>
      </div>
      <div className="divide-y">
        {d.searchable.map((s) => {
          const x = byKey[s.key];
          const r = space[s.key];
          const lo = Number(r?.from), hi = Number(r?.to);
          const bad = r?.on && (Number.isNaN(lo) || Number.isNaN(hi) || lo >= hi || lo < x.min || hi > x.max);
          return (
            <div key={s.key} className={cn("grid grid-cols-[28px_minmax(0,1.4fr)_100px_100px_70px_minmax(0,1fr)] items-center gap-x-3 py-2 text-[13px]", !r?.on && "opacity-55")}>
              <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]" checked={!!r?.on} disabled={disabled} aria-label={`Search ${x.label}`}
                onChange={(e) => setSpace({ ...space, [s.key]: { ...r, on: e.target.checked } })} />
              <span className="flex min-w-0 items-center gap-1.5 font-medium"><span className="truncate">{x.label}</span><Help text={`${x.key}: ${x.help}`} /></span>
              {(["from", "to"] as const).map((k) => (
                <input key={k} inputMode="decimal" value={r?.[k] ?? ""} disabled={disabled || !r?.on} aria-label={`${x.label} ${k}`}
                  onChange={(e) => setSpace({ ...space, [s.key]: { ...r, [k]: e.target.value } })}
                  className={cn("h-9 w-full rounded-lg border bg-card px-2 text-center text-[13px] font-semibold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring", bad ? "border-destructive" : "border-input")} />
              ))}
              <span className="text-[11.5px] text-muted-foreground" title={s.scale === "log" ? "Trials spread evenly in ratio (e.g. 0.02, 0.04, 0.08)" : "Trials spread evenly"}>{s.scale === "log" ? "Ratio" : "Even"}</span>
              <span className="truncate text-right text-[11.5px] tabular-nums text-muted-foreground">{show(effective(x))} · {show(x.min)}–{show(x.max)}</span>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11.5px] text-muted-foreground">{on} setting{on === 1 ? "" : "s"} searched, {trials} trials, plus your settings and the defaults.</p>
    </Soft>
  );
}

function Steps({ state }: { state: ("todo" | "active" | "done")[] }) {
  const steps = [["Configure", "Set your goal and settings"], ["Tune", "Find the best parameters"], ["Results", "Compare and use the best model"]];
  return (
    <div className="surface grid grid-cols-1 overflow-hidden p-0 sm:grid-cols-3">
      {steps.map(([title, sub], i) => (
        <button key={title} type="button" onClick={() => i === 2 && document.getElementById("ml-results")?.scrollIntoView({ behavior: "smooth", block: "center" })}
          className={cn("relative flex items-center gap-3 px-5 py-3.5 text-left transition-colors", state[i] === "active" ? "bg-primary/[0.06]" : "hover:bg-muted/40", i === 2 ? "cursor-pointer" : "cursor-default")}>
          <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-full text-[14px] font-semibold",
            state[i] === "active" ? "bg-primary text-primary-foreground shadow-[0_4px_12px_-4px_hsl(var(--primary)/0.6)]" : state[i] === "done" ? "bg-good/15 text-good" : "bg-muted text-muted-foreground")}>
            {state[i] === "done" ? <Check className="h-4 w-4" /> : i + 1}
          </span>
          <span className="min-w-0">
            <span className={cn("block text-[14px] font-semibold", state[i] === "todo" && "text-muted-foreground")}>{title}</span>
            <span className="block truncate text-[12px] text-muted-foreground">{sub}</span>
          </span>
          {i < 2 && <ChevronRight className="absolute right-2 top-1/2 hidden h-5 w-5 -translate-y-1/2 text-border sm:block" />}
        </button>
      ))}
    </div>
  );
}

/** Every experiment with every number; any candidate can be loaded, used in this prediction's runs, or made the workspace default. */
function ExperimentLog({ d, params, busy, onLoad, onUse, onDefault }: { d: MlSettings; params: MlParam[]; busy: boolean;
  onLoad: (v: Record<string, MlVal>, name: string) => void; onUse: (v: Record<string, MlVal>, name: string) => void; onDefault: (v: Record<string, MlVal>, name: string) => void }) {
  const [open, setOpen] = useState<string | null>(d.history.find((h) => h.status === "done")?.id ?? null);
  const full = (c: MlExperiment["candidates"][number]) =>
    settingsOf(c.values ?? Object.fromEntries(params.map((x) => [x.key, x.key in c.params ? c.params[x.key] : x.default])), c.params ?? {});
  const csv = () => {
    const keys = params.map((x) => x.key);
    const head = ["experiment_at", "mode", "goal", "status", "candidate", "best", ...METRICS.map(([k]) => k), "predicted_enrolled", "actual_enrolled", "seconds", ...keys];
    const lines = [head.join(",")];
    for (const h of d.history)
      h.candidates.forEach((c, i) => {
        const v = full(c);
        lines.push([h.at, MODE_LABEL[h.mode] ?? h.mode, h.objective, h.status, JSON.stringify(c.name), i === h.best ? "yes" : "",
          ...METRICS.map(([k]) => c.metrics?.[k] ?? ""), c.predicted ?? "", c.actual ?? "", c.seconds ?? "", ...keys.map((k) => v[k] ?? "")].join(","));
      });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `experiments-${d.project.name.replace(/[^\w-]+/g, "_").slice(0, 40)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  if (!d.history.length) return null;
  return (
    <Soft className="mt-4 p-0">
      <div className="px-5 pt-5">
        <CardTitle icon={GitCompare} right={<Button size="sm" variant="outline" onClick={csv}><Download className="h-3.5 w-3.5" /> Download log (CSV)</Button>}>
          Experiment Log
        </CardTitle>
        <p className="mt-0.5 text-[12px] text-muted-foreground">Every tuning run with every number, scored on a past term whose outcomes are known. Use any candidate in this prediction's runs, or make it the default.</p>
      </div>
      <ul className="mt-3 divide-y border-t">
        {d.history.map((h) => {
          const isOpen = open === h.id;
          const best = h.best != null ? h.candidates[h.best] : null;
          return (
            <li key={h.id}>
              <button type="button" onClick={() => setOpen(isOpen ? null : h.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-left text-[12.5px] hover:bg-muted/30">
                <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", !isOpen && "-rotate-90")} />
                <span className="rounded bg-muted px-1.5 py-px text-[10.5px] font-semibold uppercase text-muted-foreground">{MODE_LABEL[h.mode] ?? h.mode}</span>
                <span className="font-medium">{fmtDate(h.at)}</span>
                <span className="text-muted-foreground">Goal: {SHORT[h.objective] ?? h.objective} · {h.candidates.length} candidates{h.seconds ? ` · ${Math.round(h.seconds)}s` : ""}{h.holdout?.target ? ` · on ${termName(h.holdout.target)}` : ""}</span>
                <span className="ml-auto text-muted-foreground">
                  {best?.metrics ? <>Best: <b className="font-semibold text-foreground">{best.name}</b> · {SHORT[h.objective]} {fmtM(h.objective, best.metrics[h.objective])}</>
                    : h.status === "running" ? "Running" : h.status === "cancelled" ? "Stopped" : h.status === "failed" ? "Didn't finish" : ""}
                </span>
              </button>
              {isOpen && (
                <div className="overflow-x-auto px-5 pb-4">
                  <table className="w-full min-w-[1040px] text-[12px]">
                    <thead className="text-left text-[11px] font-semibold text-muted-foreground">
                      <tr className="border-b">
                        <th className="py-2 pr-3">Candidate</th>
                        {METRICS.map(([k, label]) => <th key={k} className={cn("px-1.5 py-2 text-right", k === h.objective && "text-primary")}>{label}</th>)}
                        <th className="px-2 py-2 text-right">Enrolled vs actual</th>
                        <th className="px-2 py-2 text-right">Time</th>
                        <th className="py-2 pl-3 text-right">Use</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y tabular-nums">
                      {h.candidates.map((c, i) => {
                        const v = full(c);
                        const changes = Object.entries(c.params ?? {});
                        return (
                          <tr key={i} className={cn(i === h.best && "bg-good/[0.06]")}>
                            <td className="max-w-[240px] py-2 pr-3">
                              <div className="flex items-center gap-1.5 font-medium">{i === h.best && <Trophy className="h-3.5 w-3.5 shrink-0 text-amber-500" />}<span className="truncate">{c.name}</span></div>
                              <div className="truncate font-mono text-[10.5px] text-muted-foreground" title={changes.map(([k, x]) => `${k}=${show(x)}`).join(", ")}>
                                {changes.length ? changes.map(([k, x]) => `${k}=${show(x)}`).join(" · ") : "the defaults"}
                              </div>
                            </td>
                            {METRICS.map(([k]) => <td key={k} className={cn("px-1.5 py-2 text-right", k === h.objective && "font-semibold")}>{fmtM(k, c.metrics?.[k])}</td>)}
                            <td className="px-2 py-2 text-right">{c.predicted != null ? `${Math.round(c.predicted).toLocaleString()} / ${c.actual?.toLocaleString() ?? "–"}` : "–"}</td>
                            <td className="px-2 py-2 text-right">{c.seconds != null ? `${c.seconds}s` : "–"}</td>
                            <td className="py-2 pl-3">
                              <div className="flex justify-end gap-1">
                                <Button size="sm" variant="ghost" className="h-7 px-2 text-[11.5px]" disabled={busy || !d.can_edit} onClick={() => onLoad(v, c.name)} title="Put these values in Model Settings (not saved)">
                                  <Upload className="h-3 w-3" /> Load
                                </Button>
                                <Button size="sm" variant="ghost" className="h-7 px-2 text-[11.5px]" disabled={busy || !d.can_edit} onClick={() => onUse(v, c.name)} title="Save as this prediction's settings: its next forecast run uses them">
                                  <Play className="h-3 w-3" /> Use
                                </Button>
                                {d.can_default && (
                                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11.5px]" disabled={busy} onClick={() => onDefault(v, c.name)} title="Make these the workspace's default settings">
                                    <Star className="h-3 w-3" /> Default
                                  </Button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {h.error && <p className="mt-2 text-[12px] text-muted-foreground">{h.error}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Soft>
  );
}

function Access() {
  const [rows, setRows] = useState<MlMember[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => API.mlAccess().then(setRows).catch((e) => toast.error((e as Error).message)), []);
  useEffect(() => void load(), [load]);
  const flip = async (m: MlMember) => {
    setBusy(m.id);
    try {
      await API.mlSetAccess(m.id, !m.granted);
      toast.success(m.granted ? `${m.name || m.email} no longer has the ML workspace` : `${m.name || m.email} can now use the ML workspace`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Soft className="p-5">
      <CardTitle icon={Users}>Who can use the ML workspace</CardTitle>
      <p className="mt-1 text-[12.5px] text-muted-foreground">Admins and owners always can. Give it to anyone else in your institution here.</p>
      {!rows ? (
        <Loading text="Loading people…" />
      ) : (
        <ul className="mt-3 divide-y text-[13px]">
          {rows.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{m.name || m.email}</div>
                <div className="truncate text-[12px] text-muted-foreground">{m.email} · {m.role.replace("_", " ")}{m.granted && m.granted_by ? ` · given by ${m.granted_by}` : ""}</div>
              </div>
              {m.always ? (
                <span className="text-[12px] text-muted-foreground">Always, as {m.role}</span>
              ) : (
                <Button size="sm" variant={m.granted ? "outline" : "default"} disabled={busy === m.id} onClick={() => void flip(m)}>
                  {busy === m.id && <Loader2 className="animate-spin" />} {m.granted ? "Remove access" : "Give access"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Soft>
  );
}

function HelpPanel() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-9"><CircleHelp className="h-4 w-4" /> Help</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] space-y-3 p-4 text-[12.5px] leading-relaxed">
        <div>
          <div className="font-semibold">Tuning modes</div>
          <p className="text-muted-foreground"><b className="text-foreground">Smart (AI):</b> the AI proposes complete sets of settings, tests them, studies the scores and tests a refined round. <b className="text-foreground">Custom:</b> you set the values; they're tested against the defaults. <b className="text-foreground">Expert:</b> a search across ranges you choose, with trials spread evenly.</p>
        </div>
        <div>
          <div className="font-semibold">Goal</div>
          <p className="text-muted-foreground">What "best" means when settings are compared: ROC AUC (ranking who enrolls), PR AUC, F1, Brier score (trustworthy probabilities) or count error (the enrolled total).</p>
        </div>
        <div>
          <div className="font-semibold">Default, Modified, Unsaved</div>
          <p className="text-muted-foreground">
            <span className="rounded bg-muted px-1 text-[10.5px] font-semibold uppercase">Default</span> the workspace's default (or the research lab's).{" "}
            <span className="rounded bg-primary/10 px-1 text-[10.5px] font-semibold uppercase text-primary">Modified</span> saved on this prediction: its runs use it.{" "}
            <span className="rounded bg-amber-500/15 px-1 text-[10.5px] font-semibold uppercase text-amber-700">Unsaved</span> changed here, not saved yet. The mark on each slider is the default; ↶ puts a setting back.
          </p>
        </div>
        <div>
          <div className="font-semibold">Use in runs, Make default</div>
          <p className="text-muted-foreground"><b className="text-foreground">Use in runs</b> saves settings to this prediction; its next forecast uses them. <b className="text-foreground">Make default</b> (admins) makes them the default for every prediction in the workspace that has no changes of its own.</p>
        </div>
        <div>
          <div className="font-semibold">How tuning scores settings</div>
          <p className="text-muted-foreground">Each candidate learns from the terms before last year and forecasts last year, whose outcomes are known. Every number is kept in the Experiment Log. A tuning run uses one run of your plan and keeps going if you leave the page.</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function MlWorkspacePage() {
  const { me } = useSession();
  const p = useProject();
  const runner = useRunner();
  const nav = useNavigate();
  const [data, setData] = useState<MlSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<Mode>("smart");
  const [goal, setGoal] = useState<MlObjective>("roc_auc");
  const [busy, setBusy] = useState<string | null>(null);
  const [trials, setTrials] = useState(6);
  const [space, setSpace] = useState<Space>({});
  const [advanced, setAdvanced] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [tab, setTab] = useState<"performance" | "importance" | "compare">("performance");
  const pid = p?.id;
  const live = useTuning();
  const mine = live && live.projectId === pid ? live : null;

  const take = (d: MlSettings) => (setData(d), setDraft(fresh(d)));
  const load = useCallback(() => {
    if (!pid || !me?.ml) return;
    setError(null);
    API.mlSettings(pid).then((d) => {
      take(d);
      if (d.test?.config?.objective) setGoal(d.test.config.objective);
      setSpace(Object.fromEntries(d.searchable.map((s) => [s.key, { on: SEARCH_ON.includes(s.key), from: String(s.from), to: String(s.to) }])));
    }, (e) => setError((e as Error).message));
  }, [pid, me?.ml]);
  useEffect(load, [load]);
  // a tuning run still going on the server (started here or anywhere else): follow it
  useEffect(() => {
    const t = data?.test;
    if (data && t && (t.status === "running" || t.status === "stopping"))
      tuning.follow(data.project.id, data.project.name, t.progress ? { pct: t.progress.pct, label: t.progress.label, detail: t.progress.detail } : undefined);
  }, [data]);
  // it finished (while this page was open or not): show its results, keeping any values being edited
  useEffect(() => {
    if (mine?.view && !mine.seen) {
      setData(mine.view);
      tuning.seen(mine.projectId);
    }
  }, [mine?.view, mine?.seen, mine?.projectId]);
  useEffect(() => {
    if (!confirmReset) return;
    const t = setTimeout(() => setConfirmReset(false), 4000);
    return () => clearTimeout(t);
  }, [confirmReset]);
  useEffect(() => setAdvanced((a) => a || mode === "expert"), [mode]);
  const byKey = useMemo(() => Object.fromEntries((data?.params ?? []).map((x) => [x.key, x])), [data]);

  if (!me?.ml) return <Page title="ML workspace" description="Ask an admin or owner of your institution to give you access to the ML workspace.">{null}</Page>;
  if (error) return <Failed error={error} retry={load} />;
  if (!p || !data || data.project.id !== p.id) return <Loading text="Loading the ML workspace…" />;

  const params = data.params;
  const invalid = params.some((x) => problem(x, draft[x.key] ?? ""));
  const states = Object.fromEntries(params.map((x) => [x.key, stateOf(x, draft[x.key] ?? "")])) as Record<string, State>;
  const unsaved = params.filter((x) => states[x.key] === "unsaved");
  const modified = params.filter((x) => (val(x, draft[x.key] ?? "") ?? x.default) !== x.default);
  const dirty = unsaved.length > 0;
  const custom = params.filter((x) => x.saved != null);
  const editable = data.can_edit && !busy;
  const draftParams = Object.fromEntries(params.map((x) => [x.key, val(x, draft[x.key] ?? "") ?? x.default])) as Record<string, MlVal>;
  const sugg = data.suggestions;
  const lastDone = data.history.find((h) => h.status === "done" && h.candidates.some((c) => c.seconds));
  const timed = lastDone ? lastDone.candidates.filter((c) => c.seconds) : [];
  const measured = timed.length ? timed.reduce((a, c) => a + (c.seconds ?? 0), 0) / timed.length : null;
  const per = Math.max(10, measured ?? data.forecast?.seconds ?? 45);
  const spaceOut = Object.fromEntries(Object.entries(space).filter(([, r]) => r.on).map(([k, r]) => [k, [Number(r.from), Number(r.to)] as [number, number]]));
  const spaceBad = mode === "expert" && (!Object.keys(spaceOut).length || Object.entries(spaceOut).some(([k, [lo, hi]]) => Number.isNaN(lo) || Number.isNaN(hi) || lo >= hi || lo < byKey[k].min || hi > byKey[k].max));
  const count = mode === "smart" ? (sugg ? sugg.candidates.length : 3) + 1 + (custom.length ? 1 : 0) + 2 : mode === "custom" ? (modified.length ? 2 : 1) : (modified.length ? 2 : 1) + trials;
  const v = (k: string) => show(val(byKey[k], draft[k] ?? "") ?? byKey[k]?.default ?? null);
  const advChanged = ADVANCED.flatMap(([, keys]) => keys).filter((k) => byKey[k] && states[k] !== "default").length;
  const ws = data.workspace_default;

  const act = async (key: string, fn: () => Promise<MlSettings>, ok: string, keepDraft = false) => {
    setBusy(key);
    try {
      const d = await fn();
      if (keepDraft) setData(d);
      else take(d);
      toast.success(ok);
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const edit = (k: string, nv: string) => {
    setDraft((d) => ({ ...d, [k]: nv }));
    if (mode === "smart") setMode("custom");
  };
  /** Put values into Model Settings (unsaved): only the ones given, the rest stay as they are. */
  const put = (values: Record<string, MlVal>) =>
    setDraft((d) => ({ ...d, ...Object.fromEntries(Object.entries(values).filter(([k]) => byKey[k]).map(([k, x]) => [k, x == null ? "" : String(x)])) }));
  /** Every value at once (any not given at its default). */
  const loadAll = (values: Record<string, MlVal>) => setDraft(Object.fromEntries(params.map((x) => {
    const nv = x.key in values ? values[x.key] : x.default;
    return [x.key, nv == null ? "" : String(nv)];
  })));
  const useInRuns = (values = draftParams, name?: string) =>
    act("save", () => API.mlSave(data.project.id, values, name), name ? `"${name}" saved. This prediction's next forecast run uses these settings.` : "Saved. This prediction's next forecast run uses these settings.");
  const makeDefault = (values = draftParams, name?: string) =>
    act("default", () => API.mlMakeDefault(data.project.id, values, name), `${name ? `"${name}"` : "These settings"} are now the workspace default.`);
  const resetDefaults = () => {
    if (!custom.length) return loadAll({}); // nothing saved: just put every box back to the default
    if (!confirmReset) return setConfirmReset(true);
    setConfirmReset(false);
    void act("reset", () => API.mlReset(data.project.id), "Back to the defaults");
  };
  /** Starts tuning on the server. It keeps going on any page, and after this one is closed, until it finishes or Stop is pressed. */
  const runTuning = async () => {
    setBusy("start");
    try {
      if (mode === "smart" && !sugg) {
        toast("Asking the AI for recommendations first…");
        setData(await API.mlRecommend(data.project.id));
      }
      const out = await API.mlTune(data.project.id, {
        mode: SERVER_MODE[mode], objective: goal, ...(mode !== "smart" && { params: draftParams }), ...(mode === "expert" && { trials, space: spaceOut }),
      });
      setData(out);
      tuning.follow(out.project.id, out.project.name, { pct: 0, label: "Starting", detail: "" });
      toast.success("Tuning started. It keeps running if you leave this page.");
    } catch (e) {
      toast.error((e as Error).message);
      load();
    } finally {
      setBusy(null);
    }
  };
  const stopTuning = async () => {
    setBusy("stop");
    try {
      setData(await API.mlTuneCancel(data.project.id));
      tuning.stopping(data.project.id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const share = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/ml`);
      toast.success("Link copied. Colleagues with ML workspace access can open it.");
    } catch {
      toast.error("The link couldn't be copied.");
    }
  };
  const t = data.test;
  const running = mine ? mine.status === "running" || mine.status === "stopping" : t?.status === "running" || t?.status === "stopping";
  const stopping = mine?.status === "stopping" || t?.status === "stopping";
  const step = mine?.step ?? (t?.progress ? { pct: t.progress.pct, label: t.progress.label, detail: t.progress.detail } : undefined);
  const won = t?.status === "done" && t.best != null ? t.candidates[t.best] : null;
  const wonRaw = won ? (t!.results?.[t!.best!]?.values ?? won.values ?? null) : null;
  const wonValues = won && wonRaw ? settingsOf(wonRaw, won.params) : null;
  const inUse = !!won && params.every((x) => ((wonValues?.[x.key] ?? won.params[x.key] ?? x.default) as MlVal) === effective(x));
  const stepState: ("todo" | "active" | "done")[] = running ? ["done", "active", "todo"] : won ? ["done", "done", "active"] : ["active", "todo", "todo"];
  const canRun = data.can_tune && !busy && !(mode !== "smart" && invalid) && !spaceBad;

  const runButton = (big?: boolean) =>
    running ? (
      <Button size={big ? "lg" : "default"} variant="outline" className={cn(big && "h-12 rounded-xl px-6 text-[15px]")} disabled={busy === "stop" || stopping || !data.can_tune} onClick={() => void stopTuning()}>
        {busy === "stop" || stopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />} {stopping ? "Stopping…" : "Stop Tuning"}
      </Button>
    ) : (
      <Button size={big ? "lg" : "default"} className={cn(big && "h-12 rounded-xl px-7 text-[15px] shadow-[0_8px_20px_-8px_hsl(var(--primary)/0.7)]")} disabled={!canRun} onClick={() => void runTuning()}>
        {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />} {mode === "smart" ? "Run AI Tuning" : mode === "expert" ? "Run Search" : "Run Tuning"}
      </Button>
    );
  const defaultButton = (values?: Record<string, MlVal>, name?: string, small?: boolean) =>
    data.can_default && (
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size={small ? "sm" : "default"} disabled={!!busy || (!values && invalid)}>
            {busy === "default" ? <Loader2 className="animate-spin" /> : <Star className="h-4 w-4" />} Make default
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[320px] p-4 text-[12.5px]">
          <div className="font-semibold">Make {name ? `"${name}"` : "these settings"} the workspace default?</div>
          <p className="mt-1 text-muted-foreground">Every prediction in your workspace without its own changes runs with them from its next forecast, and Reset to Defaults comes back to them. You can restore the lab defaults any time.</p>
          <Button size="sm" className="mt-3" onClick={() => void makeDefault(values, name)}><Star className="h-3.5 w-3.5" /> Make default</Button>
        </PopoverContent>
      </Popover>
    );

  return (
    <Page
      wide
      mode="top"
      title={
        <span className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-primary to-[hsl(var(--c-scenarios))] text-white shadow-[0_6px_16px_-6px_hsl(var(--primary)/0.7)]">
            <BarChart3 className="h-5 w-5" />
          </span>
          XGBoost Fine-Tuner
        </span>
      }
      description="Tune the model behind your forecast, test settings on known outcomes, and use the best in your runs."
      actions={
        <>
          <HelpPanel />
          <Button variant="ghost" size="sm" className="h-9" onClick={() => void share()}><Share2 className="h-4 w-4" /> Share</Button>
          {data.can_edit && (
            <Button variant="outline" disabled={!dirty || invalid || !!busy} onClick={() => void useInRuns()} title="Save to this prediction: its next forecast run uses these settings">
              {busy === "save" ? <Loader2 className="animate-spin" /> : <Save className="h-4 w-4" />} Use in runs
            </Button>
          )}
          {defaultButton()}
          {runButton()}
        </>
      }
    >
      <Steps state={stepState} />

      {/* goal and tuning mode */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Soft className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"><Target className="h-5 w-5" /></span>
            <span className="text-[15px] font-semibold">What's your goal?</span>
            <Select value={goal} onValueChange={(x) => setGoal(x as MlObjective)} disabled={running}>
              <SelectTrigger className="h-10 min-w-[240px] flex-1"><SelectValue /></SelectTrigger>
              <SelectContent>{data.objectives.map((o) => <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <p className="truncate pl-[52px] pt-1.5 text-[12px] text-muted-foreground" title={data.project.name}>
            The best candidate is picked by this. Tuning <b className="font-medium text-foreground">{data.project.name}</b>.
          </p>
        </Soft>
        <Soft className="p-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-2 pl-1 text-[15px] font-semibold"><Zap className="h-[18px] w-[18px] text-primary" /> Tuning mode</span>
            <div className="grid flex-1 grid-cols-3 gap-1 rounded-xl bg-muted/60 p-1" role="tablist" aria-label="Tuning mode">
              {MODES.map((m) => (
                <button key={m.k} role="tab" aria-selected={mode === m.k} onClick={() => setMode(m.k)} disabled={running}
                  className={cn("flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-2 text-[13px] font-semibold transition-all disabled:opacity-60",
                    mode === m.k ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-card hover:text-foreground")}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <p className="px-1 pt-2 text-[12px] leading-snug text-muted-foreground">{MODES.find((m) => m.k === mode)!.text}</p>
        </Soft>
      </div>

      {/* Smart: the AI's complete sets of settings */}
      {mode === "smart" && (
        <Soft className="mt-4 p-5">
          <CardTitle icon={Sparkles}
            right={data.can_edit && (
              <Button size="sm" variant={sugg ? "outline" : "default"} disabled={!!busy || running} onClick={() => void act("recommend", () => API.mlRecommend(data.project.id), "New AI recommendations ready", true)}>
                {busy === "recommend" ? <Loader2 className="animate-spin" /> : <Sparkles className="h-4 w-4" />} {sugg ? "Ask again" : "Get AI recommendations"}
              </Button>
            )}>
            AI Recommendations
          </CardTitle>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Complete sets of settings from this data, its latest results and every setting's range, with a reason for each value{sugg ? `, suggested ${fmtDate(sugg.at)}` : ""}. Apply values one by one or all at once, then Use in runs; or Run AI Tuning to test them and a refined round. Each request uses one AI question of your plan.
          </p>
          {sugg ? (
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              {sugg.candidates.map((c, i) => (
                <AiSet key={i} c={c} params={params} draft={draft} canEdit={data.can_edit && !busy}
                  onApply={(values, label) => {
                    put(values);
                    toast.success(`Applied ${Object.keys(values).length === 1 ? label : `${label}: ${Object.keys(values).length} values`} to Model Settings. Use in runs to keep them.`);
                  }} />
              ))}
            </div>
          ) : (
            <div className="mt-3 rounded-xl border border-dashed p-6 text-center text-[13px] text-muted-foreground">
              Get AI recommendations to see them here, or press Run AI Tuning: it asks the AI first, tests its sets against the defaults, then tests a refined round.
            </div>
          )}
        </Soft>
      )}

      {mode === "expert" && <SearchSpace d={data} space={space} setSpace={setSpace} trials={trials} setTrials={setTrials} disabled={!!busy || running} />}

      {/* Model Settings and Latest Results */}
      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Soft className="min-w-0 p-5">
          <CardTitle icon={SlidersHorizontal}
            right={data.can_edit && (
              <button type="button" disabled={!!busy || (!custom.length && !modified.length)} onClick={resetDefaults}
                className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-primary hover:underline disabled:pointer-events-none disabled:opacity-40">
                {busy === "reset" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} {confirmReset ? "Click again to reset" : "Reset to Defaults"}
              </button>
            )}>
            Model Settings
          </CardTitle>
          <p className="mt-0.5 text-[12px] text-muted-foreground">What this prediction's forecast runs use. Changes stay unsaved until Use in runs.</p>
          {ws && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-primary/[0.05] px-3 py-2 text-[12px]">
              <Star className="h-3.5 w-3.5 text-primary" />
              <span>Defaults here are your workspace's{ws.by ? `, set by ${ws.by}` : ""}{ws.at ? ` on ${fmtDate(ws.at)}` : ""} ({Object.keys(ws.params).length} change{Object.keys(ws.params).length === 1 ? "" : "s"} from the lab's).</span>
              {data.can_default && (
                <button type="button" disabled={!!busy} onClick={() => void act("default", () => API.mlClearDefault(data.project.id), "The workspace is back to the lab defaults")}
                  className="ml-auto font-semibold text-primary hover:underline">Restore lab defaults</button>
              )}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
            {(["default", "modified", "unsaved"] as State[]).map((s) => <span key={s} className={cn("rounded px-1.5 py-px text-[10px] font-semibold uppercase", BADGE[s])}>{BADGE_TEXT[s]}</span>)}
            <span className="ml-auto">
              {modified.length ? <b className="font-semibold text-primary">{modified.length} changed from default</b> : "All at their defaults"}
              {unsaved.length > 0 && <> · <b className="font-semibold text-amber-700 dark:text-amber-400">{unsaved.length} unsaved</b> <button className="ml-1 font-medium text-foreground underline-offset-2 hover:underline" onClick={() => setDraft(fresh(data))}>Discard</button></>}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)_112px_70px] gap-x-3 border-b pb-2 pl-3 text-[11.5px] font-semibold text-muted-foreground">
            <span>Parameter</span><span className="col-span-2">Value</span><span className="text-right">Range</span>
          </div>
          <div className="divide-y">
            {MAIN.map((k) => byKey[k] && <Setting key={k} x={byKey[k]} raw={draft[k] ?? ""} disabled={!editable} onChange={(nv) => edit(k, nv)} />)}
          </div>
          <button onClick={() => setAdvanced(!advanced)} className="mt-3 flex w-full items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left" aria-expanded={advanced}>
            <Layers className="h-[18px] w-[18px] text-primary" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-[14px] font-semibold">
                Advanced Options
                {advChanged > 0 && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">{advChanged} changed</span>}
              </span>
              <span className="block text-[12px] text-muted-foreground">Sampling, columns, regularization, class balance, cross-validation, and more</span>
            </span>
            <ChevronDown className={cn("h-5 w-5 text-muted-foreground transition-transform", advanced && "rotate-180")} />
          </button>
          {advanced && (
            <div className="grid gap-x-6 lg:grid-cols-3">
              {ADVANCED.map(([g, keys]) => (
                <div key={g} className="min-w-0">
                  <div className="pt-3 text-[12.5px] font-semibold">{g}</div>
                  <div className="mt-1 divide-y">
                    {keys.map((k) => byKey[k] && <Setting key={k} x={byKey[k]} raw={draft[k] ?? ""} disabled={!editable} onChange={(nv) => edit(k, nv)} stack />)}
                  </div>
                </div>
              ))}
            </div>
          )}
          {!data.can_edit && <p className="mt-3 text-[12px] text-muted-foreground">Only the person who made this prediction, or an admin, can change its settings.</p>}
        </Soft>

        <Results d={data} tab={tab} setTab={setTab} />
      </div>

      {/* the Run Tuning bar */}
      <Soft className="mt-4 p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          {runButton(true)}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-card px-4 py-2.5 text-[12.5px]">
            {([[FlaskConical, v("n_estimators"), "Trees"], [Repeat, v("max_depth"), "Max Depth"], [Layers, `${v("folds")}-Fold`, "Cross-Validation"],
              [GitCompare, String(count), "Candidates"], [Clock, `~${Math.max(1, Math.round((count * per) / 60))} min`, measured ? "Estimated (measured)" : "Estimated Time"],
              [Target, SHORT[goal], "Goal"]] as const).map(([Icon, value, label]) => (
              <div key={label} className="flex items-center gap-2">
                <Icon className="h-5 w-5 text-muted-foreground" />
                <div><div className="text-[14px] font-semibold tabular-nums leading-tight">{value}</div><div className="text-muted-foreground">{label}</div></div>
              </div>
            ))}
          </div>
          <div className={cn("flex min-w-0 flex-1 basis-[440px] flex-wrap items-center gap-3 rounded-xl border px-4 py-3",
            running ? "border-primary/25 bg-primary/[0.05]" : won ? "border-good/25 bg-good/[0.07]" : "bg-muted/40")}>
            {running ? <Loader2 className="h-6 w-6 shrink-0 animate-spin text-primary" /> : won ? <CheckCircle2 className="h-6 w-6 shrink-0 text-good" /> : <FlaskConical className="h-6 w-6 shrink-0 text-muted-foreground" />}
            <div className="min-w-0 flex-1 text-[12.5px]">
              {running ? (
                <>
                  <div className="text-[13.5px] font-semibold">{stopping ? "Stopping…" : `Tuning… ${Math.round(step?.pct ?? 0)}%`}</div>
                  <div className="truncate text-muted-foreground">{step?.label ?? "Starting"}{step?.detail ? ` · ${step.detail}` : ""}</div>
                </>
              ) : won ? (
                <>
                  <div className="text-[13.5px] font-semibold">Best Parameters Found</div>
                  <div className="truncate text-muted-foreground">{won.name}{inUse ? ": already in use." : "."} {t?.config?.note ?? ""}</div>
                </>
              ) : (
                <>
                  <div className="text-[13.5px] font-semibold">{t && t.status !== "done" ? (t.status === "cancelled" ? "Last tuning run was stopped" : "Last tuning run didn't finish") : "No tuning run yet"}</div>
                  <div className="truncate text-muted-foreground" title={t?.error ?? undefined}>{t?.status === "failed" && t.error ? t.error : "Run Tuning to find the best parameters."}</div>
                </>
              )}
            </div>
            {won && !running && (
              <div className="flex shrink-0 flex-wrap gap-1.5">
                {data.can_edit && !inUse && wonValues && (
                  <Button size="sm" disabled={!!busy} onClick={() => void useInRuns(wonValues, won.name).then((ok) => ok && loadAll(wonValues))}><Play className="h-3.5 w-3.5" /> Use in runs</Button>
                )}
                {wonValues && defaultButton(wonValues, won.name, true)}
                <Button size="sm" variant="outline" onClick={() => (setTab("compare"), document.getElementById("ml-results")?.scrollIntoView({ behavior: "smooth", block: "center" }))}>Compare</Button>
                {can(me, "analyst") && inUse && (
                  <Button size="sm" variant="outline" disabled={runner.running || !!busy} onClick={() => (void runNow(), nav("/train/run"))}><Play className="h-3.5 w-3.5" /> Run forecast</Button>
                )}
              </div>
            )}
          </div>
        </div>
        {running && (
          <div className="mt-4">
            <ProgressBar step={step} />
            <p className="mt-2 text-[12px] text-muted-foreground">Tuning runs on YieldPilot's server: leave this page or keep working, its progress follows you in the header and you'll be told when it's done. Only Stop Tuning ends it early.</p>
          </div>
        )}
        <p className="mt-3 text-[11.5px] text-muted-foreground">
          Each candidate learns from the terms before last year and is validated on last year, whose outcomes are known. A tuning run uses one run of your plan; Smart tuning also uses one AI question for its refined round.
        </p>
      </Soft>

      <ExperimentLog d={data} params={params} busy={!!busy}
        onLoad={(vals, name) => (loadAll(vals), toast.success(`Loaded "${name}" into Model Settings (not saved yet).`))}
        onUse={(vals, name) => void useInRuns(vals, name).then((ok) => ok && loadAll(vals))}
        onDefault={(vals, name) => void makeDefault(vals, name)} />

      {can(me, "admin") && <div className="mt-4"><Access /></div>}
    </Page>
  );
}
