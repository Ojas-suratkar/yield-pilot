import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, ErrorBar, LabelList, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowDown, ArrowUp, BadgeCheck, ChevronLeft, ChevronRight, History, Loader2, MessageCircle, Percent, Play, RefreshCw, Search, Square, Target, UserCheck, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { cn, fmtDateTime } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Input } from "@yield/core/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@yield/core/ui/dialog";
import { Loading, NeedsData, NextBar, Page, ProgressBar, Ring, Soft, SortTh, TableSearch, useTable, type SortState } from "../../components/ui";
import { DownloadMenu, groupName, ShareButton, YieldChat } from "../../components/ReportTools";
import { API, type Breakdown, type Student } from "../../lib/api";
import { fetchQuery } from "../../lib/query";
import { can, useSession } from "../../lib/auth";
import { friendly, termList, termName } from "../../lib/labels";
import { cancelRun, projectStore, useProject, useRunner, type Project } from "../../lib/project";

const pct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;
const int = (n: number) => Math.round(n).toLocaleString();
const pp = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n * 100).toFixed(1)} pp`;
const tip = { borderRadius: 10, border: "1px solid hsl(var(--border))", background: "hsl(var(--popover))", fontSize: 12, padding: "8px 12px", boxShadow: "0 8px 24px -12px rgb(0 0 0 / 0.25)" };
const axis = { tickLine: false, axisLine: false, fontSize: 11.5, stroke: "hsl(var(--muted-foreground))" } as const;

export const SEGMENTS = {
  high: { label: "High", long: "High likelihood", rule: "≥ 70%", tone: "text-good", bg: "bg-good/10", bar: "hsl(var(--good))" },
  medium: { label: "Medium", long: "Medium likelihood", rule: "40–69%", tone: "text-warn", bg: "bg-warn/10", bar: "hsl(var(--warn))" },
  low: { label: "Low", long: "Low likelihood", rule: "< 40%", tone: "text-destructive", bg: "bg-destructive/10", bar: "hsl(var(--destructive))" },
} as const;
type Seg = keyof typeof SEGMENTS;

function useForecast() {
  const p = useProject();
  const r = useRunner();
  useEffect(() => {
    if (p?.forecast && !p.results_seen && !p.stale) void projectStore.patch({ results_seen: true }).catch(() => undefined);
  }, [p]);
  // runs start only from the Run button (Train & Predict); this page shows the latest forecast and any run in progress
  const runner = { ...r, running: r.running && r.project === p?.id };
  return { p, runner, ready: !!p?.forecast };
}

/** Shown when there is no forecast yet: the run in progress, or the way to start one. */
function Building({ p, runner }: { p?: Project; runner: ReturnType<typeof useRunner> }) {
  if (p && !p.dataset) return <NeedsData />;
  if (!runner.running)
    return (
      <Soft className="mx-auto mt-16 max-w-md text-center">
        <div className="text-[15px] font-semibold">No forecast yet</div>
        <p className="mt-1 text-sm text-muted-foreground">{runner.error || "Run the prediction to see projected enrollment."}</p>
        <Button asChild size="sm" className="mt-4 rounded-full">
          <Link to="/train/run">
            <Play /> Go to Run prediction
          </Link>
        </Button>
      </Soft>
    );
  return (
    <div className="flex h-full items-center justify-center">
      <div className="surface w-full max-w-md p-6">
        <div className="text-[15px] font-semibold">Building your yield forecast</div>
        <p className="mt-1 text-[13px] text-muted-foreground">Learning from how past admits decided.</p>
        <ProgressBar className="mt-5" step={runner.step} />
        <Button variant="outline" size="sm" className="mt-4 rounded-full" onClick={cancelRun}>
          <Square className="h-3.5 w-3.5" /> Cancel
        </Button>
      </div>
    </div>
  );
}

/** While a new forecast runs (or after settings changed), the earlier one stays visible under this note. */
function Updating({ p, runner }: { p: Project; runner: ReturnType<typeof useRunner> }) {
  if (!runner.running && !runner.error && !p.stale) return null;
  const pct = Math.round(runner.step?.pct ?? 0);
  return (
    <div
      className={cn(
        "mb-4 flex items-center gap-2.5 rounded-xl border px-4 py-2.5 text-[13px]",
        runner.error && !runner.running ? "border-destructive/30 bg-destructive/5" : "border-primary/20 bg-secondary",
      )}
    >
      {runner.running ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <RefreshCw className="h-4 w-4 text-primary" />}
      {runner.running ? (
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <span>Updating with your latest settings: {runner.step?.label.toLowerCase() || "starting"}. The results below are from the previous run.</span>
          <span className="flex min-w-[160px] flex-1 items-center gap-2">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-primary/10">
              <span className="block h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${pct}%` }} />
            </span>
            <span className="w-9 text-right font-semibold tabular-nums">{pct}%</span>
          </span>
        </span>
      ) : (
        <span className="flex-1">
          {runner.error ? `The last run didn't finish: ${runner.error} Showing the previous results.` : "Your settings changed since this forecast. Run the prediction again to update it."}
        </span>
      )}
      {runner.running ? (
        <Button size="sm" variant="outline" className="h-8 rounded-full" onClick={cancelRun}>
          <Square className="h-3.5 w-3.5" /> Cancel
        </Button>
      ) : (
        <Button asChild size="sm" variant="outline" className="h-8 rounded-full">
          <Link to="/train/run">Go to Run prediction</Link>
        </Button>
      )}
    </div>
  );
}

const Actions = ({ p, children }: { p: Project; children?: React.ReactNode }) => (
  <>
    {children}
    <DownloadMenu p={p} />
    <ShareButton p={p} />
  </>
);

/* --------------------------------------------------------------- dashboard */

const CHARTS = {
  trend: { title: "Yield trend", q: "Explain the yield trend chart" },
  college: { title: "Yield by college", q: "Explain yield by college" },
  dist: { title: "How likely admits are to enroll", q: "Explain the probability distribution" },
  drivers: { title: "What influences enrollment most", q: "Explain the top drivers" },
  segments: { title: "Admits by likelihood", q: "Explain admits by likelihood" },
  major: { title: "Outlook by group", q: "Explain yield by major" },
  changes: { title: "Where yield is moving", q: "Explain where yield is changing" },
} as const;
type ChartKey = keyof typeof CHARTS;

const ACTION = {
  high: "Confirm: deposit and orientation reminders",
  medium: "Prioritize: counselor calls, aid follow-up, visit invites",
  low: "Monitor: targeted messaging, review aid gaps",
};

function Card({ k, sub, onExplain, className, children }: { k: ChartKey; sub?: string; onExplain: (k: ChartKey) => void; className?: string; children: React.ReactNode }) {
  return (
    <section className={cn("surface flex flex-col p-5", className)}>
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14.5px] font-semibold tracking-[-0.01em]">{CHARTS[k].title}</h2>
          {sub && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{sub}</p>}
        </div>
        <button
          onClick={() => onExplain(k)}
          className="flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] font-medium text-primary transition-colors hover:bg-primary/[0.06]"
        >
          <MessageCircle className="h-3.5 w-3.5" /> Explain
        </button>
      </header>
      <div className="mt-4 min-h-0 flex-1">{children}</div>
    </section>
  );
}

function Kpi({ label, value, note, delta, icon: Icon, color }: { label: string; value: string; note: string; delta?: { text: string; good: boolean }; icon: typeof Users; color: string }) {
  return (
    <div className="surface relative overflow-hidden px-5 py-4">
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: `hsl(var(${color}))` }} />
      <div className="flex items-center gap-2 whitespace-nowrap text-[12.5px] font-medium text-muted-foreground">
        <span className="grid h-6 w-6 place-items-center rounded-md" style={{ background: `hsl(var(${color}) / 0.12)`, color: `hsl(var(${color}))` }}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-[28px] font-semibold leading-none tracking-[-0.03em] tabular-nums">{value}</span>
        {delta && (
          <span className={cn("inline-flex items-center gap-0.5 text-[12px] font-semibold", delta.good ? "text-good" : "text-destructive")}>
            {delta.good ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
            {delta.text}
          </span>
        )}
      </div>
      <div className="mt-1.5 truncate text-[12px] text-muted-foreground" title={note}>
        {note}
      </div>
    </div>
  );
}

function Delta({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted-foreground">–</span>;
  const up = v >= 0;
  return (
    <span className={cn("inline-flex items-center gap-0.5 font-medium", Math.abs(v) < 0.0005 ? "text-muted-foreground" : up ? "text-good" : "text-destructive")}>
      {Math.abs(v) >= 0.0005 && (up ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      {pp(v)}
    </span>
  );
}

const TH = "px-3 py-2.5 text-right text-[11.5px] font-semibold uppercase tracking-[0.04em] text-muted-foreground first:text-left";
const TD = "px-3 py-2.5 text-right tabular-nums first:text-left";

/** A breakdown table: admits, projected enrolled and yield per group, next to the prior comparable term. Sortable and filterable. */
function Outlook({ rows, label, total, priorTerm }: { rows: Breakdown[]; label: string; total: number; priorTerm?: string }) {
  const sum = rows.reduce((a, r) => ({ admits: a.admits + r.admits, expected: a.expected + r.expected }), { admits: 0, expected: 0 });
  const other = rows.filter((r) => r.value.startsWith("Other ("));
  const data = rows
    .filter((r) => !r.value.startsWith("Other ("))
    .map((r) => ({ ...r, change: r.prior_yield == null ? null : r.yield - r.prior_yield, share: r.expected / Math.max(1, total) }));
  const t = useTable(data, { key: "admits", desc: true }, (r) => r.value);
  const th = "py-2.5 text-right text-[11.5px] font-semibold uppercase tracking-[0.04em] text-muted-foreground first:text-left [&>button]:justify-end first:[&>button]:justify-start";
  return (
    <div className="overflow-x-auto">
      {data.length > 6 && <TableSearch value={t.q} onChange={t.setQ} placeholder={`Filter ${label.toLowerCase()}`} className="mb-2" />}
      <table className="w-full min-w-[640px] text-[13px]">
        <thead className="border-b">
          <tr>
            <SortTh label={label} k="value" sort={t.sort} onSort={t.setSort} className={cn(th, "px-3 text-left")} />
            <SortTh label="Admits" k="admits" sort={t.sort} onSort={t.setSort} className={cn(th, "px-3")} />
            <SortTh label="Proj. enrolled" k="expected" sort={t.sort} onSort={t.setSort} className={cn(th, "px-3")} />
            <SortTh label="Proj. yield" k="yield" sort={t.sort} onSort={t.setSort} className={cn(th, "px-3")} />
            <SortTh label={priorTerm ? `${termName(priorTerm)} yield` : "Prior yield"} k="prior_yield" sort={t.sort} onSort={t.setSort} className={cn(th, "px-3")} />
            <SortTh label="Change" k="change" sort={t.sort} onSort={t.setSort} className={cn(th, "px-3")} />
            <SortTh label="Share of class" k="share" sort={t.sort} onSort={t.setSort} className={cn(th, "px-3")} />
          </tr>
        </thead>
        <tbody className="divide-y">
          {[...t.shown, ...(t.q ? [] : other.map((r) => ({ ...r, change: null, share: r.expected / Math.max(1, total) })))].map((r) => (
            <tr key={r.value} className="transition-colors hover:bg-muted/40">
              <td className={cn(TD, "max-w-[280px] truncate font-medium")} title={r.value}>
                {r.value}
              </td>
              <td className={TD}>{int(r.admits)}</td>
              <td className={TD}>{int(r.expected)}</td>
              <td className={cn(TD, "font-semibold")}>{pct(r.yield)}</td>
              <td className={cn(TD, "text-muted-foreground")}>{r.prior_yield == null ? "–" : pct(r.prior_yield)}</td>
              <td className={TD}>
                <Delta v={r.change} />
              </td>
              <td className={TD}>
                <span className="inline-flex items-center justify-end gap-2">
                  <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:block">
                    <span className="block h-full rounded-full bg-[var(--series-teal)]" style={{ width: `${r.share * 100}%` }} />
                  </span>
                  {pct(r.share)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2">
          <tr className="font-semibold">
            <td className={TD}>Total</td>
            <td className={TD}>{int(sum.admits)}</td>
            <td className={TD}>{int(sum.expected)}</td>
            <td className={TD}>{pct(sum.expected / Math.max(1, sum.admits))}</td>
            <td className={TD} colSpan={3} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Official({ p }: { p: Project }) {
  const f = p.forecast!;
  const { me } = useSession();
  const [busy, setBusy] = useState(false);
  const pending = !!f.registry?.pending;
  // Vertex AI registers a model in a few minutes: check back until the version lands
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void API.registry(f.id).then((r) => (r && !r.pending ? projectStore.refresh() : undefined)), 15_000);
    return () => clearInterval(t);
  }, [pending, f.id]);
  if (f.is_production && pending)
    return (
      <span className="inline-flex h-9 items-center gap-1.5 rounded-full bg-good/10 px-3.5 text-[12.5px] font-semibold text-good">
        <Loader2 className="h-4 w-4 animate-spin" /> Official · registering in Vertex AI
      </span>
    );
  if (f.is_production)
    return f.registry && !f.registry.error ? (
      <a
        href={f.registry.console}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-9 items-center gap-1.5 rounded-full bg-good/10 px-3.5 text-[12.5px] font-semibold text-good hover:bg-good/15"
      >
        <BadgeCheck className="h-4 w-4" /> Official · Vertex AI v{f.registry.version ?? "…"}
      </a>
    ) : (
      <span className="inline-flex h-9 items-center gap-1.5 rounded-full bg-good/10 px-3.5 text-[12.5px] font-semibold text-good">
        <BadgeCheck className="h-4 w-4" /> Official
      </span>
    );
  if (!can(me, "data_manager")) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-9 rounded-full px-4"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await API.promote(f.id);
          if (r.error) toast.warning(r.error);
          else toast.success("Marked official. Registering the model in Vertex AI Model Registry (a few minutes).");
          await projectStore.refresh();
        } catch (e) {
          toast.error((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="animate-spin" /> : <BadgeCheck />} Mark official
    </Button>
  );
}

export function ForecastPage() {
  const { p, runner, ready } = useForecast();
  const [ai, setAi] = useState(false);
  const [ask, setAsk] = useState<{ q: string; n: number }>();
  const [dim, setDim] = useState(1);
  if (!p || !ready) return <Building p={p} runner={runner} />;
  const r = p.forecast!.summary;
  const prior = r.prior;
  const rel = (a: number, b: number) => ({ text: `${Math.abs(((a - b) / b) * 100).toFixed(1)}%`, good: a >= b });
  const explain = (k: ChartKey) => {
    setAi(true);
    setAsk((x) => ({ q: CHARTS[k].q, n: (x?.n ?? 0) + 1 }));
  };
  const yLo = r.range[0] / r.admits;
  const yHi = r.range[1] / r.admits;
  const trend = r.trend.map((t) => ({
    term: termName(t.term),
    actual: t.actual,
    projected: t.projected,
    err: t.actual === undefined && t.projected !== undefined ? [t.projected - yLo, yHi - t.projected] : undefined,
  }));
  const colleges = (r.breakdowns[0]?.field === r.college_field ? r.breakdowns[0].rows : []).filter((x) => !x.value.startsWith("Other"));
  const collegeChart = colleges.slice(0, 10).map((c) => ({ name: c.value, projected: c.yield, prior: c.prior_yield ?? undefined }));
  const others = r.breakdowns.filter((b) => b.field !== r.college_field);
  const group = others[Math.min(dim, others.length) - 1] ?? others[0];
  const drivers = r.drivers.slice(0, 8).map((d) => ({ name: friendly(d.feature), share: d.share, direction: d.direction }));
  const segs = (["high", "medium", "low"] as Seg[]).map((b) => ({ b, ...r.segments[b] }));
  // the largest gains and drops against last year, across every breakdown (college, major, residency…)
  const movers = (() => {
    const all = r.breakdowns.flatMap((b) =>
      b.rows
        .filter((x) => x.prior_yield != null && x.admits >= 50 && !x.value.startsWith("Other"))
        .map((x) => ({ name: x.value, pp: +((x.yield - x.prior_yield!) * 100).toFixed(1), now: x.yield, was: x.prior_yield!, admits: x.admits })),
    );
    const up = all.filter((x) => x.pp > 0).sort((a, b) => b.pp - a.pp).slice(0, 6);
    const down = all.filter((x) => x.pp < 0).sort((a, b) => a.pp - b.pp).slice(0, 6);
    return [...up, ...down.reverse()];
  })();

  return (
    <Page
      title={`${termName(r.target_term)} Yield Forecast`}
      description={
        <>
          {groupName(p)} admits · based on how {int(r.train_rows)} admits from {termList(r.train_terms)} decided
          {p.forecast?.run_by?.name ? ` · run by ${p.forecast.run_by.name} on ${fmtDateTime(p.forecast.created_at)}` : ""}

        </>
      }
      width="wide"
      mode="top"
      actions={
        <Actions p={p}>
          <Official p={p} />
          <Button variant={ai ? "secondary" : "outline"} size="sm" className="h-9 rounded-full px-4" onClick={() => setAi(!ai)}>
            <MessageCircle /> Ask a question
          </Button>
        </Actions>
      }
    >
      <Updating p={p} runner={runner} />
      <div className="flex gap-5">
        <div className="min-w-0 flex-1 space-y-5">
          {(() => {
            const lo = Math.min(r.range[0], prior?.enrolled ?? r.range[0]);
            const hi = Math.max(r.range[1], prior?.enrolled ?? r.range[1]);
            const pad = (hi - lo) * 0.15 || 1;
            const at = (x: number) => `${((x - (lo - pad)) / (hi - lo + 2 * pad)) * 100}%`;
            const d = prior ? rel(r.expected, prior.enrolled) : undefined;
            const dy = prior ? r.yield - prior.yield : undefined;
            const check = r.evaluation
              ? { value: `${Math.abs(r.evaluation.error_pct).toFixed(1)}% off`, note: `against ${termName(r.target_term)}'s actual outcomes` }
              : r.backtest
                ? { value: `${Math.abs(r.backtest.error_pct).toFixed(1)}% off`, note: `checked on ${termName(r.backtest.term)}, whose outcomes are known` }
                : { value: r.confidence, note: "How settled this term's admits look" };
            return (
              <>
                <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
                  <div className="surface relative overflow-hidden p-6">
                    <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: "linear-gradient(90deg, hsl(var(--primary)), hsl(var(--c-results)))" }} />
                    <div className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground"><UserCheck className="h-4 w-4" /> Expected to enroll</div>
                    <div className="mt-2 flex flex-wrap items-end gap-3">
                      <span className="text-[46px] font-semibold leading-none tracking-[-0.045em] tabular-nums">{int(r.expected)}</span>
                      {d && <span className={cn("mb-1.5 rounded-full px-2 py-0.5 text-[12px] font-semibold", d.good ? "bg-good/10 text-good" : "bg-destructive/10 text-destructive")}>{d.good ? "▲" : "▼"} {d.text} vs {termName(prior!.term)}</span>}
                      <span className="mb-1.5 text-[13px] text-muted-foreground">of {int(r.admits)} admits</span>
                    </div>
                    <div className="relative mt-5 h-8" aria-hidden>
                      <div className="absolute inset-x-0 top-3.5 h-1 rounded-full bg-muted" />
                      <div className="absolute top-2.5 h-3 rounded-full bg-primary/20" style={{ left: at(r.range[0]), width: `calc(${at(r.range[1])} - ${at(r.range[0])})` }} />
                      <div className="absolute top-1.5 h-5 w-1.5 -translate-x-1/2 rounded-full bg-primary" style={{ left: at(r.expected) }} />
                      {prior && <div className="absolute top-1 h-6 w-px -translate-x-1/2 bg-foreground/50" style={{ left: at(prior.enrolled) }} title={`${termName(prior.term)}: ${int(prior.enrolled)}`} />}
                    </div>
                    <p className="mt-1 text-[12.5px] text-muted-foreground">
                      Likely between <b className="font-semibold text-foreground">{int(r.range[0])}</b> and <b className="font-semibold text-foreground">{int(r.range[1])}</b> (90% range)
                      {prior ? ` · the line marks ${int(prior.enrolled)} enrolled in ${termName(prior.term)}` : ""}
                    </p>
                  </div>
                  <div className="surface relative overflow-hidden p-6">
                    <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: "hsl(var(--c-results))" }} />
                    <div className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground"><Percent className="h-4 w-4" /> Projected yield</div>
                    <div className="mt-2 flex flex-wrap items-end gap-3">
                      <span className="text-[46px] font-semibold leading-none tracking-[-0.045em] tabular-nums">{pct(r.yield)}</span>
                      {dy != null && <span className={cn("mb-1.5 rounded-full px-2 py-0.5 text-[12px] font-semibold", dy >= 0 ? "bg-good/10 text-good" : "bg-destructive/10 text-destructive")}>{dy >= 0 ? "▲" : "▼"} {Math.abs(dy * 100).toFixed(1)} points</span>}
                    </div>
                    <div className="mt-5 space-y-2 text-[12.5px]">
                      {[[termName(r.target_term), r.yield, "bg-primary"], ...(prior ? [[termName(prior.term), prior.yield, "bg-foreground/40"]] : [])].map(([k, y, c]) => (
                        <div key={k as string} className="grid grid-cols-[90px_1fr_52px] items-center gap-2">
                          <span className="truncate text-muted-foreground">{k as string}</span>
                          <div className="h-2 rounded-full bg-muted"><div className={cn("h-full rounded-full", c as string)} style={{ width: `${Math.min(100, (y as number) * 100 / Math.max(r.yield, prior?.yield ?? 0, 0.01) * 0.95)}%` }} /></div>
                          <span className="text-right tabular-nums">{pct(y as number)}</span>
                        </div>
                      ))}
                    </div>
                    <p className="mt-3 text-[12.5px] text-muted-foreground">Share of admits expected to enroll{prior ? `, against ${termName(prior.term)}'s actual` : ""}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
                  <Kpi icon={Users} color="--c-data" label="Admits" value={int(r.admits)}
                    note={`${r.applications > r.admits ? `${int(r.applications)} applications · ` : ""}${prior ? `${int(prior.admits)} in ${termName(prior.term)}` : "This term"}`}
                    delta={prior ? rel(r.admits, prior.admits) : undefined} />
                  <Kpi icon={History} color="--c-audit" label={prior ? `${termName(prior.term)} actual` : "Prior term"} value={prior ? int(prior.enrolled) : "–"}
                    note={prior ? `enrolled · ${pct(prior.yield)} yield` : "No comparable term in the data"} />
                  <Kpi icon={Target} color="--c-features" label="How accurate" value={check.value} note={check.note} />
                  <Kpi icon={UserCheck} color="--c-home" label={r.actual ? `${termName(r.target_term)} enrolled` : "Confidence"}
                    value={r.actual ? int(r.actual.enrolled) : r.confidence}
                    note={r.actual && r.evaluation ? `forecast ${int(r.evaluation.predicted_enrolled)} for the same admits` : r.actual ? "Recorded so far" : "How settled this term's admits look"} />
                </div>
              </>
            );
          })()}

          <div className="grid gap-5 xl:grid-cols-2">
            <Card k="trend" sub="Actual yield in comparable terms, and this term's projection with its 90% range" onExplain={explain}>
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={trend} margin={{ top: 20, right: 24, left: 4, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="0" />
                    <XAxis dataKey="term" {...axis} />
                    <YAxis {...axis} width={44} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} domain={[(min: number) => Math.max(0, Math.floor((Math.min(min, yLo) - 0.02) * 50) / 50), (max: number) => Math.min(1, Math.ceil((Math.max(max, yHi) + 0.02) * 50) / 50)]} />
                    <Tooltip
                      contentStyle={tip}
                      formatter={(v: number, n: string, item: { payload?: { err?: number[] } }) =>
                        n === "Projected yield" && item.payload?.err ? [`${pct(v)} (90% range ${pct(yLo)}–${pct(yHi)})`, n] : [pct(v), n]
                      }
                    />
                    <Legend iconType="plainline" iconSize={14} wrapperStyle={{ fontSize: 12 }} />
                    <Line dataKey="actual" name="Actual yield" stroke="var(--series-actual)" strokeWidth={2} dot={{ r: 4, strokeWidth: 2, fill: "hsl(var(--card))" }} isAnimationActive={false} connectNulls>
                      <LabelList dataKey="actual" position="top" fontSize={11} fill="hsl(var(--muted-foreground))" formatter={(v: number) => (v == null ? "" : pct(v))} />
                    </Line>
                    <Line dataKey="projected" name="Projected yield" stroke="var(--series-ref)" strokeWidth={2} strokeDasharray="5 4" dot={{ r: 5, fill: "var(--series-ref)" }} isAnimationActive={false} connectNulls>
                      <ErrorBar dataKey="err" width={10} strokeWidth={1.5} stroke="var(--series-ref)" direction="y" />
                      <LabelList dataKey="projected" position="top" fontSize={11} fontWeight={600} fill="hsl(var(--foreground))" formatter={(v: number) => (v === r.yield ? pct(v) : "")} />
                    </Line>
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card k="college" sub={prior ? `Projected yield vs ${termName(prior.term)} actual, largest colleges` : "Projected yield, largest colleges"} onExplain={explain}>
              {collegeChart.length ? (
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={collegeChart} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }} barGap={2} barCategoryGap="24%">
                      <CartesianGrid horizontal={false} stroke="hsl(var(--border))" />
                      <XAxis type="number" {...axis} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} />
                      <YAxis
                        type="category"
                        dataKey="name"
                        {...axis}
                        width={170}
                        tickFormatter={(v: string) => {
                          const t = v.replace(/^(college|school|department) of (the )?/i, "");
                          return t.length > 26 ? t.slice(0, 25) + "…" : t;
                        }}
                      />
                      <Tooltip contentStyle={tip} formatter={(v: number, n: string) => [pct(v), n]} cursor={{ fill: "hsl(var(--muted)/0.5)" }} />
                      <Legend iconType="square" iconSize={9} wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="projected" name="Projected" fill="var(--series-ours)" radius={[0, 4, 4, 0]} barSize={10} isAnimationActive={false}>
                        <LabelList dataKey="projected" position="right" fontSize={10.5} fill="hsl(var(--muted-foreground))" formatter={(v: number) => pct(v)} />
                      </Bar>
                      {prior && <Bar dataKey="prior" name={`${termName(prior.term)} actual`} fill="var(--series-actual)" radius={[0, 4, 4, 0]} barSize={10} isAnimationActive={false} />}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="py-16 text-center text-sm text-muted-foreground">Match a College column in Detected Fields to see this.</p>
              )}
            </Card>
          </div>

          {colleges.length > 0 && (
            <Card k="college" sub="Where the class comes from, and which colleges are gaining or losing yield" onExplain={explain}>
              <Outlook rows={r.breakdowns[0].rows} label="College" total={r.expected} priorTerm={prior?.term} />
            </Card>
          )}

          {movers.length > 0 && prior && (
            <Card k="changes" sub={`Projected yield vs ${termName(prior.term)}, in percentage points, for groups with at least 50 admits`} onExplain={explain}>
              <div style={{ height: Math.max(220, movers.length * 30 + 40) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={movers} layout="vertical" margin={{ top: 0, right: 56, left: 0, bottom: 0 }}>
                    <CartesianGrid horizontal={false} stroke="hsl(var(--border))" />
                    <XAxis type="number" {...axis} tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`} domain={["dataMin - 0.5", "dataMax + 0.5"]} />
                    <YAxis type="category" dataKey="name" {...axis} width={220} tickFormatter={(v: string) => (v.length > 32 ? v.slice(0, 31) + "…" : v)} />
                    <ReferenceLine x={0} stroke="hsl(var(--foreground))" strokeOpacity={0.35} />
                    <Tooltip
                      contentStyle={tip}
                      cursor={{ fill: "hsl(var(--muted)/0.5)" }}
                      formatter={(v: number, _n: string, it: { payload?: { now: number; was: number; admits: number } }) => [
                        `${v > 0 ? "+" : ""}${v.toFixed(1)} pp (${pct(it.payload!.was)} → ${pct(it.payload!.now)}, ${int(it.payload!.admits)} admits)`,
                        "Change",
                      ]}
                    />
                    <Bar dataKey="pp" barSize={14} radius={4} isAnimationActive={false}>
                      {movers.map((m) => (
                        <Cell key={m.name} fill={m.pp >= 0 ? "hsl(var(--good))" : "hsl(var(--destructive))"} fillOpacity={0.85} />
                      ))}
                      <LabelList dataKey="pp" position="right" fontSize={11} fill="hsl(var(--muted-foreground))" formatter={(v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} pp`} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}

          <div className="grid gap-5 xl:grid-cols-2">
            <Card k="segments" sub="Admits grouped by how likely they are to enroll, with what each group needs" onExplain={explain}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-[13px]">
                  <thead className="border-b">
                    <tr>
                      <th className={TH}>Segment</th>
                      <th className={TH}>Admits</th>
                      <th className={TH}>% of admits</th>
                      <th className={TH}>Proj. enrolled</th>
                      <th className={TH}>% of class</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {segs.map((x) => (
                      <tr key={x.b}>
                        <td className={TD}>
                          <span className="flex items-center gap-2">
                            <span className="h-2.5 w-2.5 rounded-full" style={{ background: SEGMENTS[x.b].bar }} />
                            <span className="font-medium">{SEGMENTS[x.b].long}</span>
                            <span className="text-[11.5px] text-muted-foreground">{SEGMENTS[x.b].rule}</span>
                          </span>
                          <span className="mt-0.5 block pl-[18px] text-[11.5px] text-muted-foreground">{ACTION[x.b]}</span>
                        </td>
                        <td className={TD}>{int(x.n)}</td>
                        <td className={TD}>{pct(x.n / r.admits)}</td>
                        <td className={cn(TD, "font-semibold")}>{int(x.expected)}</td>
                        <td className={TD}>{pct(x.expected / r.expected)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-5 h-[180px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={r.distribution} margin={{ top: 6, right: 4, left: 0, bottom: 0 }} barCategoryGap={3}>
                    <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="bin" {...axis} tickFormatter={(v: string) => v.split("–")[0] + "%"} />
                    <YAxis {...axis} width={44} tickFormatter={(v: number) => v.toLocaleString()} />
                    <Tooltip contentStyle={tip} formatter={(v: number) => [int(v), "Admits"]} labelFormatter={(l: string) => `Likelihood ${l}`} cursor={{ fill: "hsl(var(--muted)/0.5)" }} />
                    <Bar dataKey="n" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                      {r.distribution.map((b) => (
                        <Cell key={b.bin} fill={SEGMENTS[b.band].bar} fillOpacity={0.85} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card k="drivers" sub="How much each piece of information shapes the forecast; ↑ means higher values make enrolling more likely" onExplain={explain}>
              <div className="h-[400px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={drivers} layout="vertical" margin={{ top: 0, right: 48, left: 0, bottom: 0 }}>
                    <CartesianGrid horizontal={false} stroke="hsl(var(--border))" />
                    <XAxis type="number" {...axis} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} />
                    <YAxis
                      type="category"
                      dataKey="name"
                      {...axis}
                      width={170}
                      tickFormatter={(v: string) => {
                        const d = drivers.find((x) => x.name === v)?.direction;
                        const t = v.length > 24 ? v.slice(0, 23) + "…" : v;
                        return `${t} ${d === "up" ? "↑" : d === "down" ? "↓" : ""}`;
                      }}
                    />
                    <Tooltip contentStyle={tip} formatter={(v: number) => [`${(v * 100).toFixed(1)}%`, "Influence"]} cursor={{ fill: "hsl(var(--muted)/0.5)" }} />
                    <Bar dataKey="share" fill="var(--series-teal)" radius={[0, 4, 4, 0]} barSize={14} isAnimationActive={false}>
                      <LabelList dataKey="share" position="right" fontSize={11} fill="hsl(var(--muted-foreground))" formatter={(v: number) => `${(v * 100).toFixed(1)}%`} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <div className="grid gap-5">
            <Card k="major" sub="Admits, projected enrolled and yield change by group" onExplain={explain}>
              {group ? (
                <>
                  {others.length > 1 && (
                    <div className="mb-3 flex w-fit rounded-full border bg-card p-1 text-[12.5px]">
                      {others.map((b, i) => (
                        <button
                          key={b.field}
                          onClick={() => setDim(i + 1)}
                          className={cn("rounded-full px-3 py-1 font-medium", b === group ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                        >
                          {friendly(b.field)}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="max-h-[420px] overflow-y-auto">
                    <Outlook rows={group.rows} label={friendly(group.field)} total={r.expected} priorTerm={prior?.term} />
                  </div>
                </>
              ) : (
                <p className="py-16 text-center text-sm text-muted-foreground">Match Major or Residency columns to see more breakdowns.</p>
              )}
            </Card>
          </div>
        </div>

        {ai && (
          <YieldChat
            p={p}
            title="Ask about this forecast"
            className="sticky top-0 h-[calc(100dvh-10rem)] w-[360px] shrink-0 animate-in fade-in-0 slide-in-from-right-2 duration-200"
            questions={[CHARTS.college.q, CHARTS.segments.q, "Which majors are projected to lose the most yield?", "How reliable is this forecast?", "Which admits should counselors prioritize this week?"]}
            ask={ask}
            onClose={() => setAi(false)}
          />
        )}
      </div>
      <NextBar label="Next: Admit-level view" />
    </Page>
  );
}

/* -------------------------------------------------------------- students */

const ROW = 37;

const BATCH = 100;

export function StudentsPage() {
  const { p, runner, ready } = useForecast();
  const [seg, setSeg] = useState<"all" | Seg>("all");
  const [q, setQ] = useState("");
  const [college, setCollege] = useState("");
  const [major, setMajor] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "probability", desc: true });
  const [open, setOpen] = useState<Student | null>(null);
  const [list, setList] = useState<{ total: number; rows: Student[] } | null>(null);
  const [facets, setFacets] = useState<{ college: string[]; major: string[] }>({ college: [], major: [] });
  const [busy, setBusy] = useState(false);
  const fid = p?.forecast?.id;
  const filters = { band: seg === "all" ? undefined : seg, q: q.trim() || undefined, college: college || undefined, major: major || undefined, sort: sort.key, desc: sort.desc };
  const key = JSON.stringify(filters);
  // the first rows for these filters; more load as you scroll
  useEffect(() => {
    if (!fid) return;
    let live = true;
    const t = setTimeout(() => {
      setBusy(true);
      API.students(fid, { ...filters, offset: 0, limit: BATCH })
        .then((r) => {
          if (!live) return;
          setList({ total: r.total, rows: r.rows });
          if (r.facets) setFacets(r.facets);
        })
        .catch((e) => toast.error((e as Error).message))
        .finally(() => live && setBusy(false));
    }, q ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [fid, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const more = () => {
    if (!fid || !list || busy || list.rows.length >= list.total) return;
    setBusy(true);
    API.students(fid, { ...filters, offset: list.rows.length, limit: BATCH })
      .then((r) => setList((l) => (l ? { total: r.total, rows: [...l.rows, ...r.rows] } : l)))
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setBusy(false));
  };
  if (!p || !ready) return <Building p={p} runner={runner} />;
  if (!list) return <Loading text="Ranking admits…" />;
  const r = p.forecast!.summary;
  const cols: ("college" | "major")[] = [p.mapping.college && "college", p.mapping.major && "major"].filter(Boolean) as ("college" | "major")[];
  const counts = { all: r.admits, high: r.segments.high.n, medium: r.segments.medium.n, low: r.segments.low.n };
  const hasActual = !!r.actual || list.rows.some((s) => s.actual !== null);
  const pick = "h-9 rounded-full border border-input bg-background px-3 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring max-w-[220px]";

  return (
    <Page
      title="Admit-Level Predictions"
      description={`${termName(r.target_term)} ${groupName(p).toLowerCase()} admits and how likely each is to enroll. Sort any column, filter, and select an admit to see why.`}
      width="wide"
      mode="fill"
      actions={<Actions p={p} />}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <div className="flex rounded-full border bg-card p-1 text-[12.5px]">
          {(["all", "high", "medium", "low"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setSeg(k)}
              className={cn(
                "rounded-full px-3 py-1.5 font-medium transition-colors duration-150",
                seg === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {k === "all" ? "All admits" : SEGMENTS[k].long} <span className="ml-1 tabular-nums opacity-75">{int(counts[k])}</span>
            </button>
          ))}
        </div>
        {cols.includes("college") && facets.college.length > 1 && (
          <select value={college} onChange={(e) => setCollege(e.target.value)} className={pick} aria-label={`Filter by ${friendly(p.mapping.college!)}`}>
            <option value="">Every {friendly(p.mapping.college!).toLowerCase()}</option>
            {facets.college.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        )}
        {cols.includes("major") && facets.major.length > 1 && (
          <select value={major} onChange={(e) => setMajor(e.target.value)} className={pick} aria-label={`Filter by ${friendly(p.mapping.major!)}`}>
            <option value="">Every {friendly(p.mapping.major!).toLowerCase()}</option>
            {facets.major.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        )}
        <div className="relative ml-auto w-56">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search student ID" className="h-9 rounded-full pl-9" />
        </div>
      </div>

      <div className="mt-3 flex min-h-[300px] flex-1 flex-col overflow-hidden surface">
        <div
          className="min-h-0 flex-1 overflow-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight > el.scrollHeight - 400) more();
          }}
        >
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 z-10 bg-muted text-left text-[11.5px] font-semibold text-muted-foreground">
              <tr className="h-10">
                <SortTh label="Student ID" k="student" sort={sort} onSort={setSort} />
                {cols.map((c) => (
                  <SortTh key={c} label={friendly(p.mapping[c]!)} k={c} sort={sort} onSort={setSort} className="hidden md:table-cell" />
                ))}
                <SortTh label="Likelihood to enroll" k="probability" sort={sort} onSort={setSort} />
                <SortTh label="Segment" k="band" sort={sort} onSort={setSort} />
                {hasActual && <SortTh label="Actual outcome" k="actual" sort={sort} onSort={setSort} className="hidden sm:table-cell" />}
              </tr>
            </thead>
            <tbody className="divide-y">
              {list.rows.map((s) => {
                const b = s.band;
                return (
                  <tr key={s.row} style={{ height: ROW }} onClick={() => setOpen(s)} className="cursor-pointer transition-colors duration-100 hover:bg-primary/[0.04]">
                    <td className="px-4 font-semibold tabular-nums">{s.student}</td>
                    {cols.map((c) => (
                      <td key={c} className="hidden max-w-[240px] truncate px-4 text-muted-foreground md:table-cell">
                        {s[c]}
                      </td>
                    ))}
                    <td className="px-4">
                      <div className="flex items-center gap-2.5">
                        <span className="h-1.5 w-28 rounded-full bg-muted">
                          <span className="block h-full rounded-full" style={{ width: `${s.probability * 100}%`, background: SEGMENTS[b].bar }} />
                        </span>
                        <span className="w-9 font-semibold tabular-nums">{Math.round(s.probability * 100)}%</span>
                      </div>
                    </td>
                    <td className="px-4">
                      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", SEGMENTS[b].bg, SEGMENTS[b].tone)}>{SEGMENTS[b].label}</span>
                    </td>
                    {hasActual && <td className="hidden px-4 text-muted-foreground sm:table-cell">{s.actual === null ? "–" : s.actual ? "Enrolled" : "Did not enroll"}</td>}
                  </tr>
                );
              })}
              {!list.rows.length && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                    No admits match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {busy && (
            <div className="flex items-center justify-center gap-2 py-3 text-[12px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading more admits…
            </div>
          )}
        </div>
        <div className="shrink-0 border-t px-4 py-1.5 text-[12px] text-muted-foreground">
          Showing {int(list.rows.length)} of {int(list.total)} admits{list.rows.length < list.total ? " · scroll for more" : ""}
        </div>
      </div>

      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(null)}>
          <DialogContent side="right" className="overflow-y-auto p-6">
            <DialogHeader>
              <DialogTitle>Student {open.student}</DialogTitle>
              <DialogDescription>
                {termName(r.target_term)} admit
                {cols.length
                  ? `, ${cols
                      .map((c) => open[c])
                      .filter(Boolean)
                      .join(", ")}`
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-4 rounded-xl bg-muted/50 p-4">
              <Ring value={open.probability} label={`${Math.round(open.probability * 100)}%`} sub="likely" size={92} stroke={9} color={SEGMENTS[open.band].bar} />
              <div>
                <div className={cn("font-semibold", SEGMENTS[open.band].tone)}>{SEGMENTS[open.band].long}</div>
                <div className="text-sm text-muted-foreground">{open.actual === null ? "Outcome pending" : open.actual ? "Enrolled" : "Did not enroll"}</div>
              </div>
            </div>
            <Factors s={open} fid={fid!} />
          </DialogContent>
        </Dialog>
      )}
      <NextBar />
    </Page>
  );
}

function Factors({ s, fid }: { s: Student; fid: string }) {
  const [items, setItems] = useState<{ feature: string; effect: number; value: string }[] | null>(null);
  useEffect(() => {
    setItems(null);
    fetchQuery(`factors:${fid}:${s.row}`, () => API.factors(fid, s.row))
      .then(setItems)
      .catch((e) => toast.error((e as Error).message));
  }, [fid, s.row]);
  if (!items) return <Loading text="Explaining this prediction…" />;
  const max = Math.max(...items.map((i) => Math.abs(i.effect)), 0.01);
  return (
    <div>
      <div className="mb-2 text-sm font-semibold">Key factors</div>
      <ul className="space-y-2">
        {items.map((x) => (
          <li key={x.feature} className="grid grid-cols-[16px_1fr_72px] items-center gap-2 text-[13px]">
            {x.effect >= 0 ? <ArrowUp className="h-4 w-4 text-good" /> : <ArrowDown className="h-4 w-4 text-destructive" />}
            <span className="truncate">
              {friendly(x.feature)}: <b>{x.value || "blank"}</b>
            </span>
            <span className="h-1.5 rounded-full bg-muted">
              <span
                className={cn("block h-full rounded-full", x.effect >= 0 ? "bg-good" : "bg-destructive")}
                style={{ width: `${(Math.abs(x.effect) / max) * 100}%` }}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
