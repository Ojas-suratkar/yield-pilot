import { useEffect, useState } from "react";
import { Check, CheckCircle2, ClipboardCheck, Loader2, RotateCcw, Sparkles, Undo2, Wrench } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Failed, Loading, NeedsData, NextBar, Page, ProgressBar, Ring, Soft } from "../../components/ui";
import { API, type Issue } from "../../lib/api";
import { projectStore, Q, useProject, useProjectQuery, type Project } from "../../lib/project";
import { useStep } from "../../lib/query";
import { can, useSession } from "../../lib/auth";

const useAudit = (p?: Project) => useProjectQuery(p, Q.audit, !!p?.dataset);
const usePlan = (p?: Project) => useProjectQuery(p, Q.plan, !!p?.dataset);

const markReviewed = () => projectStore.patch({ audit_reviewed: true });
const TONE = { high: "bg-destructive/10 text-destructive", medium: "bg-warn/15 text-warn", low: "bg-muted text-muted-foreground" };


/* ------------------------------------------------------------ readiness */

export function ReadinessPage() {
  const p = useProject();
  const { data: audit, error, reload } = useAudit(p);
  const { data: plan } = usePlan(p);
  const reviewing = useStep(p ? `plan:${p.id}` : null);
  if (p && !p.dataset) return <NeedsData />;
  if (error) return <Failed error={error} retry={reload} />;
  if (!p || !audit) return <Loading text="Checking your data…" />;
  const passed = audit.checks.filter((c) => c.status === "pass").length;
  const tone = audit.score >= 75 ? "good" : "warn";
  const issues = plan?.issues.length ?? 0;
  return (
    <Page title="Data Suitability Audit" description="How ready your data is for a yield forecast." width="wide">
      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <Soft className="flex flex-col items-center justify-center text-center">
          <Ring value={audit.score / 100} label={`${audit.score}%`} sub="Data Ready" size={148} color={`hsl(var(--${tone}))`} />
          <span
            className={cn(
              "mt-4 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-semibold",
              tone === "good" ? "bg-good/15 text-good" : "bg-warn/15 text-warn",
            )}
          >
            <CheckCircle2 className="h-4 w-4" /> {audit.status}
          </span>
          <div className="mt-4 grid w-full grid-cols-2 divide-x border-t pt-3">
            <div>
              <div className="font-display text-2xl font-extrabold">{passed}</div>
              <div className="text-xs text-muted-foreground">Passed checks</div>
            </div>
            <div>
              <div className="font-display text-2xl font-extrabold">{plan ? issues : "…"}</div>
              <div className="text-xs text-muted-foreground">Issues found</div>
            </div>
          </div>
        </Soft>
        <div className="flex flex-col gap-4">
          <ul className="grid gap-4 sm:grid-cols-2">
            {audit.checks.map((c) => (
              <li key={c.key} className="surface flex items-center gap-3.5 px-5 py-4">
                <span
                  className={cn(
                    "grid h-9 w-9 shrink-0 place-items-center rounded-full",
                    c.status === "pass" ? "bg-good/15 text-good" : c.status === "warn" ? "bg-warn/15 text-warn" : "bg-destructive/10 text-destructive",
                  )}
                >
                  {c.status === "pass" ? <CheckCircle2 className="h-5 w-5" /> : <Wrench className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-semibold">{c.title}</div>
                  <div className="text-[12.5px] text-muted-foreground">{c.detail}</div>
                </div>
                <span className="font-display text-base font-bold tabular-nums">{c.value}</span>
              </li>
            ))}
          </ul>
          <Soft className="flex gap-3">
            <ClipboardCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div className="text-[13.5px] leading-relaxed">
              <div className="font-semibold">Review</div>
              {plan ? <p className="text-muted-foreground">{plan.summary}</p> : <ProgressBar className="mt-2" step={reviewing} />}
            </div>
          </Soft>
        </div>
      </div>
      <NextBar
        label={issues ? `Next: Review ${issues} recommended ${issues === 1 ? "fix" : "fixes"}` : "Continue to Prediction Setup"}
        to={issues || !plan ? undefined : "/setup/term"}
        onNext={() => (issues || !plan ? undefined : markReviewed())}
      />
    </Page>
  );
}

/* ---------------------------------------------------------------- fixes */

function describe(i: Issue) {
  const cols = i.columns?.length ? i.columns.join(", ") : i.column;
  if (i.op === "recode_values" && i.pairs?.length)
    return `${cols}: ${i.pairs
      .slice(0, 4)
      .map((x) => `“${x.from}” → “${x.to}”`)
      .join(", ")}${i.pairs.length > 4 ? ` and ${i.pairs.length - 4} more` : ""}`;
  const verbs: Record<string, string> = {
    fill_missing: `Fill blanks in ${cols} (${i.strategy === "value" ? `“${i.value}”` : i.strategy ?? "most common value"})`,
    trim_whitespace: `Trim stray spaces${cols ? ` in ${cols}` : ""}`,
    to_number: `Keep only valid numbers in ${cols}`,
    drop_columns: `Remove ${cols}`,
    drop_duplicates: `Keep one row per ${cols || "student and term"}`,
    drop_rows: `Remove rows where ${cols} is ${(i.values ?? []).map((v) => `“${v || "blank"}”`).join(" or ")}`,
    clip_range: `Limit ${cols} to its valid range`,
    change_case: `Use consistent capitalization in ${cols}`,
  };
  return verbs[i.op] ?? i.title;
}

export function FixesPage() {
  const p = useProject();
  const { data: audit } = useAudit(p);
  const { data: plan, error, reload } = usePlan(p);
  const canFix = can(useSession().me, "data_manager");
  const reviewing = useStep(p ? `plan:${p.id}` : null);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (plan) setChosen(new Set(plan.issues.filter((i) => i.severity !== "low").map((i) => i.id)));
  }, [plan]);
  if (p && !p.dataset) return <NeedsData />;
  if (!p || !audit) return <Loading text="Checking your data…" />;
  const apply = async () => {
    if (!chosen?.size) return;
    setBusy(true);
    try {
      const out = projectStore.set(await API.fix(p.id, [...chosen]));
      toast.success(`Applied ${chosen.size} ${chosen.size === 1 ? "fix" : "fixes"}: saved as version ${out.dataset?.version}`, {
        action: { label: "Undo", onClick: () => void API.undo(p.id).then(projectStore.set) },
      });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) =>
    setChosen((s) => {
      const x = new Set(s);
      if (x.has(id)) x.delete(id);
      else x.add(id);
      return x;
    });

  return (
    <Page
      title="Recommended Fixes"
      description="Problems found in your data, and how to fix each. Applied fixes save a new version you can undo."
      width="wide"
      mode="top"
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div>
          {!plan && !error && (
            <Soft>
              <div className="mb-3 text-[14px] font-semibold">Reviewing your data</div>
              <ProgressBar step={reviewing} />
            </Soft>
          )}
          {error && (
            <Soft className="text-sm text-muted-foreground">
              {error}{" "}
              <Button variant="link" className="h-auto p-0" onClick={() => void reload()}>
                Try again
              </Button>
            </Soft>
          )}
          {plan && !plan.issues.length && (
            <Soft className="flex items-center gap-4">
              <span className="grid h-12 w-12 place-items-center rounded-full bg-good/15 text-good">
                <Sparkles className="h-6 w-6" />
              </span>
              <div>
                <div className="text-lg font-semibold">Looks good!</div>
                <p className="text-muted-foreground">No problems found that would affect your forecast.</p>
              </div>
            </Soft>
          )}
          {plan && plan.issues.length > 0 && (
            <ul className="space-y-3">
              {plan.issues.map((i) => {
                const on = !!chosen?.has(i.id);
                return (
                  <li key={i.id}>
                    <button
                      onClick={() => toggle(i.id)}
                      className={cn("surface-btn flex w-full gap-4 p-5 text-left", on && "surface-on")}
                      role="checkbox"
                      aria-checked={on}
                    >
                      <span
                        className={cn(
                          "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border-2 transition-colors",
                          on ? "border-primary bg-primary text-primary-foreground" : "border-input",
                        )}
                      >
                        {on && <Check className="h-3 w-3" strokeWidth={3.5} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-[14.5px] font-semibold">{i.title}</span>
                          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize", TONE[i.severity])}>{i.severity}</span>
                        </span>
                        <span className="mt-1 block text-[13px] leading-relaxed text-muted-foreground">{i.explanation}</span>
                        <span className="mt-1 block text-[12.5px] leading-relaxed">
                          <b className="font-medium">Why it matters:</b> <span className="text-muted-foreground">{i.impact}</span>
                        </span>
                        <span className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1 text-[12px] font-medium">
                          <Wrench className="h-3.5 w-3.5 text-primary" /> {describe(i)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <Soft className="flex flex-col items-center self-start text-center">
          <Ring
            value={audit.score / 100}
            label={`${audit.score}%`}
            sub="Data Ready"
            size={120}
            stroke={10}
            color={`hsl(var(--${audit.score >= 75 ? "good" : "warn"}))`}
          />
          <div className="mt-4 text-[14px] font-semibold">
            {plan ? `${chosen?.size ?? 0} of ${plan.issues.length} fixes selected` : "Reviewing…"}
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
            Fixes create a new version of your data. Your original stays untouched, and you can undo.
          </p>
          {plan && plan.issues.length > 0 && canFix && (
            <Button className="mt-4 w-full rounded-full" disabled={busy || !chosen?.size} onClick={() => void apply()}>
              {busy ? <Loader2 className="animate-spin" /> : <Wrench />} Apply selected fixes
            </Button>
          )}
          {p.dataset?.parent_version != null && canFix && (
            <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => void API.undo(p.id).then(projectStore.set)}>
              <Undo2 /> Undo last change
            </Button>
          )}
          {p.fixes_applied.length > 0 && (
            <div className="mt-4 w-full border-t pt-3 text-left">
              <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-muted-foreground">
                <RotateCcw className="h-3.5 w-3.5" /> Applied so far
              </div>
              <ul className="space-y-1 text-[12.5px]">
                {p.fixes_applied.slice(-6).map((f, n) => (
                  <li key={n} className="flex gap-1.5">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" /> {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Soft>
      </div>
      <NextBar onNext={markReviewed} />
    </Page>
  );
}
