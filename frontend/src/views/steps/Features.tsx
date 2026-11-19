import { useMemo, useState } from "react";
import { BookOpen, Check, ClipboardList, HeartHandshake, MapPin, Minus, Plus, Search, ShieldCheck, Shapes, Wallet } from "lucide-react";
import { Button } from "@yield/core/ui/button";
import { Input } from "@yield/core/ui/input";
import { toast } from "sonner";
import { cn } from "@yield/core";
import { Failed, Loading, NeedsData, NextBar, Page } from "../../components/ui";
import type { FeatureProfile } from "../../lib/api";
import { friendly, termName } from "../../lib/labels";
import { groupLabel, projectStore, Q, useProject, useProjectQuery, type Project } from "../../lib/project";
import { can, useSession } from "../../lib/auth";

type Category = string;
const num = (n?: number | null) => (n == null ? "–" : Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : String(+n.toFixed(2)));
const fmtRange = (f: FeatureProfile) =>
  f.kind === "number" ? `${num(f.min)} to ${num(f.max)}` : (f.top ?? []).slice(0, 3).map((t) => t.value).join(", ");

/* Mockup groups, and which detailed categories fall into each. */
const GROUPS_UI: { title: string; text: string; icon: typeof BookOpen; cats: Category[]; color: string }[] = [
  { title: "Academic", text: "Grades, scores and programs", icon: BookOpen, cats: ["Academic"], color: "--c-data" },
  { title: "Admissions", text: "How and when they applied", icon: ClipboardList, cats: ["Application"], color: "--c-train" },
  { title: "Financial aid", text: "Aid and scholarships offered", icon: Wallet, cats: ["Financial aid"], color: "--c-results" },
  { title: "Engagement", text: "Visits, events and housing interest", icon: HeartHandshake, cats: ["Engagement", "Housing"], color: "--c-features" },
  { title: "Background", text: "Where students come from", icon: MapPin, cats: ["Location & residency", "Demographic"], color: "--c-scenarios" },
  { title: "Other", text: "Everything else", icon: Shapes, cats: ["Other"], color: "--c-audit" },
];
const groupOf = (f: FeatureProfile) => GROUPS_UI.find((g) => g.cats.includes(f.category)) ?? GROUPS_UI[GROUPS_UI.length - 1];

/** Column profiles and the AI's starting set, computed by the server from the current data version (cached). */
function useFeatures(p?: Project) {
  const { data, error, reload } = useProjectQuery(p, Q.features, !!p?.dataset);
  const profiles = useMemo(() => [...(data?.profiles ?? [])].sort((a, b) => b.relevance - a.relevance), [data]);
  return { ready: !!data, error, reload, profiles, picks: data?.recommended ?? [], usable: profiles.filter((f) => !f.excluded) };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** One plain sentence anyone can read: which way the data points, with the two enrollment rates behind it. */
function plain(f: FeatureProfile): string {
  const label = friendly(f.name);
  const name = /^[A-Z]{2,}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
  if (f.kind === "number" && f.bins && f.bins.length >= 2) {
    const lo = f.bins[0];
    const hi = f.bins[f.bins.length - 1];
    if (Math.abs(hi.rate - lo.rate) < 0.02) return `About the same enrollment at every level of ${name} (${pct(lo.rate)}–${pct(hi.rate)}).`;
    return hi.rate > lo.rate
      ? `Higher ${name} → more likely to enroll: ${pct(hi.rate)} vs ${pct(lo.rate)}.`
      : `Lower ${name} → more likely to enroll: ${pct(lo.rate)} vs ${pct(hi.rate)}.`;
  }
  const rated = (f.top ?? []).filter((t) => t.rate != null && t.count >= 20);
  if (rated.length >= 2) {
    const sorted = [...rated].sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0));
    return `${sorted[0].value}: ${pct(sorted[0].rate!)} enrolled · ${sorted[sorted.length - 1].value}: ${pct(sorted[sorted.length - 1].rate!)}.`;
  }
  return f.insight || "Not enough past outcomes to compare.";
}

const IMPACT: Record<string, { word: string; cls: string }> = {
  High: { word: "Strong", cls: "bg-[hsl(var(--c-results)/0.12)] text-[hsl(var(--c-results))]" },
  Medium: { word: "Moderate", cls: "bg-[hsl(var(--c-data)/0.12)] text-[hsl(var(--c-data))]" },
  Low: { word: "Some", cls: "bg-[hsl(var(--c-features)/0.14)] text-[hsl(var(--c-features))]" },
  "Very low": { word: "Little", cls: "bg-muted text-muted-foreground" },
};

function toggle(name: string) {
  const sel = projectStore.get()?.features.selected ?? [];
  projectStore
    .patch({ features: { selected: sel.includes(name) ? sel.filter((s) => s !== name) : [...sel, name] } })
    .catch((e) => toast.error((e as Error).message));
}

/* ---------------------------------------------------------- the card */

/** One piece of information: what it is, what the data shows, how much it matters, and one button. */
function FeatureCard({ f, on, recommended }: { f: FeatureProfile; on: boolean; recommended: boolean }) {
  const g = groupOf(f);
  const canEdit = can(useSession().me, "analyst");
  const impact = IMPACT[f.strength] ?? IMPACT.Low;
  return (
    <div
      className={cn("surface flex flex-col p-4 transition-shadow", on && "ring-1")}
      style={on ? { borderColor: `hsl(var(${g.color}) / 0.45)`, boxShadow: `0 0 0 1px hsl(var(${g.color}) / 0.25), var(--shadow-card)` } : undefined}
    >
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg" style={{ background: `hsl(var(${g.color}) / 0.12)`, color: `hsl(var(${g.color}))` }}>
          <g.icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-semibold leading-tight">{friendly(f.name)}</div>
          <div className="mt-0.5 text-[11.5px] text-muted-foreground">
            {g.title}
            {recommended && <span className="text-primary"> · Recommended</span>}
          </div>
        </div>
        <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold", impact.cls)} title="How much this separates who enrolls from who doesn't">
          {impact.word}
        </span>
      </div>
      <p className="mt-3 flex-1 text-[13px] leading-snug text-foreground/80">{plain(f)}</p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[11.5px] text-muted-foreground">{f.missing_pct ? `${f.missing_pct}% blank` : ""}</span>
        <button
          onClick={() => toggle(f.name)}
          disabled={!canEdit}
          className={cn(
            "disabled:pointer-events-none group inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-semibold transition-colors",
            on ? "bg-primary/10 text-primary hover:bg-destructive/10 hover:text-destructive" : "border border-input bg-card text-foreground hover:border-primary hover:text-primary",
          )}
          aria-pressed={on}
        >
          {on ? (
            <>
              <Check className="h-3.5 w-3.5 group-hover:hidden" strokeWidth={3} />
              <Minus className="hidden h-3.5 w-3.5 group-hover:block" strokeWidth={3} />
              <span className="group-hover:hidden">Included</span>
              <span className="hidden group-hover:inline">Remove</span>
            </>
          ) : (
            <>
              <Plus className="h-3.5 w-3.5" strokeWidth={3} /> Add
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function Summary({ p, f, sel }: { p: Project; f: ReturnType<typeof useFeatures>; sel: Set<string> }) {
  const isRec = f.picks.length === sel.size && f.picks.every((x) => sel.has(x));
  const canEdit = can(useSession().me, "analyst");
  return (
    <div className="surface mb-5 flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
      <div>
        <div className="text-[26px] font-semibold leading-none tabular-nums">{sel.size}</div>
        <div className="mt-1 text-[12px] text-muted-foreground">of {f.usable.length} included</div>
      </div>
      {sel.size === 0 && (
        <p className="w-full rounded-lg bg-destructive/[0.06] px-3 py-2 text-[13px] text-destructive">
          Nothing is included. Add at least one item, or use our recommendation, so the forecast has something to learn from.
        </p>
      )}
      <div className="min-w-[220px] flex-1">
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${(sel.size / Math.max(1, f.usable.length)) * 100}%` }} />
        </div>
        <div className="mt-1.5 text-[12.5px] text-muted-foreground">
          {isRec ? "Using our recommendation." : "Your own selection."} {p.setup.term ? `Forecasting ${termName(p.setup.term)} · ${groupLabel(p)}.` : ""}
        </div>
      </div>
      {!isRec && canEdit && (
        <Button variant="outline" size="sm" className="rounded-full" onClick={() => projectStore.patch({ features: { selected: f.picks } }).catch((e) => toast.error((e as Error).message))}>
          Use our recommendation
        </Button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- recommended */

export function StarterPage() {
  const p = useProject();
  const f = useFeatures(p);
  if (p && !p.dataset) return <NeedsData />;
  if (f.error) return <Failed error={f.error} retry={f.reload} />;
  if (!p || !f.ready) return <Loading text="Comparing each column with past enrollment…" />;
  const sel = new Set(p.features.selected ?? []);
  const starters = f.picks.map((n) => f.profiles.find((x) => x.name === n)!).filter(Boolean);
  const aside = f.profiles.filter((x) => x.excluded);
  return (
    <Page
      title="Recommended information"
      description="These made the biggest difference to who enrolled in your past terms. They're all included; remove any you don't want."
      width="wide"
      mode="top"
    >
      <Summary p={p} f={f} sel={sel} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {starters.map((x) => (
          <FeatureCard key={x.name} f={x} on={sel.has(x.name)} recommended />
        ))}
      </div>
      {aside.length > 0 && (
        <details className="mt-5 text-[13px]">
          <summary className="cursor-pointer select-none text-muted-foreground">
            <ShieldCheck className="mr-1.5 inline h-4 w-4 text-good" />
            {aside.length} {aside.length === 1 ? "column is" : "columns are"} left out on purpose. See why
          </summary>
          <ul className="surface mt-2 divide-y px-4">
            {aside.map((x) => (
              <li key={x.name} className="flex justify-between gap-4 py-2">
                <span>{friendly(x.name)}</span>
                <span className="text-muted-foreground">{x.excluded}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <NextBar label="Next: See everything else" disabled={!p.features.selected?.length} />
    </Page>
  );
}

/* ------------------------------------------------------------------ all */

export function MorePage() {
  const p = useProject();
  const f = useFeatures(p);
  const [q, setQ] = useState("");
  const [show, setShow] = useState<"all" | "in" | "out">("all");
  if (p && !p.dataset) return <NeedsData />;
  if (f.error) return <Failed error={f.error} retry={f.reload} />;
  if (!p || !f.ready) return <Loading text="Comparing each column with past enrollment…" />;
  const sel = new Set(p.features.selected ?? []);
  const match = (x: FeatureProfile) =>
    (!q || `${friendly(x.name)} ${x.name}`.toLowerCase().includes(q.toLowerCase())) && (show === "all" || (show === "in") === sel.has(x.name));
  const groups = GROUPS_UI.map((g) => ({ ...g, all: f.usable.filter((x) => groupOf(x) === g) }))
    .map((g) => ({ ...g, list: g.all.filter(match) }))
    .filter((g) => g.list.length);
  return (
    <Page title="Add or remove information" description="Everything in your data that can help. Add what you want the forecast to use." width="wide" mode="top">
      <Summary p={p} f={f} sel={sel} />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search information" className="h-10 rounded-full pl-9" />
        </div>
        <div className="flex gap-1.5">
          {(
            [
              ["all", `All (${f.usable.length})`],
              ["in", `Included (${sel.size})`],
              ["out", `Not included (${f.usable.length - sel.size})`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setShow(k)}
              className={cn(
                "h-9 rounded-full border px-3.5 text-[12.5px] font-medium transition-colors",
                show === k ? "border-primary/40 bg-primary/10 text-primary" : "bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-7">
        {groups.map((g) => (
          <section key={g.title}>
            <div className="mb-3 flex items-center gap-2.5">
              <span className="grid h-7 w-7 place-items-center rounded-lg" style={{ background: `hsl(var(${g.color}) / 0.12)`, color: `hsl(var(${g.color}))` }}>
                <g.icon className="h-4 w-4" />
              </span>
              <h2 className="text-[15px] font-semibold">{g.title}</h2>
              <span className="text-[12.5px] text-muted-foreground">
                {g.text} · {g.all.filter((x) => sel.has(x.name)).length} of {g.all.length} included
              </span>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {g.list.map((x) => (
                <FeatureCard key={x.name} f={x} on={sel.has(x.name)} recommended={f.picks.includes(x.name)} />
              ))}
            </div>
          </section>
        ))}
        {!groups.length && <p className="surface px-4 py-10 text-center text-[13px] text-muted-foreground">Nothing matches.</p>}
      </div>
      <p className="mt-6 text-[12.5px] leading-relaxed text-muted-foreground">
        What changes when you add or remove information: mostly <b className="font-medium text-foreground">which admits</b> look likely to enroll, and how
        accurate that is. The overall yield stays close to recent years unless this year's admits differ from past ones.
      </p>
      <NextBar disabled={!p.features.selected?.length} onNext={() => projectStore.patch({ features: { confirmed: true } })} />
    </Page>
  );
}
