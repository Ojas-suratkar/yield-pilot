import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, ChevronDown, Flower2, GraduationCap, Leaf, Plus, Repeat, Snowflake, Sparkles, Sun, Users, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Input } from "@yield/core/ui/input";
import { Blocked, Failed, Label, Loading, NeedsData, NextBar, Page, Soft, Tile, ViewOnlyArea } from "../../components/ui";
import { API, type Group } from "../../lib/api";
import { termList, termName } from "../../lib/labels";
import { projectStore, Q, useProject, useProjectQuery, type Project } from "../../lib/project";

const int = (n: number) => n.toLocaleString();

/** Term statistics from the server (cached per data version, mapping and chosen term). */
function useTerms(p?: Project) {
  const { data, error, reload } = useProjectQuery(p, Q.terms, !!p?.dataset);
  const t = useMemo(() => (data ? { ...data, by: new Map(data.terms.map((e) => [e.code, e])) } : null), [data]);
  return { t, error, reload };
}

const setup = (patch: Project["setup"]) => projectStore.patch({ setup: patch }).catch((e) => toast.error((e as Error).message));

const SEASON: Record<string, { icon: typeof Leaf; tone: string }> = {
  fall: { icon: Leaf, tone: "bg-orange-500/10 text-orange-600" },
  spring: { icon: Flower2, tone: "bg-pink-500/10 text-pink-600" },
  summer: { icon: Sun, tone: "bg-amber-500/10 text-amber-600" },
  winter: { icon: Snowflake, tone: "bg-sky-500/10 text-sky-600" },
};
const seasonOf = (season?: string) => SEASON[season ?? ""] ?? SEASON.fall;

/** "Add a term" for predicting a term that isn't in the data yet; the server writes it in the data's own code style. */
function AddTerm({ p }: { p: Project }) {
  const [open, setOpen] = useState(false);
  const [season, setSeason] = useState("Fall");
  const [year, setYear] = useState(String(new Date().getFullYear() + 1));
  const add = async () => {
    try {
      projectStore.set(await API.addTerm(p.id, season, Number(year)));
      setOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-3 text-sm font-semibold text-muted-foreground transition-colors hover:border-primary hover:text-primary"
      >
        <Plus className="h-4 w-4" /> Add a term that isn't in your data
      </button>
    );
  return (
    <div className="rounded-2xl border-2 border-primary/40 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-semibold">Add a term</div>
        <button type="button" onClick={() => setOpen(false)} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Cancel">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={season}
          onChange={(e) => setSeason(e.target.value)}
          aria-label="Season"
          className="h-10 rounded-[var(--radius-input)] border border-input bg-background px-3 text-sm"
        >
          {["Fall", "Spring", "Summer", "Winter"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <Input value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" aria-label="Year" className="w-24" />
        <Button type="button" onClick={() => void add()}>
          Add
        </Button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- term */

export function TermPage() {
  const p = useProject();
  const { t, error, reload } = useTerms(p);
  const [older, setOlder] = useState(false);
  if (p && !p.dataset) return <NeedsData />;
  if (error) return <Failed error={error} retry={reload} />;
  if (!p || !t) return <Loading text="Reading the terms in your data…" />;
  const newest = [...t.terms].reverse().map((e) => e.code);
  const shown = older ? newest : newest.filter((x, i) => i < 7 || x === p.setup.term);
  const pick = (term: string) => setup({ term });

  return (
    <Page
      title="Which term are you predicting?"
      description="Choose the entry term for this yield forecast. Upcoming terms are forecasts; past terms let you check accuracy."
    >
      <ViewOnlyArea role="analyst">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4" role="radiogroup" aria-label="Entry term">
        {shown.map((term) => {
          const known = t.past.includes(term);
          const e = t.by.get(term);
          const S = seasonOf(e?.season);
          const on = p.setup.term === term;
          return (
            <button
              key={term}
              role="radio"
              aria-checked={on}
              onClick={() => pick(term)}
              className={cn("surface-btn group relative flex flex-col p-4", on && "surface-on")}
            >
              <div className="flex items-center justify-between">
                <span className={cn("grid h-9 w-9 place-items-center rounded-xl", S.tone)}>
                  <S.icon className="h-[18px] w-[18px]" />
                </span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                    !e?.admits || known ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary",
                  )}
                >
                  {!e?.admits ? "No data yet" : known ? "Outcomes known" : "Upcoming"}
                </span>
              </div>
              <div className={cn("mt-4 text-[18px] font-semibold tracking-[-0.02em]", on && "text-primary")}>{termName(term)}</div>
              <div className="mt-0.5 flex items-center justify-between gap-2 text-[12.5px] text-muted-foreground">
                <span>{e?.admits ? `${int(e.admits)} admits` : "Add your file later"}</span>
                {on && <span className="inline-flex items-center gap-1 font-semibold text-primary"><CheckCircle2 className="h-4 w-4" /> Selected</span>}
              </div>
            </button>
          );
        })}
        <div className="flex items-stretch [&>*]:w-full">
          <AddTerm p={p} />
        </div>
      </div>
      {newest.length > 7 && (
        <button onClick={() => setOlder(!older)} className="mt-4 flex items-center gap-1.5 text-[13px] font-semibold text-primary">
          <ChevronDown className={cn("h-4 w-4 transition-transform duration-200", older && "rotate-180")} />{" "}
          {older ? "Show fewer terms" : `Show ${newest.length - 7} earlier terms`}
        </button>
      )}
      </ViewOnlyArea>
      <NextBar onNext={() => (p.setup.term || !t.default_term ? undefined : setup({ term: t.default_term }))} />
    </Page>
  );
}

/* ---------------------------------------------------------------- group */

const GROUP_UI: { key: Group; title: string; text: string; icon: React.ReactNode }[] = [
  {
    key: "FTF",
    title: "First-Time Freshman",
    text: "First-year students entering college for the first time, usually straight from high school.",
    icon: <GraduationCap />,
  },
  { key: "TRN", title: "Transfer", text: "Students transferring in with credit from another college or university.", icon: <Repeat /> },
];

export function GroupPage() {
  const p = useProject();
  const { t, error, reload } = useTerms(p);
  if (p && !p.dataset) return <NeedsData />;
  if (error) return <Failed error={error} retry={reload} />;
  if (!p || !t) return <Loading />;
  const cur = p.setup.term ? t.by.get(p.setup.term) : undefined;
  const prior = t.prior_term ? t.by.get(t.prior_term) : undefined;
  const stat = (label: string, value: string) => (
    <span>
      <span className="block text-[12px] text-muted-foreground">{label}</span>
      <span className="mt-0.5 block text-[22px] font-semibold tracking-[-0.03em] tabular-nums">{value}</span>
    </span>
  );
  const rate = (o?: { known: number; enrolled: number }) => (o?.known ? `${((o.enrolled / o.known) * 100).toFixed(1)}%` : "–");
  const termLabel = cur ? termName(cur.code) : "this term";
  const priorLabel = prior ? termName(prior.code) : "last year";

  // Without a student-type column there is only one population: say so once, with the real numbers.
  if (!p.mapping.studentType) {
    const known = prior?.known ?? 0;
    const enrolled = Object.values(prior?.outcomes ?? {})[0]?.enrolled ?? 0;
    return (
      <Page title="Which student population are you forecasting?" description="Your data doesn't say which admits are first-time freshmen and which are transfers, so this forecast covers all admits together.">
        <div className="mx-auto w-full max-w-xl">
          <Tile on onClick={() => undefined} icon={<Users />} title="All admits" text="Every admitted student in the term, freshman and transfer together." className="p-6">
            <span className="mt-6 grid grid-cols-2 gap-3 border-t pt-5">
              {stat(`Admits, ${termLabel}`, cur?.admits ? int(cur.admits) : "–")}
              {stat(`Yield, ${priorLabel}`, known ? `${((enrolled / known) * 100).toFixed(1)}%` : "–")}
            </span>
          </Tile>
          <p className="mt-4 text-center text-[13px] text-muted-foreground">
            Have a column for student type? <Link to="/data/fields" className="font-medium text-primary hover:underline">Match it in Detected Fields</Link> to forecast freshmen and transfers separately.
          </p>
        </div>
        <NextBar />
      </Page>
    );
  }

  return (
    <Page title="Which student population are you forecasting?" description="First-time freshmen and transfers enroll at different rates, so each gets its own forecast.">
      <ViewOnlyArea role="analyst">
      <div className="mx-auto grid w-full max-w-4xl gap-5 md:grid-cols-2" role="radiogroup" aria-label="Student population">
        {GROUP_UI.map((g) => (
          <Tile key={g.key} on={p.setup.group === g.key} onClick={() => setup({ group: g.key })} icon={g.icon} title={g.title} text={g.text} className="p-6">
            <span className="mt-6 grid grid-cols-2 gap-3 border-t pt-5">
              {stat(`Admits, ${termLabel}`, cur?.groups[g.key] ? int(cur.groups[g.key]) : "–")}
              {stat(`Yield, ${priorLabel}`, rate(prior?.outcomes[g.key]))}
            </span>
          </Tile>
        ))}
      </div>
      </ViewOnlyArea>
      <NextBar onNext={() => (p.setup.group ? undefined : setup({ group: "FTF" }))} />
    </Page>
  );
}

/* ------------------------------------------------------------- training */

const SEASON_ORDER: Record<string, number> = { winter: 1, spring: 2, summer: 3, fall: 4 };

export function TrainingPage() {
  const p = useProject();
  const { t, error, reload } = useTerms(p);
  const [others, setOthers] = useState(false);
  if (p && !p.dataset) return <NeedsData />;
  if (error) return <Failed error={error} retry={reload} />;
  if (p && t && !p.setup.term)
    return <Blocked title="Pick a term first" text="Choose which entry term you're forecasting; training terms are recommended from it." cta="Pick term" to="/setup/term" />;
  if (!p || !t || !p.setup.term) return <Loading />;
  const term = p.setup.term;
  const chosen = p.setup.train_terms ?? [];
  const recommended = t.recommended_train_terms;
  const season = t.by.get(term)?.season;
  // only terms before the one being forecast: a model must never learn from the future or from the term it predicts
  const when = (code: string) => {
    const e = t.by.get(code);
    return e ? e.year * 10 + (SEASON_ORDER[e.season] ?? 0) : NaN;
  };
  const all = [...t.past].reverse().filter((x) => when(x) < when(term));
  const like = all.filter((x) => t.by.get(x)?.season === season);
  const rest = all.filter((x) => !like.includes(x));
  const options = [...like, ...rest.filter((x) => others || chosen.includes(x))];
  const order = (xs: string[]) => t.past.filter((x) => xs.includes(x));
  const toggle = (x: string) => setup({ train_terms: order(chosen.includes(x) ? chosen.filter((y) => y !== x) : [...chosen, x]) });
  const isRec = recommended.length === chosen.length && recommended.every((x) => chosen.includes(x));
  const group = GROUP_UI.find((g) => g.key === p.setup.group)?.title ?? "First-Time Freshman";
  const admits = chosen.reduce((a, x) => a + (t.by.get(x)?.admits ?? 0), 0);

  return (
    <Page
      title="Which terms should the model learn from?"
      description="Past terms with known outcomes teach the model how admits like yours behave."
      width="wide"
    >
      <ViewOnlyArea role="analyst">
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            {options.map((x) => {
              const on = chosen.includes(x);
              const S = seasonOf(t.by.get(x)?.season);
              return (
                <Tile
                  key={x}
                  multi
                  on={on}
                  onClick={() => toggle(x)}
                  className="p-4"
                  title={<span className="text-[17px] tracking-[-0.02em]">{termName(x)}</span>}
                  text={
                    <span className="flex items-center gap-2">
                      {int(t.by.get(x)?.admits ?? 0)} admits
                      {recommended.includes(x) && (
                        <span className="rounded-full bg-good/10 px-2 py-0.5 text-[10.5px] font-semibold text-good">Recommended</span>
                      )}
                    </span>
                  }
                  icon={<S.icon />}
                  iconTone={S.tone}
                />
              );
            })}
          </div>
          {!options.length && <p className="text-sm text-muted-foreground">There are no earlier terms with known outcomes before {termName(term)}.</p>}
          {rest.length > 0 && (
            <button onClick={() => setOthers(!others)} className="mt-4 flex items-center gap-1.5 text-[13px] font-semibold text-primary">
              <ChevronDown className={cn("h-4 w-4 transition-transform duration-200", others && "rotate-180")} />{" "}
              {others ? "Show comparable terms only" : `Show ${rest.length} other terms`}
            </button>
          )}
        </div>

        <Soft className="flex flex-col">
          <Label>Prediction summary</Label>
          <dl className="mt-4 space-y-3 text-[13.5px]">
            {[
              ["Forecasting", termName(term)],
              ["Population", group],
              ["Outcome", "Enrolled (yield)"],
              ["Learning from", chosen.length ? termList(chosen) : "No terms yet"],
              ["Past admits to learn from", admits ? int(admits) : "–"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="text-right font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-5 rounded-xl bg-primary/[0.06] p-4 text-[12.5px] leading-relaxed">
            <div className="mb-1 flex items-center gap-1.5 font-semibold text-primary">
              <Sparkles className="h-3.5 w-3.5" /> Recommended
            </div>
            The two most recent comparable terms ({termList(recommended) || "none yet"}) reflect your current admits best.
          </div>
          {!isRec && (
            <Button
              variant="outline"
              size="sm"
              className="mt-4 rounded-full"
              onClick={() => setup({ train_terms: recommended })}
            >
              <Sparkles /> Use recommended
            </Button>
          )}
        </Soft>
      </div>
      </ViewOnlyArea>
      <NextBar onNext={() => (chosen.length ? undefined : setup({ train_terms: recommended }))} />
    </Page>
  );
}
