import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarClock, DollarSign, GraduationCap, Home, Megaphone, RotateCcw, Sliders } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Slider } from "@yield/core/ui/slider";
import { Failed, Loading, NeedsForecast, NextBar, Page, Soft } from "../../components/ui";
import { DownloadMenu, ShareButton } from "../../components/ReportTools";
import { API, type Lever } from "../../lib/api";
import { termName } from "../../lib/labels";
import { projectStore, Q, useProject, useProjectQuery, useRunner, type Project } from "../../lib/project";

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const int = (n: number) => Math.round(n).toLocaleString();
const pp = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n * 100).toFixed(1)} pp`;

const ICON = (l: Lever) =>
  /aid|scholar|grant|award/i.test(l.feature)
    ? DollarSign
    : /days|speed/i.test(l.feature)
      ? CalendarClock
      : /housing/i.test(l.feature)
        ? Home
        : /visit|orientation/i.test(l.feature)
          ? GraduationCap
          : Megaphone;

const KEY = "yp-scenario";
const readValues = (): Record<string, number> => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
};

/** Levers come from the forecast's model on the server (cached per forecast); each scenario is re-scored there too. */
function useLevers(p?: Project) {
  const { data } = useProjectQuery(p?.forecast?.id, Q.levers);
  useEffect(() => {
    if (p?.forecast && !p.scenarios_seen) void projectStore.patch({ scenarios_seen: true }).catch(() => undefined);
  }, [p]);
  return data;
}

/** Strategies suggested from this data's levers; every number is the forecast model's projection, not a guess. */
function Suggestions({ fid, onApply }: { fid: string; onApply: (v: Record<string, number>) => void }) {
  const { data, error } = useProjectQuery(fid, Q.ideas);
  if (error) return null;
  return (
    <section className="mb-6">
      <div className="mb-2.5 flex items-baseline justify-between">
        <h2 className="text-[14.5px] font-semibold">Suggested strategies</h2>
        <span className="text-[12px] text-muted-foreground">Projected with your forecast model</span>
      </div>
      {!data ? (
        <div className="grid gap-3 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="surface h-[150px] animate-pulse bg-muted/40" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          {data.scenarios.map((sc) => (
            <div key={sc.title} className="surface flex flex-col p-4">
              <div className="text-[14px] font-semibold">{sc.title}</div>
              <p className="mt-1 flex-1 text-[12.5px] leading-snug text-muted-foreground">{sc.rationale}</p>
              <div className="mt-3 flex items-end justify-between gap-3 border-t pt-3">
                <div>
                  <div className={cn("text-[20px] font-semibold tabular-nums", sc.gain >= 0 ? "text-good" : "text-destructive")}>
                    {sc.gain >= 0 ? "+" : ""}
                    {int(sc.gain)}
                  </div>
                  <div className="text-[11.5px] text-muted-foreground">
                    enrolled · {pct(sc.yield)} yield
                  </div>
                </div>
                <Button size="sm" variant="outline" className="rounded-full" onClick={() => onApply(sc.values)}>
                  Try this
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- adjust */

export function AdjustPage() {
  const p = useProject();
  const runner = useRunner();
  const levers = useLevers(p);
  const [values, setValues] = useState<Record<string, number>>(readValues);
  const [total, setTotal] = useState<number | null>(null);
  const fid = p?.forecast?.id;
  const key = JSON.stringify(values);
  useEffect(() => {
    if (!fid) return;
    const t = setTimeout(
      () =>
        API.scenario(fid, values)
          .then((x) => setTotal(x.expected))
          .catch((e) => (setTotal(null), toast.error((e as Error).message))),
      150,
    );
    return () => clearTimeout(t);
  }, [fid, key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (p && !p.forecast && !runner.running) return <NeedsForecast />;
  if (!p?.forecast || !levers) return <Loading text="Getting your forecast ready…" />;
  const r = p.forecast.summary;
  const scen = total ?? r.expected;
  const gain = scen - r.expected;
  const set = (f: string, v: number) =>
    setValues((s) => {
      const next = { ...s, [f]: v };
      sessionStorage.setItem(KEY, JSON.stringify(next));
      return next;
    });

  const scenYield = scen / r.admits;
  const bar = (label: string, n: number, cls: string) => (
    <div>
      <div className="flex justify-between text-[12.5px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums">{int(n)} enrolled</span>
      </div>
      <div className="mt-1.5 h-3 rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-[width] duration-300 ease-out", cls)}
          style={{ width: `${Math.min(100, (n / Math.max(scen, r.expected) / 1.05) * 100)}%` }}
        />
      </div>
    </div>
  );

  return (
    <Page
      title="What-if scenarios"
      description="Move a lever to see how an enrollment strategy could change projected enrolled and yield."
      width="wide"
      actions={
        <>
          <DownloadMenu p={p} />
          <ShareButton p={p} />
        </>
      }
    >
      {levers.length > 0 && (
        <Suggestions
          fid={p.forecast.id}
          onApply={(v) => {
            setValues(v);
            try {
              sessionStorage.setItem(KEY, JSON.stringify(v));
            } catch {
              /* storage blocked */
            }
          }}
        />
      )}
      {levers.length ? (
        <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-[14.5px] font-semibold">
                <Sliders className="h-4 w-4 text-primary" /> Levers
              </div>
              <button
                onClick={() => {
                  setValues({});
                  sessionStorage.removeItem(KEY);
                }}
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Reset to baseline
              </button>
            </div>
            <ul className="grid gap-4 md:grid-cols-2">
              {levers.map((l) => {
                const Icon = ICON(l);
                const v = values[l.feature] ?? 0;
                return (
                  <li key={l.feature} className={cn("surface p-5 transition-colors duration-200", v !== 0 && "border-primary/40")}>
                    <div className="flex items-start gap-3">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                        <Icon className="h-5 w-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[14.5px] font-semibold">{l.label}</div>
                        <span
                          className={cn(
                            "mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                            l.actionable ? "bg-good/10 text-good" : "bg-secondary text-muted-foreground",
                          )}
                        >
                          {l.actionable ? "An action you can take" : "Who you admit"}
                        </span>
                        <p className="mt-1 text-[12.5px] leading-snug text-muted-foreground">{l.hint}</p>
                      </div>
                      <span
                        className={cn(
                          "rounded-full px-2.5 py-0.5 text-[12.5px] font-semibold tabular-nums",
                          v > 0 ? "bg-good/12 text-good" : v < 0 ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
                        )}
                      >
                        {v === 0
                          ? "No change"
                          : l.kind === "pct"
                            ? `${v > 0 ? "+" : ""}${v}%`
                            : l.kind === "count"
                              ? `+1 for ${v}% of admits`
                              : `${v > 0 ? "+" : ""}${v}% of admits`}
                      </span>
                    </div>
                    <Slider
                      className="mt-5"
                      min={l.min}
                      max={l.max}
                      step={l.step}
                      value={[v]}
                      onValueChange={([x]) => set(l.feature, x)}
                      aria-label={l.label}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
          <Soft className="flex flex-col">
            <div className="text-[14.5px] font-semibold">Projected results</div>
            <div className="text-[12.5px] text-muted-foreground">
              {termName(r.target_term)} · {int(r.admits)} admits
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-muted/60 p-4">
                <div className="text-[12px] text-muted-foreground">Baseline yield</div>
                <div className="mt-0.5 text-[24px] font-semibold tracking-[-0.03em] tabular-nums">{pct(r.yield)}</div>
              </div>
              <div className={cn("rounded-xl p-4 transition-colors", gain >= 0 ? "bg-good/10" : "bg-destructive/10")}>
                <div className="text-[12px] text-muted-foreground">Scenario yield</div>
                <div className={cn("mt-0.5 text-[24px] font-semibold tracking-[-0.03em] tabular-nums", gain >= 0 ? "text-good" : "text-destructive")}>
                  {pct(scenYield)}
                </div>
              </div>
            </div>
            <div className="mt-5 space-y-3">
              {bar("Baseline", r.expected, "bg-[var(--series-actual)]")}
              {bar("Scenario", scen, "bg-primary")}
            </div>
            <div className="mt-auto pt-5">
              <div className="rounded-xl bg-primary/[0.06] p-4">
                <div className="text-[12px] text-muted-foreground">Additional enrolled</div>
                <div className={cn("text-[32px] font-semibold tracking-[-0.03em] tabular-nums", gain >= 0 ? "text-good" : "text-destructive")}>
                  {gain >= 0 ? "+" : ""}
                  {int(gain)}
                </div>
                <div className="text-[12px] text-muted-foreground">
                  {Math.abs(gain) >= 1
                    ? `${gain >= 0 ? "+" : ""}${((gain / r.expected) * 100).toFixed(1)}% vs. baseline, ${pp(scenYield - r.yield)} yield`
                    : "Move a lever to see the effect"}
                </div>
              </div>
            </div>
          </Soft>
        </div>
      ) : (
        <Soft>
          <p className="text-muted-foreground">
            Your data doesn't include things a campus can easily change, like aid, outreach or housing, so there's nothing to adjust here. You can go straight
            to sharing your report.
          </p>
        </Soft>
      )}
      <NextBar />
    </Page>
  );
}

/* -------------------------------------------------------------- actions */

export function ActionsPage() {
  const p = useProject();
  useLevers(p);
  const nav = useNavigate();
  const runner = useRunner();
  const { data, error, reload } = useProjectQuery(p?.forecast?.id, Q.actions);
  const plans = useProjectQuery(p?.forecast?.id, Q.ideas).data?.plans ?? {};
  if (p && !p.forecast && !runner.running) return <NeedsForecast />;
  if (error) return <Failed error={error} retry={reload} />;
  if (!p?.forecast || !data) return <Loading text="Ranking strategies…" />;
  const r = p.forecast.summary;
  const ideas = data.actions;
  const combined = data.combined;
  const top = Math.max(...ideas.map((x) => x.lift), 1);

  return (
    <Page
      title="Recommended Actions"
      description="Strategies ranked by how many more admits they could bring to enrollment."
      width="wide"
      actions={
        <>
          <DownloadMenu p={p} />
          <ShareButton p={p} />
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        {ideas.length ? (
          <ol className="grid content-start gap-4 md:grid-cols-2">
            {ideas.map((x, i) => {
              const Icon = ICON(x);
              return (
                <li key={x.feature} className="surface flex flex-col p-5">
                  <div className="flex items-start gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                      <Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">#{i + 1}</div>
                      <div className="text-[14.5px] font-semibold leading-snug">{x.action}</div>
                    </div>
                  </div>
                  <p className="mt-2 flex-1 text-[12.5px] leading-relaxed text-muted-foreground">
                    {i === 0 && x.lift >= 1 ? "Largest projected impact on yield. " : ""}
                    {plans[x.feature] ?? x.hint}
                  </p>
                  <div className="mt-4 flex items-end gap-3">
                    <div className="flex-1">
                      <div className={cn("text-[22px] font-semibold tracking-[-0.03em] tabular-nums", x.lift >= 0 ? "text-good" : "text-muted-foreground")}>
                        {x.lift >= 0 ? "+" : ""}
                        {int(x.lift)} <span className="text-[12px] font-medium text-muted-foreground">enrolled</span>
                      </div>
                      <div className="mt-1.5 h-1.5 rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-good transition-[width] duration-500"
                          style={{ width: `${Math.max(3, (Math.max(0, x.lift) / top) * 100)}%` }}
                        />
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-full"
                      onClick={() => {
                        sessionStorage.setItem(KEY, JSON.stringify({ ...readValues(), [x.feature]: x.step }));
                        nav("/scenarios/adjust");
                      }}
                    >
                      Try it
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <Soft>
            <p className="text-muted-foreground">No actions to suggest for this data.</p>
          </Soft>
        )}
        <Soft className="flex flex-col">
          <div className="text-[14.5px] font-semibold">Combined potential</div>
          <div className="text-[12.5px] text-muted-foreground">If every positive action is applied together</div>
          <div className="mt-5 text-[40px] font-semibold leading-none tracking-[-0.04em] text-good tabular-nums">
            {combined >= 0 ? "+" : ""}
            {int(combined)}
          </div>
          <div className="mt-1 text-[13px] text-muted-foreground">additional enrolled</div>
          <div className="mt-5 grid grid-cols-2 gap-3 border-t pt-4 text-[13px]">
            <div>
              <div className="text-muted-foreground">Yield today</div>
              <div className="text-[18px] font-semibold tabular-nums">{pct(r.yield)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">With actions</div>
              <div className="text-[18px] font-semibold text-good tabular-nums">{pct((r.expected + combined) / r.admits)}</div>
            </div>
          </div>
          <p className="mt-auto pt-5 text-[12px] leading-relaxed text-muted-foreground">
            Each estimate is a 20% change in one lever on its own, based on how comparable admits responded in prior terms. Effects are not guaranteed.
          </p>
        </Soft>
      </div>
      <NextBar />
    </Page>
  );
}
