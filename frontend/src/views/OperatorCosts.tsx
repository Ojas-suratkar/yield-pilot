import { useState } from "react";
import { Cpu, Gauge, Layers, Play, Receipt, Scale, Server, Sparkles, Upload, Wallet } from "lucide-react";
import { Failed, Loading, SortTh, TableSearch, useTable } from "../components/ui";
import { API, type OperatorCosts, type OperatorInstitutionCost } from "../lib/api";
import { useQuery } from "../lib/query";
import { money } from "./Billing";
import { Activity, COST_SERIES, ESTIMATE_NOTE, Kpi, MeterList, OUTCOME_SERIES, RANGES, Segmented, StackedBars, aiMeters, compact, duration, usd } from "./Usage";
import { Crest } from "./Welcome";

const num = "py-2.5 text-right [&>button]:justify-end";

function Institutions({ rows }: { rows: OperatorInstitutionCost[] }) {
  const t = useTable(rows as (OperatorInstitutionCost & Record<string, unknown>)[], { key: "total_cost", desc: true }, (i) => `${i.name} ${i.domain ?? ""}`);
  return (
    <div className="surface overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="text-[13.5px] font-semibold">Cost of each institution's activity</div>
        <span className="text-[12px] text-muted-foreground">The servers that are always on are shared, so they aren't split here</span>
        <TableSearch value={t.q} onChange={t.setQ} placeholder="Find an institution" className="ml-auto" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1000px] text-[13px]">
          <thead className="border-b bg-muted/30 text-left text-[11.5px] font-semibold text-muted-foreground">
            <tr>
              <SortTh label="Institution" k="name" sort={t.sort} onSort={t.setSort} className="py-2.5 pl-4" />
              <SortTh label="People" k="people" sort={t.sort} onSort={t.setSort} className={num} />
              <SortTh label="Forecasts run" k="runs" sort={t.sort} onSort={t.setSort} className={num} />
              <SortTh label="Forecast cost" k="run_cost" sort={t.sort} onSort={t.setSort} className={num} />
              <SortTh label="AI cost" k="ai_cost" sort={t.sort} onSort={t.setSort} className={num} />
              <SortTh label="Upload cost" k="import_cost" sort={t.sort} onSort={t.setSort} className={num} />
              <SortTh label="File cost" k="storage_cost" sort={t.sort} onSort={t.setSort} className={num} />
              <SortTh label="Total" k="total_cost" sort={t.sort} onSort={t.setSort} className={num} />
              <SortTh label="Received" k="collected_cents" sort={t.sort} onSort={t.setSort} className={num} />
            </tr>
          </thead>
          <tbody className="divide-y tabular-nums">
            {t.shown.map((i) => (
              <tr key={i.id} className="transition-colors hover:bg-muted/30">
                <td className="py-2.5 pl-4 pr-4">
                  <div className="flex items-center gap-3">
                    <Crest inst={i} size={30} />
                    <div className="min-w-0">
                      <div className="max-w-[300px] truncate font-medium">{i.name}</div>
                      <div className="text-[11.5px] text-muted-foreground">{i.failed ? `${i.failed} failed run${i.failed === 1 ? "" : "s"}` : `${i.storage_gb >= 1 ? `${i.storage_gb.toFixed(1)} GB` : `${Math.round(i.storage_gb * 1024)} MB`} stored`}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right">{i.people}</td>
                <td className="px-4 py-2.5 text-right">{i.runs}</td>
                <td className="px-4 py-2.5 text-right">{usd(i.run_cost)}</td>
                <td className="px-4 py-2.5 text-right">{usd(i.ai_cost)}</td>
                <td className="px-4 py-2.5 text-right">{usd(i.import_cost)}</td>
                <td className="px-4 py-2.5 text-right">{usd(i.storage_cost)}</td>
                <td className="px-4 py-2.5 text-right font-semibold">{usd(i.total_cost)}</td>
                <td className="px-4 py-2.5 text-right">{i.collected_cents ? money(i.collected_cents) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!t.shown.length && <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">No institution matches.</p>}
    </div>
  );
}

/** What the platform costs to run against what it collects, for the operator. */
const EXPORT_URL = "https://console.cloud.google.com/billing/export";
const NOT_CONNECTED: Record<string, string> = {
  setup: "Run backend/scripts/connect_billing.sh once, then switch on the export on the page it opens.",
  access: "The app can't read the billing dataset yet. Run backend/scripts/connect_billing.sh once.",
  export_off: "The dataset is ready, but Google isn't exporting the bill yet: in Billing, open BigQuery export and switch on Standard usage cost into billing_export.",
  error: "Google's billing data couldn't be read just now. It's tried again in a few minutes.",
};
const SERVICE: Record<string, string> = { "yp-backend": "API and forecasts", "yp-frontend": "Website" };

function Meters({ m, days }: { m: OperatorCosts["meters"]; days: number }) {
  return (
    <div className="surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2 text-[13.5px] font-semibold"><Gauge className="h-4 w-4 text-primary" /> Google's meters for the servers</div>
        <div className="text-[12px] text-muted-foreground">Cloud Monitoring, last {days} days</div>
      </div>
      {m.available ? (
        <table className="mt-2 w-full text-[13px]">
          <thead className="text-left text-[11.5px] text-muted-foreground">
            <tr><th className="py-1.5 font-medium">Service</th><th className="py-1.5 text-right font-medium">Billed instance time</th><th className="py-1.5 text-right font-medium">Requests</th></tr>
          </thead>
          <tbody className="divide-y">
            {(m.services ?? []).map((s) => (
              <tr key={s.service}>
                <td className="py-1.5">{SERVICE[s.service] ?? s.service} <span className="font-mono text-[11px] text-muted-foreground">{s.service}</span></td>
                <td className="py-1.5 text-right tabular-nums">{s.billed_hours.toLocaleString()} h</td>
                <td className="py-1.5 text-right tabular-nums">{s.requests.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-2 text-[12.5px] text-muted-foreground">
          {m.reason === "access" ? "The app can't read Google's meters yet. Run backend/scripts/connect_billing.sh once." : "Google's meters couldn't be read just now."}
        </p>
      )}
    </div>
  );
}

const day = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function GoogleBill({ a, estimate, since }: { a: OperatorCosts["actual"]; estimate?: number; since: string }) {
  if (!a.connected)
    return (
      <div className="surface flex gap-3 px-4 py-3 text-[13px]">
        <Receipt className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <b className="font-semibold">Google's bill can't be read right now.</b> {NOT_CONNECTED[a.reason ?? "setup"] ?? NOT_CONNECTED.setup} Until then, the
          figures below are worked out from measured use at Google's prices.{" "}
          <a href={EXPORT_URL} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">Open billing export</a>
        </div>
      </div>
    );
  const things = a.by_resource ?? a.by_service ?? [];
  const days = a.by_day ?? [];
  const peak = Math.max(...days.map((d) => d.cost), 0.01);
  const later = a.first_day && a.first_day > since.slice(0, 10);
  return (
    <div className="surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2 text-[13.5px] font-semibold"><Receipt className="h-4 w-4 text-primary" /> What Google charged</div>
        {a.as_of && <div className="text-[12px] text-muted-foreground">Google Cloud billing export, updated {day(a.as_of)}</div>}
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-x-8 gap-y-2">
        <div className="text-[30px] font-semibold tabular-nums tracking-[-0.03em]">{usd(a.total ?? 0)}</div>
        <div className="pb-1.5 text-[12.5px] text-muted-foreground">
          {usd(a.gross ?? 0)} before {usd(Math.abs(a.credits ?? 0))} in credits.
          {estimate != null && <> Worked out from measured use instead, it would be {usd(estimate)}.</>}
          {later && <> Google's records start on {day(a.first_day!)}, when YieldPilot's Google Cloud project began.</>}
        </div>
        {days.length > 1 && (
          <div className="ml-auto flex h-12 items-end gap-[2px]" aria-label="Cost each day">
            {days.map((d) => (
              <div key={d.day} title={`${day(d.day)}: ${usd(d.cost)}`} className="w-[5px] rounded-sm bg-primary/70 hover:bg-primary" style={{ height: `${Math.max(4, (d.cost / peak) * 100)}%` }} />
            ))}
          </div>
        )}
      </div>
      {things.length > 0 ? (
        <div className="mt-3 grid gap-x-8 md:grid-cols-2">
          <div>
            <div className="mb-1 text-[12px] font-medium text-muted-foreground">By server, database and service</div>
            <ul className="divide-y text-[13px]">
              {things.slice(0, 9).map((s) => (
                <li key={s.name} className="flex justify-between gap-4 py-1.5">
                  <span className="min-w-0 truncate" title={"detail" in s ? (s as { detail: string }).detail : s.name}>
                    {s.name}
                    {"detail" in s && <span className="ml-1.5 text-[11.5px] text-muted-foreground">{(s as { detail: string }).detail}</span>}
                  </span>
                  <span className="font-medium tabular-nums">{usd(s.cost)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 text-[12px] font-medium text-muted-foreground">Biggest items on the bill</div>
            <ul className="divide-y text-[13px]">
              {(a.by_sku ?? []).slice(0, 9).map((s) => (
                <li key={s.name} className="flex justify-between gap-4 py-1.5">
                  <span className="truncate text-muted-foreground" title={s.name}>{s.name}</span>
                  <span className="font-medium tabular-nums">{usd(s.cost)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[12.5px] text-muted-foreground">Connected. Google's first figures usually appear within a day.</p>
      )}
    </div>
  );
}

export function CostsTab() {
  const [days, setDays] = useState(30);
  const q = useQuery(`admin:costs:${days}`, () => API.adminCosts(days), 15_000);
  if (q.error) return <Failed error={q.error} retry={q.reload} />;
  const r = q.data;
  const head = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-[13px] text-muted-foreground">What it costs to run YieldPilot, and how much money comes in.</p>
      <Segmented label="Period" value={days} onChange={setDays} options={RANGES} />
    </div>
  );
  if (!r) return <>{head}<div className="surface"><Loading text="Adding up the costs…" /></div></>;
  const t = r.totals;
  const fromBill = r.source === "google";
  const whereTheMoneyGoes = fromBill
    ? (r.items ?? []).map((i) => ({ key: i.label, label: i.label, sub: i.detail, value: i.period, text: usd(i.period) }))
    : [
    ...r.fixed.map((f) => ({ key: f.label, label: f.label, sub: f.detail, value: f.period, text: usd(f.period) })),
    { key: "run", label: "Running forecasts", sub: `${t.runs} forecast${t.runs === 1 ? "" : "s"}`, value: t.run_cost, text: usd(t.run_cost) },
    { key: "ai", label: "AI help", sub: `${t.ai_calls} answer${t.ai_calls === 1 ? "" : "s"}`, value: t.ai_cost, text: usd(t.ai_cost) },
    { key: "import", label: "Data uploads", sub: `${t.imports} upload${t.imports === 1 ? "" : "s"}`, value: t.import_cost, text: usd(t.import_cost) },
    { key: "files", label: "Stored files", sub: "Uploaded data and results", value: t.storage_cost, text: usd(t.storage_cost) },
  ].filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
  const period = days === 365 ? "last 12 months" : `last ${days} days`;
  const inTheRed = r.margin < 0;
  const fmtCount = (n: number) => Math.round(n).toLocaleString();
  const label = r.unit === "day" ? "day" : "month";
  return (
    <>
      {head}
      {r.actual && <GoogleBill a={r.actual} estimate={r.estimate_total} since={r.since} />}
      {r.meters && <Meters m={r.meters} days={days} />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <Kpi icon={Receipt} label="Total spent" value={usd(r.grand_total)} note={fromBill ? `Google's bill, ${period}` : period} />
        <Kpi icon={Server} label={fromBill ? "Servers and databases" : "Servers that are always on"} value={usd(r.fixed_total)} note={`about ${usd(r.fixed_monthly)} every month`} />
        <Kpi icon={Layers} label="Cost of people's activity" value={usd(r.usage_total)} note="forecasts, AI help, uploads, files" />
        <Kpi icon={Wallet} label="Money received" value={money(r.collected_cents)} note={period} />
        <Kpi icon={Scale} label={inTheRed ? "Loss" : "Profit"} value={usd(Math.abs(r.margin))} note={inTheRed ? "Spending more than is coming in" : "More is coming in than is spent"} alert={inTheRed} />
        <Kpi icon={Play} label="Cost of each forecast" value={r.cost_per_run == null ? "–" : usd(r.cost_per_run)} note="total spent ÷ forecasts finished" />
      </div>
      <p className="surface px-4 py-3 text-[13.5px] leading-relaxed">
        In the {period}, {fromBill ? "Google charged" : "YieldPilot cost about"} <b className="font-semibold">{usd(r.grand_total)}</b>{fromBill ? " to run YieldPilot" : " to run"}. <b className="font-semibold">{usd(r.fixed_total)}</b> of that is servers that stay on whether or not anyone is using them, and <b className="font-semibold">{usd(r.usage_total)}</b> came from what people actually did. {money(r.collected_cents)} was received, so that's a {inTheRed ? "loss" : "profit"} of <b className="font-semibold">{usd(Math.abs(r.margin))}</b>.
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        <StackedBars title={`What people's activity cost each ${label}`} note="Servers that are always on aren't in this chart" data={r.series} series={COST_SERIES} unit={r.unit} fmt={usd} />
        <StackedBars title={`Forecasts run each ${label}`} data={r.series} series={OUTCOME_SERIES} unit={r.unit} fmt={fmtCount} whole />
      </div>
      <div className="grid items-start gap-3 lg:grid-cols-2">
        <MeterList title="Where the money goes" empty="Nothing yet" rows={whereTheMoneyGoes} />
        <MeterList title="What the AI helped with" empty="No AI help in this period" rows={aiMeters(r)} />
      </div>
      <Institutions rows={r.by_institution} />
      <details className="surface p-4 text-[13px]">
        <summary className="cursor-pointer font-semibold">Technical details</summary>
        {r.by_model.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[12.5px] font-medium text-muted-foreground">AI models used</div>
            <ul className="space-y-1 text-[12.5px]">
              {r.by_model.map((m) => (
                <li key={m.model} className="flex justify-between gap-4 tabular-nums">
                  <span>{m.model}</span>
                  <span className="text-muted-foreground">{m.calls.toLocaleString()} calls · {compact(m.input_tokens)} tokens in · {compact(m.output_tokens)} out · {usd(m.cost)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mb-1 mt-3 text-[12.5px] font-medium text-muted-foreground">Prices used for the estimates</div>
        <dl className="grid gap-x-8 gap-y-1.5 md:grid-cols-2">
          {r.rates.map((x) => (
            <div key={x.item} className="flex justify-between gap-4 border-b border-border/50 pb-1.5">
              <dt className="text-muted-foreground">{x.item}</dt>
              <dd className="text-right tabular-nums">{x.price}</dd>
            </div>
          ))}
        </dl>
      </details>
      <p className="text-[12px] text-muted-foreground">
        {fromBill ? "Totals are Google's bill, read from the billing export in BigQuery. " : ""}{ESTIMATE_NOTE}
        {r.run_costs && r.run_costs.estimated > 0 && ` ${r.run_costs.estimated} run${r.run_costs.estimated === 1 ? " is" : "s are"} still estimated.`}
      </p>
    </>
  );
}

export type Focus = { institution_id?: string; user_id?: string };
const pick = "h-9 w-full rounded-lg border border-input bg-card px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Every Run, AI call and import: the whole platform, one institution, or one person, with exact times, compute and cost.
 *  Counts and timings only; the operator can't open an institution's forecasts. */
export function RunsTab({ focus, onFocus }: { focus: Focus; onFocus: (f: Focus) => void }) {
  const [days, setDays] = useState(30);
  const insts = useQuery("admin:institutions", API.adminInstitutions, 15_000);
  const people = useQuery("admin:users", () => API.adminUsers(), 15_000);
  const key = `${days}:${focus.institution_id ?? ""}:${focus.user_id ?? ""}`;
  const report = useQuery(`admin:usage:${key}`, () => API.adminUsage(days, focus.institution_id, focus.user_id), 15_000);
  const runs = useQuery(`admin:runs:${key}`, () => API.adminRuns(days, focus.institution_id, focus.user_id), 15_000);
  const events = useQuery(`admin:events:${key}`, () => API.adminEvents(days, focus.institution_id, focus.user_id), 15_000);
  const staff = (people.data ?? []).filter((u) => !focus.institution_id || u.institution_id === focus.institution_id);
  const t = report.data?.totals;
  const rows = runs.data?.rows ?? [];
  const cpu = rows.reduce((s, r) => s + (r.cpu_seconds ?? 0), 0);
  const held = rows.reduce((s, r) => s + (r.seconds ?? 0) * r.vcpu, 0);
  if (runs.error) return <Failed error={runs.error} retry={runs.reload} />;
  return (
    <>
      <div className="surface flex flex-wrap items-end gap-3 p-4">
        <label className="min-w-[220px] flex-1 space-y-1 text-[12.5px] font-medium">
          Institution
          <select className={pick} value={focus.institution_id ?? ""} onChange={(e) => onFocus({ institution_id: e.target.value || undefined })}>
            <option value="">Every institution</option>
            {(insts.data ?? []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </label>
        <label className="min-w-[220px] flex-1 space-y-1 text-[12.5px] font-medium">
          Person
          <select className={pick} value={focus.user_id ?? ""} onChange={(e) => onFocus({ ...focus, user_id: e.target.value || undefined })}>
            <option value="">{focus.institution_id ? "Everyone in this institution" : "Everyone"}</option>
            {staff.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}{focus.institution_id ? "" : ` · ${u.institution}`}</option>)}
          </select>
        </label>
        <Segmented label="Period" value={days} onChange={setDays} options={RANGES} />
      </div>
      {t && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          <Kpi icon={Play} label="Forecasts" value={t.runs.toLocaleString()} note={`${t.done} finished · ${t.failed} failed · ${t.cancelled} stopped`} />
          <Kpi icon={Cpu} label="CPU time used" value={duration(cpu)} note={`${(held / 3600).toFixed(2)} vCPU-hours held while running`} />
          <Kpi icon={Server} label="Forecast compute" value={usd(t.run_cost)} note={`${duration(t.seconds)} of running`} />
          <Kpi icon={Sparkles} label="AI calls" value={t.ai_calls.toLocaleString()} note={`${compact(t.input_tokens + t.output_tokens)} tokens · ${usd(t.ai_cost)}`} />
          <Kpi icon={Upload} label="Imports" value={t.imports.toLocaleString()} note={`${compact(t.rows_imported)} rows · ${usd(t.import_cost)}`} />
          <Kpi icon={Wallet} label="Total" value={usd(t.total_cost)} note="measured use at Google's prices" />
        </div>
      )}
      <Activity runs={runs.data} events={events.data} showInstitution={!focus.institution_id} />
    </>
  );
}
