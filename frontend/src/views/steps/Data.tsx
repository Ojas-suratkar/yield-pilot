import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  CalendarRange,
  CheckCircle2,
  CheckSquare,
  Filter,
  Rows3,
  Shuffle,
  Square,
  CircleDashed,
  Database,
  FileSpreadsheet,
  History,
  FileUp,
  Home,
  Loader2,
  ShieldCheck,
  Search,
  ListChecks,
  Trash2,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { cn, fmtDate } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Input } from "@yield/core/ui/input";
import { Label as FieldLabel } from "@yield/core/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@yield/core/ui/select";
import { Blocked, ConfirmDelete, Label, Loading, NextBar, Page, ProgressBar, Soft, Tile, ViewOnlyArea } from "../../components/ui";
import { can, useSession } from "../../lib/auth";
import { useQuery } from "../../lib/query";
import { DataGrid } from "../../components/DataGrid";
import { API, uploadToProject, type Conn, type Connector, type ConnectorField, type FieldKey, type Project, finishUpload, overPlan, type OverPlan, type Keep, type TrimMode, type TrimSummary } from "../../lib/api";
import { FIELDS, friendly, termName } from "../../lib/labels";
import { projectStore, useProject } from "../../lib/project";
import type { Step } from "../../lib/query";

type Source = "upload" | "connect" | "previous";
const getSource = (): Source => {
  const s = sessionStorage.getItem("yp-source");
  return s === "connect" || s === "previous" ? s : "upload";
};
const int = (n: number) => n.toLocaleString();

/* ------------------------------------------------------------- 1. source */

export function SourcePage() {
  const p = useProject();
  const [src, setSrc] = useState<Source>(getSource());
  const pick = (s: Source) => {
    setSrc(s);
    sessionStorage.setItem("yp-source", s);
  };
  const point = (t: string) => (
    <li key={t} className="flex items-center gap-2">
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-good" /> {t}
    </li>
  );

  return (
    <Page title="Connect Your Data" description="Bring in your admissions, student, and financial aid data. Choose how you'd like to start.">
      <div className="grid gap-4 md:grid-cols-3" role="radiogroup" aria-label="How to bring in your data">
        <Tile
          on={src === "upload"}
          onClick={() => pick("upload")}
          icon={<FileSpreadsheet />}
          title="Upload File"
          text="Upload a CSV or Excel file from your computer."
        >
          <ul className="mt-5 space-y-1.5 border-t pt-4 text-[12.5px] text-muted-foreground">
            {["CSV, TSV, XLSX, XLS or Parquet", "Up to 500 MB", "Personal data removed on arrival"].map(point)}
          </ul>
        </Tile>
        <Tile
          on={src === "connect"}
          onClick={() => pick("connect")}
          icon={<Database />}
          title="Connect a System"
          text="Pull data straight from your warehouse, student information system or CRM."
        >
          <ul className="mt-5 space-y-1.5 border-t pt-4 text-[12.5px] text-muted-foreground">
            {["Databricks, Snowflake, BigQuery, SQL Server, Oracle", "PostgreSQL, MySQL, Slate, Salesforce, SFTP", "Read-only; credentials encrypted"].map(point)}
          </ul>
        </Tile>
        <Tile
          on={src === "previous"}
          onClick={() => pick("previous")}
          icon={<History />}
          title="Previously Used Data"
          text="Start from data your institution already brought in."
        >
          <ul className="mt-5 space-y-1.5 border-t pt-4 text-[12.5px] text-muted-foreground">
            {["Every earlier upload and import", "Latest version, with your fixes", "No new connection needed"].map(point)}
          </ul>
        </Tile>
      </div>
      {src === "previous" && p && <PreviousData p={p} />}

      <section className="surface mt-5 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[14.5px] font-semibold">What we need</h2>
          <span className="text-[12.5px] text-muted-foreground">Include as many of these as you have. We map your fields automatically.</span>
        </div>
        <ul className="mt-4 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {[
            [FileSpreadsheet, "Applications", "Records and status"],
            [CheckCircle2, "Admits", "Admission decisions"],
            [Users, "Student Info", "Demographics and academics"],
            [Wallet, "Financial Aid", "Offers and awards"],
            [Home, "Housing", "Interest and assignment"],
          ].map(([I, t, d]) => {
            const Icon = I as typeof Users;
            return (
              <li key={t as string} className="flex items-start gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground/70">
                  <Icon className="h-4 w-4" />
                </span>
                <span>
                  <span className="block text-[13.5px] font-medium">{t as string}</span>
                  <span className="text-[12.5px] text-muted-foreground">{d as string}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </section>
      <NextBar
        to={src === "previous" ? "/data/fields" : undefined}
        disabled={src === "previous" && !p?.dataset}
        note={src === "previous" && !p?.dataset ? "Choose the data to use above." : undefined}
      />
    </Page>
  );
}

/** Data the institution imported before, ready to reuse in this prediction (its latest version). */
function PreviousData({ p }: { p: Project }) {
  const nav = useNavigate();
  const [list, setList] = useState<Awaited<ReturnType<typeof API.datasets>>>();
  const [busy, setBusy] = useState("");
  useEffect(() => {
    API.datasets().then(setList, () => setList([]));
  }, []);
  const use = async (id: string, name: string) => {
    setBusy(id);
    try {
      projectStore.set(await API.reuseData(p.id, id));
      toast.success(`Using ${name}`);
      nav("/data/fields");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="surface mt-5 p-5">
      <h2 className="text-[14.5px] font-semibold">Data your institution brought in</h2>
      {!list ? (
        <p className="mt-3 flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading your data…
        </p>
      ) : !list.length ? (
        <p className="mt-2 text-[13px] text-muted-foreground">Nothing yet. Upload a file or connect a system first.</p>
      ) : (
        <ul className="mt-3 divide-y rounded-xl border">
          {list.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-4 py-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground/70">
                <Database className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium">{d.name}</span>
                <span className="text-[12.5px] text-muted-foreground">
                  {d.rows != null ? `${int(d.rows)} rows · ${d.columns} columns · ` : ""}brought in {d.mine ? "by you" : d.by ? `by ${d.by}` : ""} on {fmtDate(d.created_at)}
                </span>
              </span>
              <Button size="sm" className="rounded-full" disabled={!!busy} onClick={() => void use(d.id, d.name)}>
                {busy === d.id && <Loader2 className="animate-spin" />} Use this data
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------- 2. upload */

export function UploadPage() {
  const p = useProject();
  const { me } = useSession();
  const src = getSource();
  if (!p) return null;
  const loaded = !!p.dataset;
  if (!can(me, "data_manager") && !loaded)
    return <Blocked title="Adding data needs a data manager" text="Your role can view forecasts and reports. An owner or admin can change your role in Team." cta="Open Team" to="/settings/team" />;
  const titles: Record<Source, [string, string]> = {
    upload: ["Upload Your Data", "Drop a CSV or Excel file. Your data appears below so you can check and tidy it."],
    connect: ["Connect a System", "Pick your system, sign in once, then choose the table, query or file to bring in."],
    previous: ["Your Data", "The data this prediction uses. Check it below."],
  };
  return (
    <Page title={titles[src][0]} description={titles[src][1]} width="wide" mode={loaded ? "fill" : "center"}>
      {src === "upload" && (
        <div className={cn("grid items-stretch gap-4", loaded ? "lg:grid-cols-[1fr_auto_1fr]" : "")}>
          {loaded && <Loaded p={p} />}
          <Dropzone p={p} small={loaded} />
          {loaded && <NextUp />}
        </div>
      )}
      {src === "connect" && <Connect p={p} />}
      {src === "previous" && !loaded && <PreviousData p={p} />}
      {loaded && <Fit p={p} />}
      {loaded && <OverLimit p={p} />}
      {loaded && src !== "upload" && (
        <div className="mb-1 mt-4 flex shrink-0 items-center gap-2 text-[13px]">
          <CheckCircle2 className="h-4 w-4 text-good" />
          <span className="font-semibold">{p.source.label ?? p.dataset!.filename}</span>
          <DeleteData p={p} className="ml-auto" />
        </div>
      )}
      {loaded && (
        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          <DataGrid p={p} />
        </div>
      )}
      <NextBar
        disabled={!p.dataset}
        label={p.source.fit && !p.source.fit.ok ? "Map the fields manually" : undefined}
        note={!p.dataset ? "Upload a file or connect a system to continue." : undefined}
      />
    </Page>
  );
}

/** Gemini's read of the file, and whether a yield model can learn from it. Irrelevant data is stopped here. */
type KeepMode = Keep["mode"];
const WAYS: { k: KeepMode; label: string; icon: typeof History }[] = [
  { k: "recent", label: "Newest terms", icon: History },
  { k: "terms", label: "Choose terms", icon: CalendarRange },
  { k: "values", label: "By a column", icon: Filter },
  { k: "rows", label: "Row range", icon: Rows3 },
  { k: "first", label: "First rows", icon: ArrowDownToLine },
  { k: "sample", label: "Random sample", icon: Shuffle },
];
const THEN: [TrimMode, string][] = [["recent", "the newest terms first"], ["first", "the first in the file"], ["sample", "a random sample"]];
const blank = (v: string) => (v === "" ? "(blank)" : v);

/** More rows than the plan allows: choose which rows to keep, here, without changing the file. Whatever is chosen, the server
 * keeps the plan's number of rows at most (it re-checks everything; this screen can't raise the limit). */
function TrimChoice({ o, busy, onPick, onCancel }: { o: TrimSummary & { limit: number }; busy: boolean; onPick: (k: Keep) => void; onCancel?: () => void }) {
  const newestThatFit = useMemo(() => {
    const out: string[] = [];
    let n = 0;
    for (const t of [...o.terms].reverse()) {
      if (n + t.rows > o.limit) break;
      out.push(t.value);
      n += t.rows;
    }
    return out;
  }, [o]);
  const [mode, setMode] = useState<KeepMode>(o.term_column ? "recent" : "first");
  const [terms, setTerms] = useState<string[]>(newestThatFit);
  const [col, setCol] = useState(o.columns[0]?.name ?? "");
  const [vals, setVals] = useState<string[]>([]);
  const [then, setThen] = useState<TrimMode>(o.term_column ? "recent" : "first");
  const [from, setFrom] = useState("1");
  const [to, setTo] = useState(String(Math.min(o.rows, o.limit)));
  const column = o.columns.find((c) => c.name === col);
  const start = Math.max(1, Math.floor(+from || 1));
  const end = Math.min(o.rows, Math.floor(+to || 0));
  const chosen =
    mode === "terms" ? o.terms.filter((t) => terms.includes(t.value)).reduce((a, t) => a + t.rows, 0)
    : mode === "values" ? (column?.values ?? []).filter((v) => vals.includes(v.value)).reduce((a, v) => a + v.rows, 0)
    : mode === "rows" ? Math.max(0, end - start + 1)
    : o.rows;
  const kept = Math.min(chosen, o.limit);
  const tooWide = mode === "rows" && chosen > o.limit;
  const spill = (mode === "terms" || mode === "values") && chosen > o.limit;
  const ready = kept > 0 && !tooWide && (mode !== "rows" || (start <= end && start <= o.rows));
  const ways = WAYS.filter((w) => (w.k === "terms" || w.k === "recent" ? !!o.term_column && o.terms.length > 1 : w.k === "values" ? o.columns.length > 0 : true));
  const keep = (): Keep =>
    mode === "terms" ? { mode, terms, then } : mode === "values" ? { mode, column: col, values: vals, then } : mode === "rows" ? { mode, start, end } : { mode };
  const toggle = (list: string[], set: (x: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const chip = (on: boolean) =>
    cn("flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-[12.5px] transition-colors",
      on ? "border-primary bg-primary/[0.07] font-medium text-foreground" : "bg-card text-muted-foreground hover:border-foreground/25");
  const pct = Math.min(100, (chosen / o.limit) * 100);

  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.05] p-4 text-[13px] sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold">This data has {int(o.rows)} rows. Your plan allows {int(o.limit)} per dataset.</div>
          <p className="mt-0.5 text-muted-foreground">Choose which rows to keep. Your file isn't changed. Or an owner can upgrade in Billing.</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Which rows to keep">
        {ways.map((w) => (
          <button key={w.k} role="radio" aria-checked={mode === w.k} disabled={busy} onClick={() => setMode(w.k)}
            className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-colors",
              mode === w.k ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground")}>
            <w.icon className="h-3.5 w-3.5" /> {w.label}
          </button>
        ))}
      </div>

      <div className="mt-3 rounded-xl border bg-card p-3.5">
        {mode === "recent" && <p className="text-muted-foreground">The {int(o.limit)} rows from the newest terms, by <b className="font-medium text-foreground">{o.term_column}</b>. Older terms are left out first.</p>}
        {mode === "first" && <p className="text-muted-foreground">The first {int(o.limit)} rows of the file, in its own order.</p>}
        {mode === "sample" && <p className="text-muted-foreground">{int(o.limit)} rows picked at random from every term. The same file always gives the same rows.</p>}
        {mode === "terms" && (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-[12px] text-muted-foreground">Terms in {o.term_column}</span>
              <button className="text-[12px] font-medium text-primary hover:underline" onClick={() => setTerms(newestThatFit)}>Newest that fit</button>
              <button className="text-[12px] font-medium text-primary hover:underline" onClick={() => setTerms(o.terms.map((t) => t.value))}>All</button>
              <button className="text-[12px] font-medium text-primary hover:underline" onClick={() => setTerms([])}>None</button>
            </div>
            <div className="grid max-h-56 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-3 lg:grid-cols-4">
              {[...o.terms].reverse().map((t) => (
                <button key={t.value} onClick={() => toggle(terms, setTerms, t.value)} className={chip(terms.includes(t.value))} aria-pressed={terms.includes(t.value)}>
                  <span className="flex items-center gap-1.5 truncate">{terms.includes(t.value) ? <CheckSquare className="h-3.5 w-3.5 shrink-0 text-primary" /> : <Square className="h-3.5 w-3.5 shrink-0" />}{termName(t.value) || blank(t.value)}</span>
                  <span className="tabular-nums">{int(t.rows)}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {mode === "values" && (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-[12px] text-muted-foreground">Keep rows where</span>
              <Select value={col} onValueChange={(v) => (setCol(v), setVals([]))}>
                <SelectTrigger className="h-8 w-56"><SelectValue /></SelectTrigger>
                <SelectContent>{o.columns.map((c) => <SelectItem key={c.name} value={c.name}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
              <span className="text-[12px] text-muted-foreground">is one of</span>
              <button className="text-[12px] font-medium text-primary hover:underline" onClick={() => setVals((column?.values ?? []).map((v) => v.value))}>All</button>
              <button className="text-[12px] font-medium text-primary hover:underline" onClick={() => setVals([])}>None</button>
            </div>
            <div className="grid max-h-56 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
              {(column?.values ?? []).map((v) => (
                <button key={v.value} onClick={() => toggle(vals, setVals, v.value)} className={chip(vals.includes(v.value))} aria-pressed={vals.includes(v.value)}>
                  <span className="flex items-center gap-1.5 truncate">{vals.includes(v.value) ? <CheckSquare className="h-3.5 w-3.5 shrink-0 text-primary" /> : <Square className="h-3.5 w-3.5 shrink-0" />}{blank(v.value)}</span>
                  <span className="tabular-nums">{int(v.rows)}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {mode === "rows" && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <FieldLabel htmlFor="trim-from" className="text-[12px]">From row</FieldLabel>
              <Input id="trim-from" inputMode="numeric" value={from} onChange={(e) => setFrom(e.target.value.replace(/\D/g, ""))} className="h-9 w-32 tabular-nums" />
            </div>
            <div className="space-y-1">
              <FieldLabel htmlFor="trim-to" className="text-[12px]">To row</FieldLabel>
              <Input id="trim-to" inputMode="numeric" value={to} onChange={(e) => setTo(e.target.value.replace(/\D/g, ""))} className="h-9 w-32 tabular-nums" />
            </div>
            <Button variant="outline" size="sm" className="h-9" onClick={() => setTo(String(Math.min(o.rows, start + o.limit - 1)))}>Fill to the plan's {int(o.limit)}</Button>
            <p className="basis-full text-[12px] text-muted-foreground">Row 1 is the first row after the column names. The file has {int(o.rows)} rows.</p>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-[220px] flex-1">
          <div className="flex justify-between text-[12px]">
            <span className={cn("font-medium", tooWide ? "text-destructive" : "text-foreground")}>
              {mode === "recent" || mode === "first" || mode === "sample" ? `${int(kept)} rows will be kept` : `${int(chosen)} rows chosen`}
            </span>
            <span className="text-muted-foreground">plan: {int(o.limit)}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full rounded-full transition-all", chosen > o.limit ? "bg-amber-500" : "bg-primary")} style={{ width: `${pct}%` }} />
          </div>
        </div>
        {spill && (
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <span>That's more than the plan allows. Keep {int(o.limit)} of them:</span>
            <Select value={then} onValueChange={(v) => setThen(v as TrimMode)}>
              <SelectTrigger className="h-8 w-52"><SelectValue /></SelectTrigger>
              <SelectContent>{THEN.filter(([k]) => k !== "recent" || o.term_column).map(([k, t]) => <SelectItem key={k} value={k}>{t}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        )}
        {tooWide && <span className="text-[12.5px] text-destructive">A range can hold {int(o.limit)} rows at most on your plan.</span>}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={busy || !ready} onClick={() => onPick(keep())}>{busy && <Loader2 className="animate-spin" />} Keep {int(kept)} rows</Button>
        {onCancel && <Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>}
      </div>
    </div>
  );
}

/** Data saved before a plan changed (or reused) can be bigger than the plan allows: a Run refuses it, so offer to trim it here. */
function OverLimit({ p }: { p: Project }) {
  const q = useQuery("quota", API.quota, 0).data;
  const [busy, setBusy] = useState(false);
  const canEdit = can(useSession().me, "data_manager");
  const rows = p.dataset?.rows ?? 0;
  const over = !!q?.enforced && q.rows_limit != null && rows > q.rows_limit;
  const opts = useQuery(over && canEdit ? `trim:${p.id}:${p.dataset?.version ?? 0}` : null, () => API.trimOptions(p.id));
  if (!over || q?.rows_limit == null) return null;
  if (!canEdit)
    return <p className="mt-4 rounded-xl bg-amber-500/[0.08] px-4 py-3 text-[13px]">This data has {int(rows)} rows; the plan allows {int(q.rows_limit)}. A data manager can choose which {int(q.rows_limit)} to keep here.</p>;
  const pick = async (keep: Keep) => {
    setBusy(true);
    try {
      const saved = projectStore.set(await API.trimData(p.id, keep));
      toast.success(`Kept ${int(saved.dataset?.rows ?? 0)} rows as a new version. The earlier version stays in its history.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!opts.data) return <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/[0.05] p-4"><Loading text="Counting the rows in each term…" /></div>;
  return <div className="mt-4"><TrimChoice o={{ ...opts.data, limit: q.rows_limit }} busy={busy} onPick={(k) => void pick(k)} /></div>;
}

function Fit({ p }: { p: Project }) {
  const fit = p.source.fit;
  if (!fit) return null;
  if (fit.ok)
    return (
      <div className="mt-4 flex shrink-0 items-start gap-2.5 rounded-xl border border-good/25 bg-good/[0.06] px-4 py-3 text-[13px]">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-good" />
        <span>
          <b className="font-semibold">Ready for a yield forecast.</b> <span className="text-muted-foreground">{fit.summary}</span>
        </span>
      </div>
    );
  return (
    <div className="mt-4 shrink-0 rounded-xl border border-destructive/30 bg-destructive/[0.05] px-5 py-4 text-[13px]">
      <div className="flex items-center gap-2 text-[14px] font-semibold text-destructive">
        <CircleDashed className="h-4 w-4" /> {fit.relevant ? "This file is missing what a yield forecast needs" : "This doesn't look like admissions data"}
      </div>
      {fit.summary && <p className="mt-1.5 text-muted-foreground">{fit.summary}</p>}
      {fit.problems.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          {fit.problems.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      <p className="mt-3">
        Upload admissions records instead: one row per admitted student with their entry term, whether they enrolled, and details such as
        college, major, GPA, aid or visits. If this file does contain those, match the columns yourself on the next screen.
      </p>
    </div>
  );
}

function Loaded({ p }: { p: Project }) {
  const d = p.dataset!;
  return (
    <div className="surface flex flex-col justify-center p-5">
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-good">
        <CheckCircle2 className="h-4 w-4" /> File loaded
        <DeleteData p={p} className="ml-auto" />
      </div>
      <div className="mt-1.5 truncate text-[16px] font-semibold tracking-[-0.01em]">{d.filename}</div>
      <div className="mt-3 flex gap-6">
        <div>
          <div className="text-[22px] font-semibold tracking-[-0.03em] tabular-nums">{int(d.rows)}</div>
          <div className="text-[12px] text-muted-foreground">rows</div>
        </div>
        <div>
          <div className="text-[22px] font-semibold tracking-[-0.03em] tabular-nums">{d.columns.length}</div>
          <div className="text-[12px] text-muted-foreground">columns</div>
        </div>
        <div>
          <div className="text-[22px] font-semibold tracking-[-0.03em] tabular-nums">v{d.version}</div>
          <div className="text-[12px] text-muted-foreground">version</div>
        </div>
      </div>
      {d.dropped.length > 0 && (
        <p className="mt-3 text-[12px] text-muted-foreground">
          Removed for privacy: {d.dropped.map((x) => x.column).join(", ")}
        </p>
      )}
    </div>
  );
}

/** Delete every version of this prediction's data, its stored files and the forecasts made from it. */
function DeleteData({ p, className }: { p: Project; className?: string }) {
  const { me } = useSession();
  if (!can(me, "data_manager")) return null;
  return (
    <ConfirmDelete
      label="Delete data"
      confirm="Delete all data and forecasts?"
      className={className}
      onConfirm={async () => {
        projectStore.set(await API.deleteData(p.id));
        toast.success("Data deleted");
      }}
    />
  );
}

function NextUp() {
  const canEdit = can(useSession().me, "data_manager");
  return (
    <div className="surface flex flex-col justify-center p-5">
      <Label>Next</Label>
      <ul className="mt-2 space-y-2 text-[13px]">
        <li className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-primary" /> We match your columns to the fields we need
        </li>
        <li className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" /> Then check your data is ready for prediction
        </li>
        {canEdit && (
          <li className="flex items-center gap-2 text-muted-foreground">
            <ArrowRight className="h-4 w-4" /> Tick rows or × a column below to remove it
          </li>
        )}
      </ul>
    </div>
  );
}

function Dropzone(props: { p: Project; small?: boolean }) {
  return can(useSession().me, "data_manager") ? <Drop {...props} /> : null;
}

function Drop({ p, small }: { p: Project; small?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>();
  const [drag, setDrag] = useState(false);
  const [over, setOver] = useState<OverPlan | null>(null);
  const keep = async (k: Keep) => {
    if (!over?.upload_id) return;
    setBusy(true);
    try {
      const saved = projectStore.set(await finishUpload(over.upload_id, p.id, k, setStep));
      setOver(null);
      toast.success(`Saved version ${saved.dataset!.version}: ${int(saved.dataset!.rows)} rows, within your plan`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  async function handle(file?: File) {
    if (!file) return;
    const ext = file.name.toLowerCase().split(".").pop() ?? "";
    if (!["csv", "tsv", "txt", "xlsx", "xls", "parquet"].includes(ext)) return toast.error("Please choose a .csv, .tsv, .xlsx, .xls or .parquet file.");
    setBusy(true);
    setStep(undefined);
    try {
      // The backend is the system of record: it validates, removes personal data and versions the file.
      const saved = projectStore.set(await uploadToProject(file, p.id, setStep));
      const d = saved.dataset!;
      toast.success(`Saved version ${d.version}: ${int(d.rows)} rows`);
      if (d.dropped.length) toast(`Removed ${d.dropped.length} column(s) with personal data: ${d.dropped.map((x) => x.column).join(", ")}`);
    } catch (e) {
      const o = overPlan(e);
      if (o) setOver(o);
      else toast.error((e as Error).message || "We couldn't read that file.");
    } finally {
      setBusy(false);
    }
  }
  if (over) return <TrimChoice o={over} busy={busy} onPick={(m) => void keep(m)} onCancel={() => setOver(null)} />;
  return (
    <div
      onDragOver={(e) => (e.preventDefault(), setDrag(true))}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        handle(e.dataTransfer.files[0]);
      }}
      onClick={() => !busy && ref.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && ref.current?.click()}
      aria-label="Drop a file here or browse"
      className={cn(
        "group mx-auto flex aspect-square cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed text-center transition-all duration-200",
        small ? "w-[208px]" : "w-[320px]",
        drag ? "scale-[1.02] border-primary bg-primary/[0.06]" : "border-primary/30 bg-card hover:border-primary/60 hover:bg-primary/[0.02]",
      )}
    >
      {busy ? (
        <ProgressBar className={cn("text-left", small ? "px-4" : "px-8")} step={step} />
      ) : (
        <>
          <span
            className={cn(
              "grid place-items-center rounded-2xl bg-primary text-primary-foreground shadow-[0_10px_24px_-10px_hsl(var(--primary)/0.8)] transition-transform duration-200 group-hover:-translate-y-0.5",
              small ? "h-14 w-14" : "h-20 w-20",
            )}
          >
            <FileUp className={small ? "h-7 w-7" : "h-9 w-9"} />
          </span>
          <p className={cn("font-semibold", small ? "mt-3 text-[13.5px]" : "mt-5 text-[16px]")}>{small ? "Replace file" : "Drop your file here"}</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            or <span className="font-medium text-primary">browse</span> · CSV, XLSX{small ? "" : ", XLS, Parquet up to 500 MB"}
          </p>
        </>
      )}
      <input
        ref={ref}
        type="file"
        accept=".csv,.tsv,.txt,.xlsx,.xls,.parquet"
        className="hidden"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => handle(e.target.files?.[0])}
      />
    </div>
  );
}

const Mono = ({ c, size = "md" }: { c: Pick<Connector, "mono" | "color">; size?: "sm" | "md" }) => (
  <span
    className={cn("grid shrink-0 place-items-center rounded-xl font-extrabold text-white", size === "sm" ? "h-8 w-8 text-[10px]" : "h-11 w-11 text-xs")}
    style={{ background: c.color }}
  >
    {c.mono}
  </span>
);

/** Pick a table (listed from the source) or write a query, preview the first rows, then import a copy. */
function ImportFrom({ p, conn, spec, onBack }: { p: Project; conn: Conn; spec?: Connector; onBack: () => void }) {
  const [list, setList] = useState<{ name: string; type: string }[] | null>(null);
  const [listErr, setListErr] = useState("");
  const [mode, setMode] = useState<"table" | "query">(conn.source === "soql" ? "query" : "table");
  const [table, setTable] = useState("");
  const [find, setFind] = useState("");
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [peek, setPeek] = useState<{ columns: string[]; rows: Record<string, string>[] } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<"" | "preview" | "import">("");
  const [step, setStep] = useState<Step>();
  const stop = useRef<AbortController | null>(null);
  useEffect(() => {
    if (conn.source !== "sql") return;
    API.tables(conn.id).then(setList, (e) => setListErr((e as Error).message));
  }, [conn.id, conn.source]);
  const body = conn.source === "file" ? { path } : conn.source === "none" ? {} : mode === "query" ? { query } : { table };
  const ready = conn.source === "none" || (conn.source === "file" ? !!path.trim() : mode === "query" ? !!query.trim() : !!table);
  const [over, setOver] = useState<OverPlan | null>(null);
  const run = async (what: "preview" | "import", trim?: Keep) => {
    setBusy(what);
    setErr("");
    setStep(undefined);
    const abort = (stop.current = new AbortController());
    try {
      if (what === "preview") setPeek(await API.preview(conn.id, body, setStep, abort.signal));
      else {
        const out = projectStore.set(await API.importFrom(conn.id, { project_id: p.id, ...body, ...(trim ? { trim } : {}) }, setStep, abort.signal));
        setOver(null);
        toast.success(`Imported ${int(out.dataset!.rows)} rows from ${conn.name}`);
        onBack();
      }
    } catch (e) {
      const o = overPlan(e);
      if (o) setOver(o);
      else if (!abort.signal.aborted) setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  /** Stop the preview or import: the server cancels the query too. */
  const cancel = () => {
    stop.current?.abort();
    setBusy("");
    setStep(undefined);
    toast("Stopped");
  };
  const shown = (list ?? []).filter((t) => !find || t.name.toLowerCase().includes(find.toLowerCase()));
  const example = conn.source === "soql" ? "SELECT Id, Status__c, Term__c FROM Application__c" : `SELECT * FROM ${list?.[0]?.name ?? "schema.table"} WHERE …`;

  return (
    <div className="w-full shrink-0 space-y-4">
      <Soft className="mx-auto w-full max-w-4xl">
        <div className="flex items-center gap-3">
          {spec && <Mono c={spec} />}
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{conn.name}</div>
            <div className="truncate text-sm text-muted-foreground">{conn.where}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={onBack}>
            Back
          </Button>
        </div>

        {conn.source === "sql" && (
          <div className="mt-5 flex w-fit rounded-full border bg-card p-1 text-[12.5px]">
            {(
              [
                ["table", "Pick a table"],
                ["query", "Write a query"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => (setMode(k), setPeek(null), setErr(""))}
                className={cn("rounded-full px-3.5 py-1 font-medium", mode === k ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground")}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="mt-4">
          {conn.source === "none" && <p className="text-sm text-muted-foreground">This connection returns one dataset. Preview it or import it.</p>}
          {conn.source === "file" && (
            <div className="space-y-1.5">
              <FieldLabel htmlFor="c-path">File path on the server</FieldLabel>
              <Input id="c-path" placeholder="/exports/admits.csv" value={path} onChange={(e) => setPath(e.target.value)} />
            </div>
          )}
          {conn.source === "sql" && mode === "table" && (
            <div>
              {listErr ? (
                <p className="rounded-lg bg-destructive/[0.06] px-3 py-2 text-[13px] text-destructive">{listErr}</p>
              ) : !list ? (
                <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Reading the tables you can access…
                </p>
              ) : (
                <>
                  <div className="relative mb-2">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder={`Search ${list.length} tables and views`} className="h-9 pl-9" />
                  </div>
                  <ul className="max-h-56 divide-y overflow-y-auto rounded-lg border bg-card">
                    {shown.map((t) => (
                      <li key={t.name}>
                        <button
                          onClick={() => (setTable(t.name), setPeek(null), setErr(""))}
                          className={cn("flex w-full items-center justify-between px-3 py-2 text-left text-[13px] hover:bg-muted/50", table === t.name && "bg-primary/[0.07] font-medium text-primary")}
                        >
                          <span className="font-mono">{t.name}</span>
                          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{t.type === "VIEW" ? "view" : "table"}</span>
                        </button>
                      </li>
                    ))}
                    {!shown.length && <li className="px-3 py-4 text-center text-[13px] text-muted-foreground">No tables match.</li>}
                  </ul>
                </>
              )}
            </div>
          )}
          {(conn.source === "soql" || (conn.source === "sql" && mode === "query")) && (
            <div className="space-y-1.5">
              <FieldLabel htmlFor="c-query">{conn.source === "soql" ? "SOQL query" : "SELECT query"}</FieldLabel>
              <textarea
                id="c-query"
                rows={5}
                className="w-full rounded-[var(--radius-input)] border border-input bg-background px-3 py-2 font-mono text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder={example}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <p className="text-[12px] text-muted-foreground">Read-only: a single SELECT. Tip: preview first to check the columns.</p>
            </div>
          )}
        </div>

        {err && <p className="mt-4 rounded-lg border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-[13px] text-destructive">{err}</p>}
        {over && <div className="mt-4"><TrimChoice o={over} busy={busy === "import"} onPick={(m) => void run("import", m)} onCancel={() => setOver(null)} /></div>}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button variant="outline" className="rounded-full" disabled={!ready || !!busy} onClick={() => void run("preview")}>
            {busy === "preview" && <Loader2 className="animate-spin" />} Preview
          </Button>
          <Button className="rounded-full px-6" disabled={!ready || !!busy} onClick={() => void run("import")}>
            {busy === "import" && <Loader2 className="animate-spin" />} Import data
          </Button>
          <span className="text-[12px] text-muted-foreground">We copy it once, remove personal details and save it as a new version.</span>
        </div>
        {busy && (
          <div className="mt-5">
            <ProgressBar step={step} />
            <Button variant="outline" size="sm" className="mt-3 rounded-full" onClick={cancel}>
              <X className="h-3.5 w-3.5" /> Cancel
            </Button>
          </div>
        )}
      </Soft>

      {peek && (
        <div className="surface overflow-hidden">
          <div className="border-b px-4 py-2 text-[12.5px] text-muted-foreground">
            First {peek.rows.length} rows · {peek.columns.length} columns
          </div>
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-max min-w-full text-[12.5px]">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  {peek.columns.map((c) => (
                    <th key={c} className="whitespace-nowrap px-3 py-2 text-left font-semibold">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {peek.rows.map((r, i) => (
                  <tr key={i}>
                    {peek.columns.map((c) => (
                      <td key={c} className="whitespace-nowrap px-3 py-1.5">
                        {r[c] || <span className="text-muted-foreground/50">blank</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** One connection field: required ones carry an asterisk; optional ones say so and explain when they matter. */
function ConnField({ f, vals, setVals }: { f: ConnectorField; vals: Record<string, string>; setVals: (v: Record<string, string>) => void }) {
  return (
    <div className={cn("space-y-1.5", f.type === "textarea" && "sm:col-span-2")}>
      <FieldLabel htmlFor={`c-${f.key}`}>
        {f.label} {f.optional ? <span className="font-normal text-muted-foreground">(optional)</span> : <span className="text-destructive" aria-label="required">*</span>}
      </FieldLabel>
      {f.type === "textarea" ? (
        <textarea
          id={`c-${f.key}`}
          rows={4}
          required={!f.optional}
          className="w-full rounded-[var(--radius-input)] border border-input bg-background px-3 py-2 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={vals[f.key] ?? ""}
          onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
        />
      ) : (
        <Input
          id={`c-${f.key}`}
          type={f.secret ? "password" : "text"}
          autoComplete={f.secret ? "new-password" : "off"}
          required={!f.optional}
          placeholder={f.placeholder}
          value={vals[f.key] ?? ""}
          onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
        />
      )}
      {f.hint && <p className="text-[12px] text-muted-foreground">{f.hint}</p>}
    </div>
  );
}

/** Every connector the backend supports, saved connections, and the import itself. */
function Connect({ p }: { p: Project }) {
  const [catalog, setCatalog] = useState<Connector[]>([]);
  const [saved, setSaved] = useState<Conn[]>([]);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<Connector | null>(null);
  const [conn, setConn] = useState<Conn | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [pick?.kind]); // each connector starts with only its required fields
  const load = () =>
    Promise.all([API.connectors(), API.connections()])
      .then(([c, s]) => (setCatalog(c), setSaved(s)))
      .catch((e) => toast.error((e as Error).message));
  useEffect(() => void load(), []);
  const spec = (kind: string) => catalog.find((c) => c.kind === kind);

  const method = pick?.auth?.find((m) => m.key === vals.__auth) ?? pick?.auth?.[0];
  const required = pick ? [...pick.fields.filter((f) => !f.optional), ...(method?.fields ?? [])] : [];
  const missing = required.filter((f) => !(vals[f.key] ?? "").trim());
  const connect = async () => {
    if (!pick) return;
    if (missing.length) return toast.error(`Fill in ${missing.map((f) => f.label).join(", ")}.`);
    setBusy(true);
    try {
      const c = await API.createConnection({ kind: pick.kind, name: vals.__name || pick.name, values: { ...vals, __auth: method?.key ?? "" } });
      if (c.warehouse_state && c.warehouse_state !== "RUNNING")
        toast.success(`Connected to ${pick.name}`, {
          description: "Your SQL warehouse was asleep and is starting now (usually 1–3 minutes). Pick a table meanwhile; the import waits for it.",
          duration: 9000,
        });
      else toast.success(`Connected to ${pick.name}`);
      setSaved(await API.connections());
      setConn(c);
      setPick(null);
      setVals({});
      setMore(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (conn) return <ImportFrom p={p} conn={conn} spec={spec(conn.kind)} onBack={() => setConn(null)} />;

  if (pick)
    return (
      <Soft className="mx-auto w-full max-w-2xl shrink-0">
        <div className="mb-6 flex items-center gap-3">
          <Mono c={pick} />
          <div className="flex-1">
            <div className="font-semibold">{pick.name}</div>
            <div className="text-sm text-muted-foreground">{pick.blurb}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setPick(null)}>
            Change
          </Button>
        </div>
        {pick.help && <p className="-mt-2 mb-5 rounded-lg bg-muted px-3 py-2 text-[12.5px] leading-relaxed text-muted-foreground">{pick.help}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <FieldLabel htmlFor="c-name">Connection name</FieldLabel>
            <Input id="c-name" placeholder={pick.name} value={vals.__name ?? ""} onChange={(e) => setVals({ ...vals, __name: e.target.value })} />
          </div>
          {pick.fields.filter((f) => !f.optional).map((f) => (
            <ConnField key={f.key} f={f} vals={vals} setVals={setVals} />
          ))}
        </div>
        {!!pick.auth?.length && (
          <div className="mt-5 space-y-3">
            <div className="text-[13px] font-medium">Sign in with</div>
            {pick.auth.length > 1 && (
              <div className="inline-flex flex-wrap rounded-xl border bg-muted/40 p-1 text-[13px]" role="radiogroup" aria-label="Sign in with">
                {pick.auth.map((m) => (
                  <button key={m.key} type="button" role="radio" aria-checked={method?.key === m.key} onClick={() => setVals({ ...vals, __auth: m.key })}
                    className={cn("rounded-lg px-3.5 py-1.5 font-medium transition-colors", method?.key === m.key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                    {m.label}
                  </button>
                ))}
              </div>
            )}
            {method?.hint && <p className="text-[12.5px] text-muted-foreground">{method.hint}</p>}
            {!!method?.fields.length && (
              <div className="grid gap-4 sm:grid-cols-2">
                {method.fields.map((f) => (
                  <ConnField key={f.key} f={f} vals={vals} setVals={setVals} />
                ))}
              </div>
            )}
          </div>
        )}
        {pick.fields.some((f) => f.optional) && (
          <div className="mt-5">
            <button type="button" onClick={() => setMore(!more)} className="text-[13px] font-medium text-primary hover:underline">
              {more ? "Hide more options" : "More options"}
            </button>
            {more && (
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                {pick.fields.filter((f) => f.optional).map((f) => (
                  <ConnField key={f.key} f={f} vals={vals} setVals={setVals} />
                ))}
              </div>
            )}
          </div>
        )}
        <p className="mt-5 text-[12px] text-muted-foreground"><span className="text-destructive">*</span> Required</p>
        <Button className="mt-4 rounded-full px-6" disabled={busy || missing.length > 0} onClick={() => void connect()}>
          {busy && <Loader2 className="animate-spin" />} Test and save connection
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">Use a read-only account. Credentials are encrypted and never shown again.</p>
      </Soft>
    );

  const list = catalog.filter((c) => `${c.name} ${c.group}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="shrink-0 space-y-5">
      {saved.length > 0 && (
        <div>
          <Label>Saved connections</Label>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {saved.map((c) => {
              const sp = spec(c.kind);
              return (
                <div key={c.id} className="surface-btn flex items-center gap-3 p-3.5">
                  <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setConn(c)}>
                    {sp && <Mono c={sp} size="sm" />}
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-medium">{c.name}</span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">
                        {c.where}
                        {c.by ? ` · added by ${c.by}` : ""}
                      </span>
                    </span>
                  </button>
                  {c.manage !== false && <ConfirmDelete
                    confirm="Delete"
                    onConfirm={async () => {
                      await API.deleteConnection(c.id);
                      await load();
                      toast.success(`Deleted ${c.name}`);
                    }}
                  />}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Label>Add a connection</Label>
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find your system" className="h-9 rounded-full pl-9" />
          </div>
        </div>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {list.map((c) => (
            <button key={c.kind} onClick={() => setPick(c)} className="surface-btn flex items-center gap-3 p-3.5 text-left">
              <Mono c={c} size="sm" />
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-medium">{c.name}</span>
                <span className="block truncate text-[11.5px] text-muted-foreground">{c.group}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 3. fields */

const SHOWN: FieldKey[] = ["studentId", "term", "outcome", "admitStatus", "studentType", "college", "major", "residency", "gpa", "aid", "housing"];

export function FieldsPage() {
  const p = useProject();
  if (!p) return <Loading />;
  if (!p.dataset)
    return (
      <Page title="Detected Fields Preview" description="Add your data first; we'll match its columns automatically.">
        <NextBar to="/data/upload" label="Add your data" />
      </Page>
    );
  const ds = p.dataset;
  const used = new Set(Object.values(p.mapping));
  const set = (k: FieldKey, v: string) => projectStore.patch({ mapping: { ...p.mapping, [k]: v === "__none" ? undefined : v } }).catch((e) => toast.error(e.message));
  const sample = Object.fromEntries(ds.profile.map((c) => [c.name, c.sample]));
  const fields = SHOWN.map((k) => FIELDS.find((x) => x.key === k)!);
  const required = fields.filter((f) => f.required);
  const optional = fields.filter((f) => !f.required);
  const others = ds.columns.filter((c) => !used.has(c));

  return (
    <Page
      title="Detected Fields Preview"
      description={p.source.ai_mapped ? "We matched your columns from their names and values. Change any that look wrong." : "We matched your columns automatically. Change any that look wrong."}
      width="wide"
      mode="center"
    >
      <ViewOnlyArea role="analyst">
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="surface overflow-hidden">
          <div className="hidden grid-cols-[1.1fr_1fr_1.3fr] gap-6 border-b bg-muted/50 px-5 py-2.5 text-[12px] font-medium text-muted-foreground md:grid">
            <span>Your column</span>
            <span>Mapped field</span>
            <span>Sample values</span>
          </div>
          <ul className="divide-y">
            {fields.map((f) => {
              const k = f.key;
              const col = p.mapping[k];
              const samples = col ? (sample[col] ?? []) : [];
              return (
                <li key={k} className="grid items-center gap-2 px-5 py-2 md:grid-cols-[1.1fr_1fr_1.3fr] md:gap-6">
                  <Select value={col ?? "__none"} onValueChange={(v) => set(k, v)}>
                    <SelectTrigger className={cn("h-9 text-[13px]", !col && f.required && "border-warn")} aria-label={`Column for ${f.label}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">Not present in the data</SelectItem>
                      {ds.columns.map((c) => (
                        <SelectItem key={c} value={c} disabled={used.has(c) && c !== col}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="flex items-center gap-2 text-[13.5px] font-medium">
                    {col ? <CheckCircle2 className="h-4 w-4 shrink-0 text-good" /> : <CircleDashed className="h-4 w-4 shrink-0 text-muted-foreground/60" />}
                    {f.label}
                    {f.required && <span className="rounded bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground">Required</span>}
                  </span>
                  <span className="truncate text-[13px] text-muted-foreground">{samples.join(", ") || (col === ds.id_column ? "Protected ID" : "–")}</span>
                </li>
              );
            })}
          </ul>
        </div>

        <aside className="flex flex-col gap-4">
          <Soft>
            <Label>Mapping summary</Label>
            <div className="mt-4 space-y-4">
              {[
                ["Required fields", required.filter((f) => p.mapping[f.key]).length, required.length],
                ["Optional fields", optional.filter((f) => p.mapping[f.key]).length, optional.length],
              ].map(([k, a, b]) => (
                <div key={k as string}>
                  <div className="flex justify-between text-[13px]">
                    <span>{k}</span>
                    <span className="font-semibold tabular-nums">
                      {a} / {b}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 rounded-full bg-muted">
                    <div
                      className={cn("h-full rounded-full transition-[width] duration-300", a === b ? "bg-good" : "bg-primary")}
                      style={{ width: `${((a as number) / (b as number)) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Soft>
          <Soft className="flex min-h-0 flex-1 flex-col">
            <Label>Other columns ({others.length})</Label>
            <p className="mt-1 text-[12.5px] text-muted-foreground">Available as student information in Features.</p>
            <ul className="mt-3 max-h-[300px] min-h-0 space-y-1 overflow-y-auto pr-1 text-[13px]">
              {others.map((c) => (
                <li key={c} className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                  <span className="truncate" title={c}>
                    {friendly(c)} <span className="text-[11.5px] text-muted-foreground">({c})</span>
                  </span>
                </li>
              ))}
            </ul>
          </Soft>
        </aside>
      </div>
      </ViewOnlyArea>
      <NextBar onNext={() => projectStore.patch({ mapping_confirmed: true })} />
    </Page>
  );
}
