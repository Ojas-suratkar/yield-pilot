import { useState } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Rectangle, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertCircle, ArrowDownRight, ArrowUpRight, Ban, Bot, CheckCircle2, Clock, Download, ExternalLink, HardDrive, Play, Receipt, Upload, type LucideIcon } from "lucide-react";
import { cn } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Failed, Loading, SortTh, TableSearch, useTable } from "../components/ui";
import { API, type EventRow, type RowPage, type RunRow, type UsagePoint, type UsageReport, type UsageScope } from "../lib/api";
import { termName } from "../lib/labels";
import { useSession } from "../lib/auth";
import { useQuery } from "../lib/query";

export const usd = (n: number) => {
  const a = Math.abs(n);
  const s = n < 0 ? "-" : "";
  if (a === 0) return "$0.00";
  if (a >= 1000) return `${s}$${Math.round(a).toLocaleString()}`;
  if (a >= 0.01) return `${s}$${a.toFixed(2)}`;
  return a >= 0.001 ? `${s}${(a * 100).toFixed(1)}¢` : `${s}under 0.1¢`;
};
const usdTick = (n: number) => (n === 0 ? "$0" : n >= 0.1 ? `$${n.toFixed(2)}` : `${+(n * 100).toFixed(2)}¢`);
export const duration = (s: number | null | undefined) => {
  if (s == null) return "–";
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${Math.round(s % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
export const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : Math.round(n).toLocaleString());
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const whole = (n: number | null | undefined) => (n == null ? "–" : Math.round(n).toLocaleString());
export const ESTIMATE_NOTE =
  "Forecast costs are Google's actual charges: each Run's share of what Google billed for the forecast server in the hours it ran. Runs from the last few hours show an estimate (≈) until Google bills them. AI answers are their words (tokens) at Google's prices; uploads and stored files are measured use at Google's prices.";

export const RANGES: [number, string][] = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "12 months"]];

export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="inline-flex max-w-full flex-wrap rounded-xl border bg-card p-1 text-[12.5px]" role="group" aria-label={label}>
      {options.map(([k, text]) => (
        <button key={String(k)} aria-pressed={value === k} onClick={() => onChange(k)}
          className={cn("rounded-lg px-3 py-1 font-medium transition-colors", value === k ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function Kpi({ icon: Icon, label, value, note, alert }: { icon: LucideIcon; label: string; value: string; note?: React.ReactNode; alert?: boolean }) {
  return (
    <div className="surface flex items-start gap-3.5 p-4">
      <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-xl", alert ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary")}>
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-medium text-muted-foreground">{label}</div>
        <div className="text-[24px] font-semibold leading-tight tabular-nums tracking-[-0.03em]">{value}</div>
        {note && <div className="mt-0.5 truncate text-[12px] text-muted-foreground">{note}</div>}
      </div>
    </div>
  );
}

function Change({ now, before, days }: { now: number; before: number; days: number }) {
  const span = days === 365 ? "previous 12 months" : `previous ${days} days`;
  if (!before) return <>{now ? `none in the ${span}` : "no activity yet"}</>;
  const pct = ((now - before) / before) * 100;
  const Icon = pct >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-0.5">
      <Icon className="h-3 w-3" /> {Math.abs(pct).toFixed(0)}% vs {span}
    </span>
  );
}

export type Series = { key: "done" | "failed" | "cancelled" | "run_cost" | "ai_cost" | "import_cost"; label: string; color: string };
export const OUTCOME_SERIES: Series[] = [
  { key: "done", label: "Finished", color: "var(--cat-1)" },
  { key: "failed", label: "Failed", color: "var(--cat-2)" },
  { key: "cancelled", label: "Stopped", color: "var(--cat-3)" },
];
export const COST_SERIES: Series[] = [
  { key: "run_cost", label: "Forecasts", color: "var(--cat-1)" },
  { key: "ai_cost", label: "AI help", color: "var(--cat-2)" },
  { key: "import_cost", label: "Data uploads", color: "var(--cat-3)" },
];
const axis = { stroke: "hsl(var(--border))", tick: { fill: "hsl(var(--muted-foreground))", fontSize: 11 }, tickLine: false, axisLine: false } as const;
const tick = (at: string, unit: "day" | "month") =>
  new Date(`${at}T00:00:00Z`).toLocaleDateString("en-US", unit === "day" ? { month: "short", day: "numeric", timeZone: "UTC" } : { month: "short", year: "2-digit", timeZone: "UTC" });

function ChartTip({ active, payload, label, series, fmt }: { active?: boolean; payload?: { payload: UsagePoint }[]; label?: string; series: Series[]; fmt: (n: number) => string }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const total = series.reduce((sum, s) => sum + d[s.key], 0);
  return (
    <div className="rounded-xl border bg-card px-3 py-2 text-[12px] shadow-[var(--shadow-lift)]">
      <div className="mb-1 font-semibold">{label}</div>
      {[...series].reverse().map((s) => (
        <div key={s.key} className="flex items-center justify-between gap-5">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} /> {s.label}
          </span>
          <span className="tabular-nums">{fmt(d[s.key])}</span>
        </div>
      ))}
      <div className="mt-1 flex justify-between gap-5 border-t pt-1 font-medium">
        <span>Total</span>
        <span className="tabular-nums">{fmt(total)}</span>
      </div>
    </div>
  );
}

/** One rounded end per stacked bar, on whichever segment is on top that day. */
const topRounded = (series: Series[], index: number) =>
  function Segment(raw: unknown) {
    const props = raw as React.ComponentProps<typeof Rectangle> & { payload?: UsagePoint };
    const covered = series.slice(index + 1).some((s) => (props.payload?.[s.key] ?? 0) > 0);
    return <Rectangle {...props} radius={covered ? 0 : [4, 4, 0, 0]} />;
  };

export function StackedBars({ title, note, data, series, unit, fmt, whole: wholeOnly }: { title: string; note?: string; data: UsagePoint[]; series: Series[]; unit: "day" | "month"; fmt: (n: number) => string; whole?: boolean }) {
  const total = data.reduce((sum, d) => sum + series.reduce((x, s) => x + d[s.key], 0), 0);
  const rows = data.map((d) => ({ ...d, tick: tick(d.at, unit) }));
  return (
    <div className="surface p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div>
          <div className="text-[13.5px] font-semibold">{title}</div>
          {note && <div className="text-[12px] text-muted-foreground">{note}</div>}
        </div>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} /> {s.label}
            </li>
          ))}
        </ul>
      </div>
      {total > 0 ? (
        <div className="h-[230px]" role="img" aria-label={`${title}: ${fmt(total)} in total over the period. The tables on this page list the same numbers.`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap="24%">
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.7} />
              <XAxis dataKey="tick" {...axis} minTickGap={22} />
              <YAxis {...axis} width={56} allowDecimals={!wholeOnly} tickFormatter={(v: number) => (fmt === usd ? usdTick(v) : fmt(v))} />
              <Tooltip cursor={{ fill: "hsl(var(--muted) / 0.5)" }} content={<ChartTip series={series} fmt={fmt} />} />
              {series.map((s, i) => (
                <Bar key={s.key} dataKey={s.key} stackId="a" fill={s.color} stroke="hsl(var(--card))" strokeWidth={2} maxBarSize={30} isAnimationActive={false} shape={topRounded(series, i)} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="grid h-[230px] place-items-center text-[13px] text-muted-foreground">Nothing in this period</p>
      )}
    </div>
  );
}

export type Meter = { key: string; label: React.ReactNode; sub?: React.ReactNode; value: number; text: string };

export function MeterList({ title, note, rows, empty }: { title: string; note?: string; rows: Meter[]; empty: string }) {
  const top = Math.max(...rows.map((r) => r.value), 0);
  return (
    <div className="surface min-w-0 p-4">
      <div className="text-[13.5px] font-semibold">{title}</div>
      {note && <div className="text-[12px] text-muted-foreground">{note}</div>}
      <ul className="mt-3 space-y-3">
        {rows.map((r) => (
          <li key={r.key} className="text-[12.5px]">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate font-medium">{r.label}</span>
              <span className="shrink-0 tabular-nums">{r.text}</span>
            </div>
            {r.sub && <div className="truncate text-[11.5px] text-muted-foreground">{r.sub}</div>}
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-[var(--series-ours)]" style={{ width: `${top ? Math.max(1.5, (r.value / top) * 100) : 0}%` }} />
            </div>
          </li>
        ))}
        {!rows.length && <li className="py-6 text-center text-[13px] text-muted-foreground">{empty}</li>}
      </ul>
    </div>
  );
}

const STATUS = {
  done: { icon: CheckCircle2, label: "Finished", tone: "text-good" },
  failed: { icon: AlertCircle, label: "Failed", tone: "text-destructive" },
  cancelled: { icon: Ban, label: "Stopped", tone: "text-muted-foreground" },
} as const;

function saveCsv(name: string, rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // a spreadsheet must never run a name as a formula
    return `"${s.replace(/"/g, '""')}"`;
  };
  const url = URL.createObjectURL(new Blob([rows.map((r) => r.map(cell).join(",")).join("\n")], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const STEP = 100;
const th = "py-2.5 text-right [&>button]:justify-end";

function RunsTable({ page, showInstitution, canOpen }: { page: RowPage<RunRow>; showInstitution?: boolean; canOpen?: boolean }) {
  const [outcome, setOutcome] = useState<"all" | RunRow["outcome"]>("all");
  const [limit, setLimit] = useState(STEP);
  const base = page.rows.filter((r) => outcome === "all" || r.outcome === outcome);
  const t = useTable(base as (RunRow & Record<string, unknown>)[], { key: "at", desc: true }, (r) => `${r.by} ${r.study} ${r.institution} ${termName(r.term)} ${r.group ?? ""} ${r.outcome}`);
  const csv = () =>
    saveCsv("yieldpilot-runs.csv", [
      ["When", ...(showInstitution ? ["Institution"] : []), "Person", "Prediction", "Term", "Group", "Admits", "Expected to enroll", "Result", "Reason", "Seconds", "CPU seconds used", "Peak memory (MB)", "vCPUs", "Estimated cost (USD)"],
      ...t.shown.map((r) => [r.at, ...(showInstitution ? [r.institution] : []), r.by, r.study, r.term ? termName(r.term) : "", r.group, r.admits, r.expected, STATUS[r.outcome].label, r.error, r.seconds, r.cpu_seconds, r.peak_memory_mb, r.vcpu, r.cost]),
    ]);
  return (
    <div className="surface overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="text-[13.5px] font-semibold">Every forecast</div>
        <span className="rounded-full bg-muted px-2 text-[11.5px] tabular-nums">{t.shown.length.toLocaleString()}{page.more ? "+" : ""}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Segmented label="Result" value={outcome} onChange={(v) => { setOutcome(v); setLimit(STEP); }} options={[["all", "All"], ["done", "Finished"], ["failed", "Failed"], ["cancelled", "Stopped"]]} />
          <TableSearch value={t.q} onChange={t.setQ} placeholder="Search" />
          <Button variant="outline" size="sm" className="h-8" disabled={!t.shown.length} onClick={csv}><Download className="h-3.5 w-3.5" /> CSV</Button>
        </div>
      </div>
      {t.shown.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] text-[13px]">
            <thead className="border-b bg-muted/30 text-left text-[11.5px] font-semibold text-muted-foreground">
              <tr>
                <SortTh label="When" k="at" sort={t.sort} onSort={t.setSort} className="py-2.5 pl-4" />
                <SortTh label="Person" k="by" sort={t.sort} onSort={t.setSort} className="py-2.5" />
                <SortTh label="Prediction" k="study" sort={t.sort} onSort={t.setSort} className="py-2.5" />
                <SortTh label="Admits" k="admits" sort={t.sort} onSort={t.setSort} className={th} />
                <SortTh label="Expected" k="expected" sort={t.sort} onSort={t.setSort} className={th} />
                <SortTh label="Time" k="seconds" sort={t.sort} onSort={t.setSort} className={th} />
                <SortTh label="Compute" k="cpu_seconds" sort={t.sort} onSort={t.setSort} className={th} />
                <SortTh label="Cost" k="cost" sort={t.sort} onSort={t.setSort} className={th} />
                <SortTh label="Result" k="outcome" sort={t.sort} onSort={t.setSort} className="py-2.5" />
                {canOpen && <th className="px-4 py-2.5" />}
              </tr>
            </thead>
            <tbody className="divide-y">
              {t.shown.slice(0, limit).map((r) => {
                const s = STATUS[r.outcome];
                return (
                  <tr key={r.id} className="transition-colors hover:bg-muted/30">
                    <td className="whitespace-nowrap py-2.5 pl-4 pr-4 tabular-nums">{when(r.at)}</td>
                    <td className="max-w-[200px] px-4 py-2.5">
                      <div className="truncate">{r.by}</div>
                      {showInstitution && <div className="truncate text-[11.5px] text-muted-foreground">{r.institution}</div>}
                    </td>
                    <td className="max-w-[280px] px-4 py-2.5">
                      <div className="truncate font-medium" title={r.study}>{r.study}</div>
                      {r.term && <div className="truncate text-[11.5px] text-muted-foreground">{termName(r.term)}{r.group ? ` · ${r.group}` : ""}</div>}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{whole(r.admits)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{whole(r.expected)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">{duration(r.seconds)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                      {r.cpu_seconds != null ? `${duration(r.cpu_seconds)} CPU` : `${r.vcpu} vCPU`}
                      <div className="text-[11.5px] text-muted-foreground">
                        {r.cpu_seconds != null ? `${r.vcpu} vCPU · ${r.peak_memory_mb != null ? `${(r.peak_memory_mb / 1024).toFixed(1)} GB peak` : `${r.memory_gib} GB`}` : "not measured"}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums" title={r.billed ? "Google's actual charge for this run" : "An estimate until Google bills this hour"}>
                      {r.billed ? usd(r.cost) : <span className="text-muted-foreground">≈ {usd(r.cost)}</span>}
                      <div className="text-[11px] text-muted-foreground">{r.billed ? "Google's bill" : "estimate"}</div>
                    </td>
                    <td className="max-w-[220px] px-4 py-2.5">
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><s.icon className={cn("h-3.5 w-3.5", s.tone)} /> {s.label}</span>
                      {r.kind === "tuning" && <div className="text-[11.5px] text-muted-foreground">Settings test</div>}
                      {r.error && <div className="truncate text-[11.5px] text-muted-foreground" title={r.error}>{r.error}</div>}
                    </td>
                    {canOpen && (
                      <td className="px-4 py-2.5 text-right">
                        {r.forecast_id && <Link to={`/shared/${r.forecast_id}`} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-primary hover:underline">Open <ExternalLink className="h-3 w-3" /></Link>}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">No forecasts here yet.</p>
      )}
      <More shown={Math.min(limit, t.shown.length)} total={t.shown.length} capped={page.more} onMore={() => setLimit(limit + STEP * 2)} />
    </div>
  );
}

function More({ shown, total, capped, onMore }: { shown: number; total: number; capped: boolean; onMore: () => void }) {
  if (shown >= total && !capped) return null;
  return (
    <div className="flex items-center justify-center gap-3 border-t px-4 py-2.5 text-[12.5px] text-muted-foreground">
      <span>Showing {shown.toLocaleString()} of {total.toLocaleString()}{capped ? " (newest; choose a shorter period for older ones)" : ""}</span>
      {shown < total && <Button variant="outline" size="sm" className="h-7" onClick={onMore}>Show more</Button>}
    </div>
  );
}

function EventsTable({ page, showInstitution }: { page: RowPage<EventRow>; showInstitution?: boolean }) {
  const [kind, setKind] = useState<"all" | "ai" | "import">("all");
  const [limit, setLimit] = useState(STEP);
  const base = page.rows.filter((r) => kind === "all" || r.kind === kind);
  const t = useTable(base as (EventRow & Record<string, unknown>)[], { key: "at", desc: true }, (r) => `${r.by} ${r.what} ${r.institution} ${r.model ?? ""}`);
  const csv = () =>
    saveCsv("yieldpilot-ai-and-imports.csv", [
      ["When", ...(showInstitution ? ["Institution"] : []), "Person", "What", "Model", "AI tokens", "Rows", "Seconds", "Estimated cost (USD)"],
      ...t.shown.map((r) => [r.at, ...(showInstitution ? [r.institution] : []), r.by, r.what, r.model, r.kind === "ai" ? r.tokens : "", r.rows, r.seconds, r.cost]),
    ]);
  return (
    <div className="surface overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="text-[13.5px] font-semibold">AI help and data uploads</div>
        <span className="rounded-full bg-muted px-2 text-[11.5px] tabular-nums">{t.shown.length.toLocaleString()}{page.more ? "+" : ""}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Segmented label="Kind" value={kind} onChange={(v) => { setKind(v); setLimit(STEP); }} options={[["all", "All"], ["ai", "AI help"], ["import", "Uploads"]]} />
          <TableSearch value={t.q} onChange={t.setQ} placeholder="Search" />
          <Button variant="outline" size="sm" className="h-8" disabled={!t.shown.length} onClick={csv}><Download className="h-3.5 w-3.5" /> CSV</Button>
        </div>
      </div>
      {t.shown.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead className="border-b bg-muted/30 text-left text-[11.5px] font-semibold text-muted-foreground">
              <tr>
                <SortTh label="When" k="at" sort={t.sort} onSort={t.setSort} className="py-2.5 pl-4" />
                <SortTh label="Person" k="by" sort={t.sort} onSort={t.setSort} className="py-2.5" />
                <SortTh label="What" k="what" sort={t.sort} onSort={t.setSort} className="py-2.5" />
                <SortTh label="Rows" k="rows" sort={t.sort} onSort={t.setSort} className={th} />
                <SortTh label="Time" k="seconds" sort={t.sort} onSort={t.setSort} className={th} />
                <SortTh label="Cost" k="cost" sort={t.sort} onSort={t.setSort} className={th} />
              </tr>
            </thead>
            <tbody className="divide-y">
              {t.shown.slice(0, limit).map((r) => (
                <tr key={r.id} className="transition-colors hover:bg-muted/30">
                  <td className="whitespace-nowrap py-2.5 pl-4 pr-4 tabular-nums">{when(r.at)}</td>
                  <td className="max-w-[220px] px-4 py-2.5">
                    <div className="truncate">{r.by}</div>
                    {showInstitution && <div className="truncate text-[11.5px] text-muted-foreground">{r.institution}</div>}
                  </td>
                  <td className="px-4 py-2.5 font-medium">{r.what}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{whole(r.rows)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">{duration(r.seconds)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">{usd(r.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">Nothing here yet.</p>
      )}
      <More shown={Math.min(limit, t.shown.length)} total={t.shown.length} capped={page.more} onMore={() => setLimit(limit + STEP * 2)} />
    </div>
  );
}

/** The two activity lists, one after the other: nothing about what happened is more than a scroll away. */
export function Activity({ runs, events, showInstitution, canOpen }: { runs?: RowPage<RunRow>; events?: RowPage<EventRow>; showInstitution?: boolean; canOpen?: boolean }) {
  return (
    <>
      {runs ? <RunsTable page={runs} showInstitution={showInstitution} canOpen={canOpen} /> : <div className="surface"><Loading text="Loading every run…" /></div>}
      {events && <EventsTable page={events} showInstitution={showInstitution} />}
    </>
  );
}

export function aiMeters(r: UsageReport): Meter[] {
  return r.by_purpose.filter((p) => p.kind === "ai").map((p) => ({ key: p.purpose, label: p.label, sub: `${p.count.toLocaleString()} time${p.count === 1 ? "" : "s"}`, value: p.cost, text: usd(p.cost) }));
}

/** What the workspace has used and what that work costs: every Run, every AI answer, every import, per person and per study. */
export function UsagePage() {
  const { me } = useSession();
  const [days, setDays] = useState(30);
  const owner = me?.role === "owner";
  const [picked, setScope] = useState<UsageScope>("institution");
  const scope: UsageScope = owner ? picked : "me"; // only the owner sees other people's usage and costs
  const key = `${scope}:${days}`;
  const report = useQuery(`usage:${key}`, () => API.usage(days, scope), 15_000);
  const runs = useQuery(`usage:runs:${key}`, () => API.usageRuns(days, scope), 15_000);
  const events = useQuery(`usage:events:${key}`, () => API.usageEvents(days, scope), 15_000);
  const everyone = scope === "institution";
  if (report.error) return <Failed error={report.error} retry={report.reload} />;
  const r = report.data;
  const t = r?.totals;
  const p = r?.previous;
  const place = me?.institution?.name ?? "your workspace";
  const fmtCount = (n: number) => Math.round(n).toLocaleString();

  return (
    <div className="page-enter mx-auto flex max-w-[1320px] flex-col gap-5 px-6 py-8 lg:px-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-[-0.03em]">{owner ? "Usage and costs" : "My usage and costs"}</h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">
            {everyone ? `Every forecast, AI answer and data upload in ${place}.` : owner ? "Only your own forecasts, AI answers and data uploads." : "Your own forecasts, AI answers and data uploads. Only the workspace owner sees everyone's."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {owner && <Segmented label="Whose usage" value={scope} onChange={setScope} options={[["institution", "Everyone"], ["me", "Just me"]]} />}
          <Segmented label="Period" value={days} onChange={setDays} options={RANGES} />
        </div>
      </div>

      {!r || !t || !p ? (
        <div className="surface"><Loading text="Adding up the usage…" /></div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
            <Kpi icon={Receipt} label="Estimated cost" value={usd(t.total_cost)} note={<Change now={t.total_cost - t.storage_cost} before={p.total_cost - p.storage_cost} days={days} />} />
            <Kpi icon={Play} label="Forecasts run" value={t.runs.toLocaleString()} note={`${t.done} finished${t.failed ? ` · ${t.failed} failed` : ""}${t.cancelled ? ` · ${t.cancelled} stopped` : ""}`} />
            <Kpi icon={Clock} label="Average time per forecast" value={t.avg_seconds ? duration(t.avg_seconds) : "–"} note={`${duration(t.seconds)} in all`} />
            <Kpi icon={Bot} label="AI answers" value={t.ai_calls.toLocaleString()} note={`${usd(t.ai_cost)} in all`} />
            <Kpi icon={Upload} label="Data uploads" value={t.imports.toLocaleString()} note={`${compact(t.rows_imported)} rows`} />
            {everyone ? (
              <Kpi icon={HardDrive} label="Files stored" value={t.storage_gb >= 1 ? `${t.storage_gb.toFixed(1)} GB` : `${Math.round(t.storage_gb * 1024)} MB`} note={`${usd(t.storage_cost)} for this period`} />
            ) : (
              <Kpi icon={Receipt} label="Cost of each forecast" value={t.done ? usd(t.run_cost / t.done) : "–"} note="on average" />
            )}
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <StackedBars title={r.unit === "day" ? "Forecasts each day" : "Forecasts each month"} data={r.series} series={OUTCOME_SERIES} unit={r.unit} fmt={fmtCount} whole />
            <StackedBars title={r.unit === "day" ? "Estimated cost each day" : "Estimated cost each month"} data={r.series} series={COST_SERIES} unit={r.unit} fmt={usd} />
          </div>

          <div className={cn("grid gap-3", everyone ? "lg:grid-cols-4" : "lg:grid-cols-3")}>
            <MeterList title="Where the cost comes from" empty="Nothing yet" rows={[
              { key: "run", label: "Forecasts", sub: `${t.runs} run${t.runs === 1 ? "" : "s"}`, value: t.run_cost, text: usd(t.run_cost) },
              { key: "ai", label: "AI help", sub: `${t.ai_calls} answer${t.ai_calls === 1 ? "" : "s"}`, value: t.ai_cost, text: usd(t.ai_cost) },
              { key: "import", label: "Data uploads", sub: `${t.imports} upload${t.imports === 1 ? "" : "s"}`, value: t.import_cost, text: usd(t.import_cost) },
              ...(everyone ? [{ key: "files", label: "Stored files", sub: `${t.storage_gb >= 1 ? t.storage_gb.toFixed(1) + " GB" : Math.round(t.storage_gb * 1024) + " MB"}`, value: t.storage_cost, text: usd(t.storage_cost) }] : []),
            ]} />
            {everyone && (
              <MeterList title="By person" empty="No one yet" rows={r.by_person.slice(0, 8).map((x) => ({
                key: x.id, label: x.id === me?.id ? `${x.name} (you)` : x.name, sub: `${x.runs} forecast${x.runs === 1 ? "" : "s"} · ${x.ai_calls} AI answer${x.ai_calls === 1 ? "" : "s"}`, value: x.total_cost, text: usd(x.total_cost),
              }))} />
            )}
            <MeterList title="By prediction" empty="Nothing in this period" rows={r.by_study.slice(0, 8).map((x) => ({
              key: x.id, label: <span title={x.name}>{x.name}</span>, sub: `${x.runs} forecast${x.runs === 1 ? "" : "s"}${x.failed ? ` · ${x.failed} failed` : ""}`, value: x.cost, text: usd(x.cost),
            }))} />
            <MeterList title="What the AI helped with" empty="No AI help in this period" rows={aiMeters(r)} />
          </div>
        </>
      )}

      <Activity runs={runs.data} events={events.data} canOpen />
      <p className="text-[12px] text-muted-foreground">{ESTIMATE_NOTE}</p>
    </div>
  );
}
