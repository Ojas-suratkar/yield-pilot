import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Cpu, Database, EyeOff, Target } from "lucide-react";
import { cn } from "@yield/core";
import { NeedsForecast, NextBar, Page, Soft, SortTh, TableSearch, useTable } from "../../components/ui";
import { friendly, termList, termName } from "../../lib/labels";
import { useProject } from "../../lib/project";
import type { Summary } from "../../lib/api";

const int = (n: number) => Math.round(n).toLocaleString();
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const axis = { stroke: "hsl(var(--muted-foreground))", fontSize: 11, tickLine: false, axisLine: false } as const;
const tip = { borderRadius: 12, border: "1px solid hsl(var(--border))", fontSize: 12 };

/** What the model learned from, what it predicted, how it is built, and how it scored once outcomes were known. */
export function ModelPage() {
  const p = useProject();
  if (!p?.forecast) return <NeedsForecast />;
  const r = p.forecast.summary;
  const m = r.model_info;
  const e = r.evaluation;
  if (!m)
    return (
      <Page title="Model details" description="Run the prediction again to see the details of the model behind it.">
        <NextBar />
      </Page>
    );
  const metrics: [string, string, string][] = e
    ? [
        ["ROC-AUC", e.roc_auc?.toFixed(3) ?? "–", "How well it ranks enrollers above non-enrollers (0.5 = chance, 1 = perfect)"],
        ["PR-AUC", e.pr_auc?.toFixed(3) ?? "–", "Ranking quality focused on the admits who enroll"],
        ["Brier score", e.brier.toFixed(4), "Average squared gap between likelihood and outcome (lower is better)"],
        ["Log loss", e.log_loss.toFixed(4), "Penalty for confident wrong likelihoods (lower is better)"],
        ["Accuracy", pct(e.accuracy), `Admits called correctly at the ${pct(e.threshold)} cut-off`],
        ["Precision", pct(e.precision), "Of admits called 'will enroll', the share who did"],
        ["Recall", pct(e.recall), "Of admits who enrolled, the share called 'will enroll'"],
        ["F1", e.f1.toFixed(3), "Balance of precision and recall"],
      ]
    : [];
  return (
    <Page
      title="Model details"
      description={`How the ${termName(r.target_term)} forecast was made, and how well it did once outcomes were known.`}
      width="wide"
      mode="top"
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <Soft className="p-5">
          <Head icon={Database} title="Learned from" />
          <Big value={int(m.train_rows)} label={`admits from ${termList(m.train_terms)}`} />
          <p className="mt-2 text-[13px] text-muted-foreground">
            {int(m.train_enrolled)} of them enrolled ({pct(m.train_enrolled / Math.max(1, m.train_rows))}). Recent terms count more (weight falls by{" "}
            {Math.round((1 - Math.exp(-m.recency_decay)) * 100)}% per year back).
          </p>
        </Soft>
        <Soft className="p-5">
          <Head icon={Target} title="Predicted" />
          <Big value={int(m.test_rows)} label={`${termName(m.test_term)} admits`} />
          <p className="mt-2 flex gap-1.5 text-[13px] text-muted-foreground">
            <EyeOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            The model sees these admits and their details, never whether they enrolled. Actual outcomes are only compared afterwards.
          </p>
        </Soft>
        <Soft className="p-5">
          <Head icon={Cpu} title="How it's built" />
          <ul className="mt-2 space-y-1 text-[13px]">
            <li>
              <b className="font-semibold">XGBoost</b>: {int(m.trees)} trees, depth {m.depth}, learning rate {m.learning_rate}
            </li>
            <li>{m.folds}-fold {m.calibration} calibration, so likelihoods read as real chances</li>
            <li>Each college kept in line with its recent yield ({Math.round((r.shrinkage?.alpha ?? 0.5) * 100)}% pull, {r.shrinkage?.min_cohort ?? 200}+ admits)</li>
            <li>Training rows ordered by {m.row_order}, as in the lab</li>
            <li className="text-muted-foreground">
              Recipe {m.recipe} · trained in {m.seconds.toFixed(1)} s
            </li>
          </ul>
        </Soft>
      </div>

      <Soft className="mt-4 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[14.5px] font-semibold">How it did on {termName(r.target_term)}</h2>
          {e && (
            <span className="text-[12.5px] text-muted-foreground">
              {int(e.admits)} admits with a recorded outcome · actual {int(e.actual_enrolled)}, forecast {int(e.predicted_enrolled)} ({e.error_pct > 0 ? "+" : "−"}
              {Math.abs(e.error_pct).toFixed(1)}%)
            </span>
          )}
        </div>
        {!e ? (
          <p className="mt-2 text-[13px] text-muted-foreground">
            {termName(r.target_term)} outcomes aren't in your data yet. These measures appear once they are; the model never uses them either way.
          </p>
        ) : (
          <div className="mt-4 grid gap-5 lg:grid-cols-[1fr_1fr]">
            <table className="w-full text-[13px]">
              <tbody className="divide-y">
                {metrics.map(([k, v, hint]) => (
                  <tr key={k}>
                    <td className="py-2 pr-3 font-medium">{k}</td>
                    <td className="py-2 pr-3 text-right font-semibold tabular-nums">{v}</td>
                    <td className="py-2 text-[12px] text-muted-foreground">{hint}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div>
              <div className="mb-1 text-[12.5px] font-medium">Predicted vs actual enrollment rate, by tenth of admits (least to most likely)</div>
              <div className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={e.calibration} margin={{ top: 6, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="bin" {...axis} />
                    <YAxis {...axis} width={44} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} />
                    <Tooltip contentStyle={tip} labelFormatter={(l: number) => `Tenth ${l} of 10`} formatter={(v: number, n: string) => [pct(v), n]} />
                    <Legend iconType="plainline" iconSize={14} wrapperStyle={{ fontSize: 12 }} />
                    <Line dataKey="predicted" name="Forecast" stroke="var(--series-ours)" strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3 }} isAnimationActive={false} />
                    <Line dataKey="actual" name="Actual" stroke="var(--series-actual)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}
      </Soft>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Soft className="p-5">
          <h2 className="text-[14.5px] font-semibold">Information used ({m.columns.length + 1})</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">Every column the model learned from, strongest influence first, plus the admit year.</p>
          <ul className="mt-3 space-y-1.5">
            {[...r.drivers, ...m.columns.filter((c) => !r.drivers.some((d) => d.feature === c)).map((c) => ({ feature: c, share: 0, direction: "mixed" as const }))].map(
              (d) => (
                <li key={d.feature} className="flex items-center gap-3 text-[13px]">
                  <span className="w-44 truncate" title={d.feature}>
                    {friendly(d.feature)}
                  </span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <span className="block h-full rounded-full bg-[var(--series-teal)]" style={{ width: `${d.share * 100}%` }} />
                  </span>
                  <span className="w-12 text-right tabular-nums text-muted-foreground">{d.share ? pct(d.share) : "<1%"}</span>
                </li>
              ),
            )}
          </ul>
          {m.excluded.length > 0 && (
            <div className="mt-4 border-t pt-3">
              <div className="text-[12.5px] font-semibold">Not used</div>
              <ul className="mt-1 space-y-0.5 text-[12.5px] text-muted-foreground">
                {m.excluded.map((x) => (
                  <li key={x.feature}>
                    <b className="font-medium text-foreground">{friendly(x.feature)}</b>: {x.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Soft>
        <Adjustments r={r} />
      </div>
      <NextBar />
    </Page>
  );
}

function Adjustments({ r }: { r: Summary }) {
  const rows = Object.entries(r.shrinkage?.ratios ?? {}).map(([college, ratio]) => ({ college, ratio, effect: ((ratio - 1) * (r.shrinkage?.alpha ?? 0.5)) }));
  const t = useTable(rows, { key: "effect", desc: true }, (x) => x.college);
  return (
    <Soft className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[14.5px] font-semibold">College adjustment</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">How much each college's forecast was nudged toward its recent yield.</p>
        </div>
        {rows.length > 6 && <TableSearch value={t.q} onChange={t.setQ} placeholder="Filter colleges" />}
      </div>
      {rows.length ? (
        <table className="mt-3 w-full text-[13px]">
          <thead className="border-b text-left text-[11.5px] font-semibold text-muted-foreground">
            <tr>
              <SortTh label="College" k="college" sort={t.sort} onSort={t.setSort} className="px-0 py-2" />
              <SortTh label="Adjustment" k="effect" sort={t.sort} onSort={t.setSort} className="px-0 py-2 text-right [&>button]:justify-end" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {t.shown.map((x) => (
              <tr key={x.college}>
                <td className="py-2">{x.college}</td>
                <td className={cn("py-2 text-right font-medium tabular-nums", x.effect > 0 ? "text-good" : x.effect < 0 ? "text-destructive" : "text-muted-foreground")}>
                  {x.effect > 0 ? "+" : ""}
                  {(x.effect * 100).toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-3 text-[13px] text-muted-foreground">No college column, so the whole class was adjusted together.</p>
      )}
    </Soft>
  );
}

function Head({ icon: Icon, title }: { icon: typeof Cpu; title: string }) {
  return (
    <div className="flex items-center gap-2 text-[12.5px] font-semibold text-muted-foreground">
      <Icon className="h-4 w-4 text-primary" /> {title}
    </div>
  );
}

function Big({ value, label }: { value: string; label: string }) {
  return (
    <div className="mt-2">
      <span className="text-[26px] font-semibold tracking-[-0.03em] tabular-nums">{value}</span>
      <span className="ml-2 text-[13px] text-muted-foreground">{label}</span>
    </div>
  );
}
