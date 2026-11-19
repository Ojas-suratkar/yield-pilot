import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, ArrowUpRight, Check, Database, FileClock, Plus, Sparkles } from "lucide-react";
import { API } from "../lib/api";
import { useQuery } from "../lib/query";
import { compact, duration, usd } from "./Usage";
import { cn, fmtDate } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Label, Ring, tone } from "../components/ui";
import { termName } from "../lib/labels";
import { can, useSession } from "../lib/auth";
import { toast } from "sonner";
import { Q, STEPS, currentStep, groupLabel, projectStore, stepDone, stepSection, useProject, useProjectQuery } from "../lib/project";

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const int = (n: number) => Math.round(n).toLocaleString();

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function HomePage() {
  const p = useProject();
  const { me } = useSession();
  const nav = useNavigate();
  const history = (useProjectQuery(me?.institution?.id, Q.allForecasts, true, 0).data ?? []).slice(0, 4); // everyone's latest runs
  const started = !!p?.dataset;
  const cur = currentStep(p);
  const done = STEPS.filter((s) => stepDone(p, s.step!)).length;
  const allDone = done === STEPS.length;
  const r = p?.forecast?.summary;
  const group = groupLabel(p);
  const name = p?.setup.term ? `${termName(p.setup.term)} ${group}` : "your next intake";
  const newest = history[0]; // the newest run in the workspace, whichever prediction is open
  const latest = newest
    ? { ...newest, group: newest.project_id === p?.id ? group : newest.group, prior: newest.prior ?? null, here: newest.project_id === p?.id,
        by: newest.mine ? "you" : (newest.run_by ?? "a colleague"), at: newest.created_at as string | null }
    : r ? { term: r.target_term, group, applications: r.applications, admits: r.admits, expected: r.expected, range: r.range, yield: r.yield, prior: r.prior, here: true, by: null, at: null } : null;

  const scope = me?.role === "owner" ? "institution" : "me"; // only the owner sees the whole workspace's usage and costs
  const usage = useQuery(me && me.role !== "guest" ? `usage:${scope}:30` : null, () => API.usage(30, scope), 30_000).data?.totals;

  const go = () => nav(allDone ? "/results/forecast" : started ? stepSection(cur).subs[0].path : "/data/source");

  return (
    <div className="page-enter mx-auto flex min-h-full max-w-[1320px] flex-col gap-5 px-6 py-8 lg:px-10">
      {/* greeting */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[13px] text-muted-foreground">{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>
          <h1 className="mt-1 text-[28px] font-semibold tracking-[-0.035em]">
            {greeting()}
            {me?.name ? `, ${me.name.split(" ")[0]}` : ""}
          </h1>
          <p className="mt-1 text-[14px] text-muted-foreground">
            {allDone
              ? `Your ${name} forecast is complete. Review it or share it with your team.`
              : started
                ? `You're on Step ${cur} of 7 for ${name}.`
                : "Predict how many admitted students will enroll, in seven guided steps."}
          </p>
          {p?.owner?.name && (
            <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground">
              <span>
                Prediction by <b className="font-medium text-foreground">{p.owner.id === me?.id ? "you" : p.owner.name}</b>
              </span>
              {p.updated_by && <span>Last changed by {p.updated_by === (me?.name || me?.email) ? "you" : p.updated_by}</span>}
              {p.forecast?.run_by?.name && (
                <span>
                  Forecast run by {p.forecast.run_by.id === me?.id ? "you" : p.forecast.run_by.name} on {fmtDate(p.forecast.created_at)}
                </span>
              )}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {started && can(me, "analyst") && (
            <Button
              variant="outline"
              className="h-10 rounded-full"
              onClick={() =>
                projectStore
                  .startNew()
                  .then(() => nav("/data/source"))
                  .catch((e) => toast.error((e as Error).message))
              }
            >
              <Plus /> New prediction
            </Button>
          )}
          <Button className="group h-10 rounded-full px-5 shadow-[0_6px_16px_-6px_hsl(var(--primary)/0.6)]" onClick={go}>
            {allDone ? "Open yield dashboard" : started ? `Continue: ${stepSection(cur).title}` : "Start: Connect Data"}
            <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
          </Button>
        </div>
      </div>

      {/* workflow */}
      <section className="surface p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-semibold">Prediction workflow</h2>
            <p className="text-[13px] text-muted-foreground">Seven steps from your data to a yield forecast you can share.</p>
          </div>
          <div className="flex items-center gap-3 text-[13px]">
            <span className="font-medium tabular-nums">{done} of 7 complete</span>
            <span className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${(done / 7) * 100}%` }} />
            </span>
          </div>
        </div>
        <ol className="mt-6 grid grid-cols-2 gap-y-6 sm:grid-cols-4 lg:grid-cols-7">
          {STEPS.map((s, i) => {
            const ok = stepDone(p, s.step!);
            const here = !ok && cur === s.step;
            return (
              <li key={s.key} className="relative">
                {i > 0 && (
                  <span
                    className={cn("absolute top-[19px] hidden h-0.5 lg:block", ok || here ? "bg-primary/50" : "bg-border")}
                    style={{ left: "-50%", right: "50%" }}
                    aria-hidden
                  />
                )}
                <button onClick={() => nav(s.subs[0].path)} className="group relative flex w-full flex-col items-center px-2 text-center">
                  <span
                    className="relative z-10 grid h-10 w-10 place-items-center rounded-full border-2 text-[13px] font-semibold transition-all duration-200 group-hover:scale-105"
                    style={
                      ok
                        ? { borderColor: tone(s.key), background: tone(s.key), color: "white" }
                        : here
                          ? { borderColor: tone(s.key), background: "hsl(var(--card))", color: tone(s.key), boxShadow: `0 0 0 5px ${tone(s.key, 0.14)}` }
                          : { borderColor: tone(s.key, 0.35), background: tone(s.key, 0.08), color: tone(s.key) }
                    }
                  >
                    {ok ? <Check className="h-4 w-4" strokeWidth={3} /> : <s.icon className="h-[18px] w-[18px]" />}
                  </span>
                  <span className="mt-3 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">Step {s.step}</span>
                  <span className="mt-0.5 text-[13.5px] font-semibold leading-tight group-hover:text-primary">{s.title}</span>
                  <span className="mt-1 hidden text-[12px] leading-snug text-muted-foreground xl:block">{s.blurb}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </section>

      {/* overview */}
      <div className="grid flex-1 gap-5 lg:grid-cols-3 [&>section]:min-w-0">
        <section className="surface flex flex-col p-5">
          <div className="flex items-center justify-between">
            <Label>Latest forecast</Label>
            {latest && (
              <Link to={latest.here ? "/results/forecast" : "/reports/history"} className="flex items-center gap-1 text-[12.5px] font-medium text-primary hover:underline">
                Dashboard <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
          {latest ? (
            <>
              <div className="mt-1 text-[15px] font-semibold">
                {termName(latest.term)} · {latest.group}
              </div>
              <div className="mt-4 grid flex-1 grid-cols-2 gap-3">
                {([
                  ["Predicted yield", pct(latest.yield), latest.prior
                    ? `${latest.yield >= latest.prior.yield ? "▲" : "▼"} ${Math.abs((latest.yield - latest.prior.yield) * 100).toFixed(1)} points vs. last year` : "No earlier year to compare",
                    latest.prior ? (latest.yield >= latest.prior.yield ? "text-good" : "text-destructive") : ""],
                  ["Admits", int(latest.admits), latest.applications > latest.admits ? `from ${int(latest.applications)} applications` : "students in this forecast", ""],
                  ["Expected to enroll", int(latest.expected), latest.range ? `likely ${int(latest.range[0])} to ${int(latest.range[1])}` : "students", ""],
                  ["Prior-year yield", latest.prior ? pct(latest.prior.yield) : "–", latest.prior ? `${termName(latest.prior.term)}: ${int(latest.prior.enrolled)} of ${int(latest.prior.admits)}` : "Not available", ""],
                ] as [string, string, string, string][]).map(([k, v, note, color]) => (
                  <div key={k} className="rounded-xl bg-muted/60 px-3.5 py-3">
                    <div className="text-[12px] text-muted-foreground">{k}</div>
                    <div className="mt-0.5 text-[22px] font-semibold tracking-[-0.03em] tabular-nums">{v}</div>
                    <div className={cn("mt-0.5 text-[11.5px] font-medium", color || "text-muted-foreground")}>{note}</div>
                  </div>
                ))}
              </div>
              {latest.at && <p className="mt-3 text-[12.5px] text-muted-foreground">Run by {latest.by} on {fmtDate(latest.at)}</p>}
            </>
          ) : (
            <Empty icon={<Sparkles />} text="Your yield forecast appears here after Step 5." cta="Run a prediction" to="/train/review" />
          )}
        </section>

        <section className="surface flex flex-col p-5">
          <div className="flex items-center justify-between">
            <Label>Recent runs in {me?.institution?.name ?? "your workspace"}</Label>
            {history.length > 0 && (
              <Link to="/reports/history" className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[12.5px] font-medium text-primary hover:underline">
                View all <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
          {history.length ? (
            <ul className="mt-3 flex-1 divide-y">
              {history.map((h) => (
                <li key={h.id} className="flex items-center gap-3 py-2.5">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <FileClock className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium">
                      {termName(h.term)} · {h.group}
                    </div>
                    <div className="truncate text-[12px] text-muted-foreground">
                      {h.mine ? "You" : (h.run_by ?? "A colleague")} · {fmtDate(h.created_at)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[14px] font-semibold tabular-nums">{pct(h.yield)}</div>
                    <div className="text-[11.5px] text-muted-foreground">{int(h.expected)} enrolled</div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty icon={<FileClock />} text="Every forecast anyone in your institution runs is saved here, with who ran it." />
          )}
        </section>

        <section className="surface flex flex-col p-5">
          <Label>Your data</Label>
          {started ? (
            <>
              <div className="mt-3 flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
                  <Database className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-semibold">{p?.dataset?.filename}</div>
                  <div className="text-[12.5px] text-muted-foreground">
                    {int(p!.dataset!.rows)} rows · {p!.dataset!.columns.length} columns · v{p!.dataset!.version}
                  </div>
                </div>
              </div>
              <div className="mt-4 flex flex-1 items-center gap-4 rounded-xl bg-muted/60 p-4">
                <Ring value={(p?.audit?.score ?? 0) / 100} label={p?.audit ? `${p.audit.score}%` : "–"} size={76} stroke={8} color="hsl(var(--good))" />
                <div>
                  <div className="text-[13.5px] font-semibold">{p?.audit?.status ?? "Not checked yet"}</div>
                  <div className="text-[12.5px] text-muted-foreground">Data readiness for yield prediction</div>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <Button variant="outline" size="sm" className="rounded-full" onClick={() => nav("/data/upload")}>
                  Replace data
                </Button>
                <Button variant="ghost" size="sm" className="rounded-full" onClick={() => nav("/audit/readiness")}>
                  Check readiness
                </Button>
              </div>
            </>
          ) : (
            <Empty icon={<Database />} text="Upload a file or connect Databricks, Snowflake, BigQuery, SQL Server, Oracle, Slate or another system." cta="Connect data" to="/data/source" />
          )}
        </section>
      </div>

      {/* usage */}
      {usage && (
        <section className="surface p-5">
          <div className="flex items-center justify-between">
            <Label>{scope === "me" ? "Your last 30 days" : `${me?.institution?.name ?? "Your workspace"}, last 30 days`}</Label>
            <Link to="/usage" className="flex items-center gap-1 text-[12.5px] font-medium text-primary hover:underline">
              Usage and costs <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
            {[
              ["Forecasts run", usage.runs.toLocaleString()],
              ["Average time per forecast", usage.avg_seconds ? duration(usage.avg_seconds) : "–"],
              ["AI answers", usage.ai_calls.toLocaleString()],
              ["Rows imported", compact(usage.rows_imported)],
              ["Estimated cost", usd(usage.total_cost)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-xl bg-muted/60 px-3.5 py-3">
                <div className="text-[12px] text-muted-foreground">{k}</div>
                <div className="mt-0.5 text-[20px] font-semibold tracking-[-0.03em] tabular-nums">{v}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Empty({ icon, text, cta, to }: { icon: React.ReactNode; text: string; cta?: string; to?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-6 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-muted text-muted-foreground [&>svg]:h-5 [&>svg]:w-5">{icon}</span>
      <p className="mt-3 max-w-[240px] text-[13px] text-muted-foreground">{text}</p>
      {cta && to && (
        <Link to={to} className="mt-3 text-[13px] font-semibold text-primary hover:underline">
          {cta} →
        </Link>
      )}
    </div>
  );
}
