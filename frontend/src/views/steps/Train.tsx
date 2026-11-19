import { useEffect } from "react";
import { Link } from "react-router-dom";
import { BarChart3, Check, CheckCircle2, Database, Loader2, Play, Square, Target, Users } from "lucide-react";
import { cn } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Loading, NeedsData, NextBar, Page, ProgressBar, Ring, Soft } from "../../components/ui";
import { API } from "../../lib/api";
import { useQuery } from "../../lib/query";
import { termList, termName } from "../../lib/labels";
import { cancelRun, groupLabel, runNow, useProject, useRunner } from "../../lib/project";
import { can, useSession } from "../../lib/auth";

// `from`: where each step starts on the server's progress scale (learning fills most of the bar).
const PROGRESS = [
  { t: "Prepare data", d: "Gather this term's admits and the past terms to learn from.", from: 0 },
  { t: "Learn from past terms", d: "See which kinds of admits enrolled in past terms, giving recent terms more weight.", from: 3.5 },
  { t: "Project this term", d: "Estimate each admit's chance of enrolling, and keep each college in line with its recent yield.", from: 88 },
  { t: "Save", d: "Save the forecast and get your what-if scenarios ready.", from: 95 },
];

/* --------------------------------------------------------------- review */

export function ReviewPage() {
  const p = useProject();
  if (p && !p.dataset) return <NeedsData />;
  if (!p) return <Loading />;
  const group = groupLabel(p);
  const train = p.setup.train_terms ?? [];
  const nf = p.features.selected?.length ?? 0;
  const rows: { icon: typeof Database; title: string; main: string; sub: string; to: string }[] = [
    {
      icon: Database,
      title: "Data",
      main: p.dataset ? `${p.dataset.filename} · v${p.dataset.version}` : "Your admissions data",
      sub: p.dataset ? `${p.dataset.rows.toLocaleString()} rows, ${p.dataset.columns.length} columns` : "Historical admissions data",
      to: "/data/upload",
    },
    { icon: Users, title: "Student Population", main: group, sub: p.setup.term ? termName(p.setup.term) : "", to: "/setup/group" },
    {
      icon: Target,
      title: "Training Terms",
      main: termList(train) || "Recommended terms",
      sub: "Outcome: Enrolled (admit-to-enroll yield)",
      to: "/setup/training",
    },
    { icon: BarChart3, title: "Features", main: nf ? `${nf} features` : "Recommended features", sub: "The student information you chose", to: "/features/more" },
  ];
  const checks = [
    { t: "Enough historical data", d: `${train.length || 2} past terms to learn from`, ok: !train.length || train.length >= 2 },
    { t: "Key features included", d: `${nf || "Recommended"} features`, ok: !nf || nf >= 4 },
    { t: "No critical issues", d: "Your data is ready for modeling", ok: (p.audit?.score ?? 80) >= 60 },
  ];
  const ready = Math.round((checks.filter((c) => c.ok).length / 3) * 40 + (p.audit?.score ?? 80) * 0.6);

  return (
    <Page title="Review your prediction setup" description="Here's what YieldPilot will use. Edit anything before you run.">
      <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
        <ul className="grid content-start gap-3 sm:grid-cols-2">
          {rows.map((r) => (
            <li key={r.title} className="flex items-start gap-3 surface p-4">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <r.icon className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[11.5px] font-medium text-muted-foreground">{r.title}</div>
                <div className="truncate text-[14px] font-semibold">{r.main}</div>
                {r.sub && <div className="truncate text-[12.5px] text-muted-foreground">{r.sub}</div>}
              </div>
              <Link to={r.to} className="text-[13px] font-semibold text-primary hover:underline">
                Edit
              </Link>
            </li>
          ))}
        </ul>
        <Soft className="flex flex-col items-center text-center">
          <div className="self-start text-[13px] font-semibold">Model Readiness</div>
          <Ring value={ready / 100} label={`${ready}%`} sub="Ready" size={112} stroke={10} />
          <ul className="mt-4 w-full space-y-2.5 text-left">
            {checks.map((c) => (
              <li key={c.t} className="flex gap-2.5">
                <CheckCircle2 className={cn("mt-0.5 h-4 w-4 shrink-0", c.ok ? "text-good" : "text-warn")} />
                <div>
                  <div className="text-[13px] font-medium">{c.t}</div>
                  <div className="text-[12px] text-muted-foreground">{c.d}</div>
                </div>
              </li>
            ))}
          </ul>
        </Soft>
      </div>
      <NextBar label="Next: Run prediction" />
    </Page>
  );
}

/* ------------------------------------------------------------------ run */

export function RunPage() {
  const p = useProject();
  const r = useRunner();
  const canRun = can(useSession().me, "analyst");
  const quota = useQuery(canRun ? "quota" : null, API.quota, 0);
  useEffect(() => {
    if (!r.running) void quota.reload();
  }, [r.running]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = quota.data;
  const overMine = !!q?.enforced && q.runs_limit_me != null && q.runs_used_me >= q.runs_limit_me;
  const overAll = !!q?.enforced && q.runs_limit != null && q.runs_used >= q.runs_limit;
  const outOfRuns = overMine || overAll;
  if (p && !p.dataset) return <NeedsData />;
  if (!p) return <Loading />;
  const s = p.forecast?.summary;
  const mine = r.running && r.project === p.id;
  const done = !!s && !p.stale && !mine;
  const pct = done ? 100 : mine ? (r.step?.pct ?? 0) : -1;

  return (
    <Page
      title={done ? "Your yield forecast is ready" : "Run your yield prediction"}
      description={done ? "Everything ran smoothly. See your results next." : "One click. YieldPilot learns from past terms and forecasts this one."}
    >
      <div className="grid gap-3 lg:grid-cols-[1fr_1fr]">
        <Soft className="flex flex-col items-center justify-center py-10 text-center">
          <span
            className={cn(
              "grid h-16 w-16 place-items-center rounded-full transition-colors duration-300",
              done ? "bg-good/15 text-good" : "bg-primary/10 text-primary",
            )}
          >
            {mine ? <Loader2 className="h-8 w-8 animate-spin" /> : done ? <Check className="h-8 w-8" strokeWidth={3} /> : <Play className="h-8 w-8" />}
          </span>
          {done ? (
            <>
              <div className="mt-5 grid w-full max-w-sm grid-cols-3 divide-x rounded-xl border">
                {[
                  ["Admits", s!.admits.toLocaleString()],
                  ["Proj. Enrolled", Math.round(s!.expected).toLocaleString()],
                  ["Yield %", `${(s!.yield * 100).toFixed(1)}%`],
                ].map(([k, v]) => (
                  <div key={k} className="py-3">
                    <div className="font-display text-xl font-extrabold tabular-nums">{v}</div>
                    <div className="text-[11.5px] text-muted-foreground">{k}</div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[13px] text-muted-foreground">{termName(s!.target_term)} forecast · likely between {Math.round(s!.range[0]).toLocaleString()} and {Math.round(s!.range[1]).toLocaleString()}</p>
              {canRun && (
                <>
                  <Button variant="outline" className="mt-5 rounded-full" disabled={r.running || outOfRuns} onClick={() => void runNow()}>
                    <Play /> Run again
                  </Button>
                  <p className="mt-1.5 text-[12px] text-muted-foreground">Trains the model again from scratch.</p>
                </>
              )}
            </>
          ) : (
            <>
              {mine ? (
                <>
                  <ProgressBar className="mt-6 max-w-sm text-left" step={r.step} />
                  <Button variant="outline" className="mt-4 rounded-full" onClick={cancelRun}>
                    <Square className="h-3.5 w-3.5" /> Cancel
                  </Button>
                </>
              ) : !canRun ? (
                <p className="mt-6 text-[13px] text-muted-foreground">Only an analyst, data manager, admin or owner can run a forecast.</p>
              ) : (
                <Button size="lg" className="mt-6 h-12 rounded-full px-8 text-[15px]" disabled={r.running || outOfRuns} onClick={() => void runNow()}>
                  <Play /> Run Prediction
                </Button>
              )}
              {r.running && !mine && <p className="mt-3 text-[12.5px] text-muted-foreground">Another prediction is running. Wait for it to finish or cancel it there.</p>}
            </>
          )}
          {canRun && q?.enforced && (q.runs_limit_me != null || q.runs_limit != null) && (
            <p className={cn("mt-3 text-[12.5px]", outOfRuns ? "font-medium text-destructive" : "text-muted-foreground")}>
              {outOfRuns
                ? `${overMine ? `You've used all ${q.runs_limit_me} of your runs` : `Your workspace has used all ${q.runs_limit} runs`} this month. Runs reset on the 1st, or an owner can upgrade in Billing.`
                : `You've used ${q.runs_used_me}${q.runs_limit_me != null ? ` of ${q.runs_limit_me}` : ""} runs this month. Workspace: ${q.runs_used}${q.runs_limit != null ? ` of ${q.runs_limit}` : ""}.`}
            </p>
          )}
          {r.error && <p className="mt-5 max-w-md rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{r.error}</p>}
        </Soft>

        <Soft>
          <div className="mb-4 text-[13px] font-semibold">Prediction Progress</div>
          <ol className="space-y-4">
            {PROGRESS.map((x, i) => {
              const next = PROGRESS[i + 1]?.from ?? 100;
              const st = pct >= next ? "done" : pct >= x.from ? "now" : "todo";
              return (
                <li key={x.t} className="flex gap-3">
                  <span
                    className={cn(
                      "grid h-8 w-8 shrink-0 place-items-center rounded-full text-[13px] font-bold transition-colors duration-300",
                      st === "done" ? "bg-good text-white" : st === "now" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {st === "done" ? <Check className="h-4 w-4" strokeWidth={3} /> : st === "now" ? <Loader2 className="h-4 w-4 animate-spin" /> : i + 1}
                  </span>
                  <div>
                    <div className={cn("text-[13.5px] font-semibold", st === "todo" && "text-muted-foreground")}>{x.t}</div>
                    <div className="text-[12.5px] text-muted-foreground">{x.d}</div>
                  </div>
                </li>
              );
            })}
          </ol>
        </Soft>
      </div>
      <NextBar label="See Results" />
    </Page>
  );
}
