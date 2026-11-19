import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, FileClock, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { cn, fmtDate, fmtDateTime } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Textarea } from "@yield/core/ui/input";
import { ConfirmDelete, Failed, Loading, NeedsForecast, Page, Soft, SortTh, TableSearch, useTable } from "../../components/ui";
import { Logo } from "../../components/Logo";
import { DownloadMenu, groupName, ShareButton, YieldChat } from "../../components/ReportTools";
import { API, type Summary } from "../../lib/api";
import { setQuery } from "../../lib/query";
import { friendly, termList, termName } from "../../lib/labels";
import { projectStore, Q, useProject, useProjectQuery, type Project } from "../../lib/project";
import { can, useSession } from "../../lib/auth";

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const int = (n: number) => Math.round(n).toLocaleString();

const Actions = ({ p }: { p: Project }) => (
  <>
    <DownloadMenu p={p} />
    <ShareButton p={p} />
  </>
);

/* --------------------------------------------------------------- summary */

export function SummaryPage() {
  const p = useProject();
  const fid = p?.forecast?.id;
  const cached = useProjectQuery(fid, Q.summary);
  const [edit, setEdit] = useState<{ fid: string; text: string } | null>(null);
  const summary = edit && edit.fid === fid ? edit.text : (cached.data?.text ?? null);
  const setSummary = (text: string) => fid && setEdit({ fid, text });
  if (p && !p.forecast) return <NeedsForecast />;
  if (cached.error) return <Failed error={cached.error} retry={cached.reload} />;
  if (!p?.forecast || summary === null) return <Loading text="Writing your executive summary…" />;
  const r = p.forecast.summary;
  const save = (text = summary) =>
    API.saveSummary(fid!, text)
      .then((x) => setQuery(Q.summary(fid!)[0], x))
      .catch((e) => toast.error((e as Error).message));

  const kpis = [
    ["Admits", int(r.admits)],
    ["Proj. Enrolled", int(r.expected)],
    ["Projected Yield", pct(r.yield)],
    ["Prior-Year Yield", r.prior ? pct(r.prior.yield) : "–"],
    ["Confidence", r.confidence],
  ];

  return (
    <Page
      title="Executive Summary"
      description={`${termName(r.target_term)} ${groupName(p).toLowerCase()} yield forecast. Edit the summary or ask YieldPilot a question.`}
      width="wide"
      mode="fill"
      actions={<Actions p={p} />}
    >
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="grid grid-cols-5 gap-3">
            {kpis.map(([k, v]) => (
              <Soft key={k} className="px-4 py-3.5">
                <div className="truncate text-[11.5px] font-medium text-muted-foreground">{k}</div>
                <div className="mt-1 text-[20px] font-semibold tracking-[-0.03em] tabular-nums">{v}</div>
              </Soft>
            ))}
          </div>
          <Soft className="flex flex-1 flex-col p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[13px] font-semibold">Summary</div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() =>
                  API.summary(fid!, true)
                    .then((x) => {
                      setQuery(Q.summary(fid!)[0], x);
                      setEdit(null);
                      toast.success("Summary regenerated");
                    })
                    .catch((e) => toast.error((e as Error).message))
                }
              >
                <RotateCcw /> Regenerate
              </Button>
            </div>
            <Textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              onBlur={() => void save()}
              className="min-h-[200px] flex-1 resize-none border-0 bg-muted/40 p-3 text-[14px] leading-relaxed focus-visible:ring-1"
              aria-label="Executive summary"
            />
          </Soft>
          <Soft className="p-4">
            <div className="mb-2 text-[13px] font-semibold">What influences enrollment most</div>
            <ol className="grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
              {r.drivers.slice(0, 6).map((d, i) => (
                <li key={d.feature} className="flex items-center gap-2">
                  <span className="w-4 text-muted-foreground tabular-nums">{i + 1}.</span>
                  <span className="flex-1 truncate">{friendly(d.feature)}</span>
                  <span className="font-semibold tabular-nums">{Math.round(d.share * 100)}%</span>
                </li>
              ))}
            </ol>
          </Soft>
        </div>
        <YieldChat
          p={p}
          className="min-h-[420px]"
          onUse={(text) => {
            const t = `${summary.trim()}\n\n${text}`;
            setSummary(t);
            void save(t);
            toast.success("Added to summary");
          }}
        />
      </div>
    </Page>
  );
}

/* --------------------------------------------------------------- history */

export function HistoryPage() {
  const p = useProject();
  const nav = useNavigate();
  const { me } = useSession();
  const { data: runs, error, reload } = useProjectQuery(me?.institution?.id, Q.allForecasts, true, 15_000);
  const setRuns = () => void reload();
  const guest = me?.role === "guest";
  const [tab, setTab] = useState<"all" | "mine">("all");
  const rows = (runs ?? []).filter((x) => tab === "all" || x.mine).map((x) => ({ ...x, termName: termName(x.term), runner: x.mine ? "You" : (x.run_by ?? "") }));
  const t = useTable(rows, { key: "created_at", desc: true }, (x) => `${x.termName} ${x.group} ${x.project} ${x.runner} ${x.shared_by ?? ""}`);
  if (error) return <Failed error={error} retry={reload} />;
  if (!runs || (!p && !guest)) return <Loading />;
  const mineCount = runs.filter((x) => x.mine).length;

  return (
    <Page
      title="Report History"
      description={guest ? `Reports ${me?.institution?.name} shared with you, view only.` : `Every forecast run in ${me?.institution?.name}'s shared workspace, with who ran it.`}
      width="wide"
      mode="top"
      actions={p?.forecast && !guest && <Actions p={p} />}
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        {!guest && (
          <div className="flex rounded-full border bg-card p-1 text-[12.5px]">
            {(["all", "mine"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={cn("rounded-full px-3 py-1.5 font-medium", tab === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {k === "all" ? `Everyone (${runs.length})` : `Run by me (${mineCount})`}
              </button>
            ))}
          </div>
        )}
        <TableSearch value={t.q} onChange={t.setQ} placeholder="Filter reports" className="ml-auto" />
      </div>
      {t.shown.length ? (
        <div className="overflow-x-auto rounded-xl border border-border/60 bg-card">
          <table className="w-full text-[13px]">
            <thead className="bg-muted/40 text-left text-[11.5px] font-semibold text-muted-foreground">
              <tr>
                <SortTh label="Forecast" k="termName" sort={t.sort} onSort={t.setSort} className="px-3.5 py-2.5" />
                <SortTh label="Created" k="created_at" sort={t.sort} onSort={t.setSort} className="px-3.5 py-2.5" />
                <SortTh label="Admits" k="admits" sort={t.sort} onSort={t.setSort} className="px-3.5 py-2.5" />
                <SortTh label="Proj. Enrolled" k="expected" sort={t.sort} onSort={t.setSort} className="px-3.5 py-2.5" />
                <SortTh label="Proj. Yield" k="yield" sort={t.sort} onSort={t.setSort} className="px-3.5 py-2.5" />
                <th className="whitespace-nowrap px-3.5 py-2.5">Learned from</th>
                <SortTh label="Run by" k="runner" sort={t.sort} onSort={t.setSort} className="px-3.5 py-2.5" />
                {!guest && <SortTh label="Shared" k="shares" sort={t.sort} onSort={t.setSort} className="px-3.5 py-2.5" />}
                <th className="px-3.5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {t.shown.map((x) => {
                const live = x.current && x.project_id === p?.id;
                const sub = "block text-[11.5px] text-muted-foreground";
                return (
                  <tr key={x.id} className={cn("align-top transition-colors hover:bg-muted/40", live && "bg-primary/[0.03]")}>
                    <td className="px-3.5 py-2.5">
                      <span className="font-semibold">{termName(x.term)}</span>
                      {live && <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10.5px] font-semibold text-primary">Current</span>}
                      {x.is_production && <span className="ml-2 rounded-full bg-good/10 px-2 py-0.5 text-[10.5px] font-semibold text-good">Official</span>}
                      <span className={sub}>
                        {x.group} · {x.project}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3.5 py-2.5">
                      {fmtDate(x.created_at)}
                      <span className={sub}>{new Date(x.created_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
                    </td>
                    <td className="px-3.5 py-2.5 tabular-nums">{int(x.admits)}</td>
                    <td className="px-3.5 py-2.5 tabular-nums">{int(x.expected)}</td>
                    <td className="whitespace-nowrap px-3.5 py-2.5 tabular-nums">
                      <span className="font-semibold">{pct(x.yield)}</span>
                      <span className={sub}>{x.prior_yield != null ? `Prior year ${pct(x.prior_yield)}` : "No prior term"}</span>
                    </td>
                    <td className="max-w-[240px] px-3.5 py-2.5">
                      <span className="block truncate">Admits from {termList(x.train_terms)}</span>
                      <span className={cn(sub, "truncate")}>{x.features} pieces of information</span>
                    </td>
                    <td className="whitespace-nowrap px-3.5 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="grid h-5 w-5 place-items-center rounded-full bg-secondary text-[9.5px] font-semibold uppercase">{(x.mine ? me?.name ?? "Y" : x.run_by ?? "?").slice(0, 2)}</span>
                        {x.runner || "A colleague"}
                      </span>
                      {x.shared_by && <span className={sub}>Shared with you by {x.shared_by}</span>}
                    </td>
                    {!guest && (
                      <td className="whitespace-nowrap px-3.5 py-2.5">
                        {x.shares ? `${x.shares} ${x.shares === 1 ? "time" : "times"}` : <span className="text-muted-foreground">Not shared</span>}
                      </td>
                    )}
                    <td className="whitespace-nowrap px-3.5 py-2">
                      <div className="flex flex-col items-end gap-1">
                      {guest && (
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => nav(`/shared/${x.id}`)}>
                          <ExternalLink /> Open
                        </Button>
                      )}
                      {!guest && can(me, "data_manager") && !x.is_production && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() =>
                            API.promote(x.id)
                              .then(() => projectStore.refresh())
                              .then(setRuns)
                              .then(() => toast.success(`${termName(x.term)} forecast marked official`))
                              .catch((e) => toast.error((e as Error).message))
                          }
                        >
                          Mark official
                        </Button>
                      )}
                      {!guest && !live && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() =>
                            !can(me, "analyst") ? nav(`/shared/${x.id}`) :
                            API.openForecast(x.project_id, x.id)
                              .then((np) => {
                                projectStore.set(np);
                                toast.success(`Opened ${termName(x.term)} forecast`);
                                nav("/results/forecast");
                              })
                              .catch((e) => toast.error((e as Error).message))
                          }
                        >
                          <ExternalLink /> Open
                        </Button>
                      )}
                      {x.manage && can(me, "analyst") && (
                        <ConfirmDelete
                          confirm={x.shares ? "Delete for everyone" : "Delete report"}
                          onConfirm={async () => {
                            await API.deleteForecast(x.id);
                            if (x.project_id === p?.id) await projectStore.refresh();
                            setRuns();
                            toast.success(`Deleted the ${termName(x.term)} report`);
                          }}
                        />
                      )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Soft className="flex flex-col items-center py-14 text-center">
          <FileClock className="h-8 w-8 text-muted-foreground" />
          <p className="mt-3 font-semibold">{t.q ? "No reports match" : guest ? "Nothing shared with you yet" : "No reports yet"}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {guest ? "Reports shared with you appear here, view only." : "Each forecast anyone in your institution runs appears here, with who ran it."}
          </p>
          {!guest && can(me, "analyst") && !t.q && (
            <Button size="sm" className="mt-4 rounded-full" onClick={() => nav("/train/run")}>
              Run a prediction
            </Button>
          )}
        </Soft>
      )}
    </Page>
  );
}

/* ----------------------------------------------------------------- print */

/** The printable report (opened in a new tab from Download). */
export function PrintPage() {
  const p = useProject();
  const [text, setText] = useState<string | null>(null);
  const fid = p?.forecast?.id;
  useEffect(() => {
    const want = new URLSearchParams(location.search).get("project");
    if (want && projectStore.get()?.id !== want) void projectStore.open(want);
  }, []);
  useEffect(() => {
    if (!fid) return;
    API.summary(fid)
      .then((x) => setText(x.text))
      .catch(() => setText(""));
  }, [fid]);
  useEffect(() => {
    if (text === null) return;
    const t = setTimeout(() => window.print(), 600);
    return () => clearTimeout(t);
  }, [text]);
  if (!p?.forecast || text === null) return <p className="p-10">Preparing the report…</p>;
  return <ReportDoc r={p.forecast.summary} group={groupName(p)} created={p.forecast.created_at} text={text} />;
}

/** The report itself: the printable PDF, and what someone a report was shared with sees. */
function ReportDoc({ r, group, created, text, by }: { r: Summary; group: string; created: string; text: string; by?: string | null }) {
  return (
    <article className="mx-auto max-w-3xl space-y-8 bg-white p-10 text-[#1e293b]">
      <header className="flex items-start justify-between border-b pb-6">
        <div>
          <div className="text-sm text-slate-500">{group} admits</div>
          <h1 className="font-display text-3xl font-extrabold">{termName(r.target_term)} Yield Forecast</h1>
          <div className="mt-1 text-sm text-slate-500">
            Prepared {fmtDateTime(created)}
            {by ? ` by ${by}` : ""}
          </div>
        </div>
        <Logo tagline={false} />
      </header>
      <section className="grid grid-cols-4 gap-3">
        {[
          ["Admits", int(r.admits)],
          ["Proj. Enrolled", int(r.expected)],
          ["Projected Yield", pct(r.yield)],
          [r.actual ? "Actual Enrolled" : "Prior-Year Yield", r.actual ? int(r.actual.enrolled) : r.prior ? pct(r.prior.yield) : "–"],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border p-4">
            <div className="text-xs text-slate-500">{k}</div>
            <div className="mt-1 font-display text-2xl font-extrabold">{v}</div>
          </div>
        ))}
      </section>
      <section>
        <h2 className="mb-2 text-lg font-bold">Executive Summary</h2>
        <p className="whitespace-pre-line leading-relaxed">{text}</p>
      </section>
      <section>
        <h2 className="mb-2 text-lg font-bold">What Influences Enrollment Most</h2>
        <ol className="space-y-1 text-sm">
          {r.drivers.slice(0, 5).map((d, i) => (
            <li key={d.feature}>
              {i + 1}. {friendly(d.feature)} ({Math.round(d.share * 100)}%)
            </li>
          ))}
        </ol>
      </section>
      {r.by_college.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-bold">By College</h2>
          <table className="w-full text-sm">
            <thead className="border-b text-left text-slate-500">
              <tr>
                <th className="py-1.5">College</th>
                <th className="py-1.5 text-right">Admits</th>
                <th className="py-1.5 text-right">Projected enrolled</th>
                <th className="py-1.5 text-right">Projected yield</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {r.by_college.map((c) => (
                <tr key={c.college}>
                  <td className="py-1.5">{c.college}</td>
                  <td className="py-1.5 text-right tabular-nums">{int(c.admits)}</td>
                  <td className="py-1.5 text-right tabular-nums">{int(c.expected)}</td>
                  <td className="py-1.5 text-right tabular-nums">{pct(c.yield)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <section className="grid grid-cols-3 gap-4 text-sm">
        <div>High likelihood (≥ 70%): {int(r.segments.high.n)}</div>
        <div>Medium likelihood (40–69%): {int(r.segments.medium.n)}</div>
        <div>Low likelihood (&lt; 40%): {int(r.segments.low.n)}</div>
      </section>
      <footer className="border-t pt-4 text-xs text-slate-500">Projections, not guarantees. Prepared with YieldPilot.</footer>
    </article>
  );
}

/** A report someone shared with you: view only. It disappears for everyone if its owner deletes it. */
export function SharedReportPage() {
  const fid = location.pathname.split("/").pop() ?? "";
  const [data, setData] = useState<{ info: Awaited<ReturnType<typeof API.forecastInfo>>; text: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    Promise.all([API.forecastInfo(fid), API.summary(fid)])
      .then(([info, s]) => setData({ info, text: s.text }))
      .catch(() => setError("This report isn't available. It may have been deleted by the person who shared it."));
  }, [fid]);
  if (error)
    return (
      <Soft className="mx-auto mt-16 max-w-md text-center">
        <FileClock className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-3 text-sm text-muted-foreground">{error}</p>
      </Soft>
    );
  if (!data) return <Loading text="Opening the report…" />;
  return (
    <div className="overflow-y-auto py-6">
      <div className="mx-auto mb-3 flex max-w-3xl items-center justify-between px-2 text-[13px] text-muted-foreground">
        <span>{data.info.member ? `Run by ${data.info.by ?? "a colleague"}` : `Shared with you${data.info.by ? ` by ${data.info.by}` : ""} · view only`}</span>
        <Button variant="outline" size="sm" className="rounded-full" onClick={() => window.print()}>
          Download PDF
        </Button>
      </div>
      <div className="surface mx-auto max-w-3xl overflow-hidden">
        <ReportDoc r={data.info.summary} group={data.info.group} created={data.info.created_at} text={data.text} by={data.info.owned ? null : data.info.by} />
      </div>
    </div>
  );
}
