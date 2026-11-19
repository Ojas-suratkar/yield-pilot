import { useEffect, useSyncExternalStore } from "react";
import { Cpu,
  BarChart3,
  CalendarDays,
  ClipboardCheck,
  Database,
  FileText,
  Gauge,
  History,
  Home,
  LayoutGrid,
  Lightbulb,
  ListChecks,
  ListPlus,
  Play,
  Plug,
  Rocket,
  ShieldCheck,
  SlidersHorizontal,
  SlidersVertical,
  Sparkles,
  Target,
  TrendingUp,
  Upload,
  UserRound,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { API, streamForecast, type Project } from "./api";
import { fetchQuery, prefetch, useQuery, type Step } from "./query";

/* ------------------------------------------------------------------ steps */

export interface Sub {
  key: string;
  label: string;
  icon: LucideIcon;
  path: string;
}
export interface Section {
  key: string;
  label: string;
  icon: LucideIcon;
  step?: number;
  title?: string;
  blurb?: string;
  /** button text that leads into this section, from the mockups */
  cta: string;
  subs: Sub[];
}

/** Sidebar, steps and sub-steps. Titles and descriptions follow the YieldPilot mockups. */
export const SECTIONS: Section[] = [
  { key: "home", label: "Home", icon: Home, cta: "Home", subs: [{ key: "home", label: "Home", icon: Home, path: "/" }] },
  {
    key: "data",
    label: "Data Sources",
    icon: Database,
    step: 1,
    title: "Connect Data",
    blurb: "Bring in your admissions data from existing systems.",
    cta: "Start Step 1: Connect Data",
    subs: [
      { key: "source", label: "Choose a source", icon: Plug, path: "/data/source" },
      { key: "upload", label: "Upload your data", icon: Upload, path: "/data/upload" },
      { key: "fields", label: "Detected fields", icon: ListChecks, path: "/data/fields" },
    ],
  },
  {
    key: "audit",
    label: "Data Audit",
    icon: ShieldCheck,
    step: 2,
    title: "Check Readiness",
    blurb: "We'll review your data and let you know if you're good to go.",
    cta: "Continue to Data Check",
    subs: [
      { key: "readiness", label: "Overall readiness", icon: Gauge, path: "/audit/readiness" },
      { key: "fixes", label: "Recommended fixes", icon: Wrench, path: "/audit/fixes" },
    ],
  },
  {
    key: "setup",
    label: "Prediction Setup",
    icon: Target,
    step: 3,
    title: "Set Up Prediction",
    blurb: "Choose term, student type, and prediction settings.",
    cta: "Continue to Prediction Setup",
    subs: [
      { key: "term", label: "Pick term", icon: CalendarDays, path: "/setup/term" },
      { key: "group", label: "Pick population", icon: Users, path: "/setup/group" },
      { key: "training", label: "Pick training terms", icon: History, path: "/setup/training" },
    ],
  },
  {
    key: "features",
    label: "Features",
    icon: LayoutGrid,
    step: 4,
    title: "Choose Features",
    blurb: "Select the data factors to include in your model.",
    cta: "Continue to Features",
    subs: [
      { key: "starter", label: "Recommended features", icon: Sparkles, path: "/features/starter" },
      { key: "more", label: "Add or remove", icon: ListPlus, path: "/features/more" },
    ],
  },
  {
    key: "train",
    label: "Train & Predict",
    icon: Play,
    step: 5,
    title: "Run Prediction",
    blurb: "Generate your yield prediction with one click.",
    cta: "Continue to Train & Predict",
    subs: [
      { key: "review", label: "Review setup", icon: ClipboardCheck, path: "/train/review" },
      { key: "run", label: "Run prediction", icon: Rocket, path: "/train/run" },
    ],
  },
  {
    key: "results",
    label: "Results",
    icon: BarChart3,
    step: 6,
    title: "Review Results",
    blurb: "See predicted yield, key drivers, and model confidence.",
    cta: "See Results",
    subs: [
      { key: "forecast", label: "Yield forecast", icon: TrendingUp, path: "/results/forecast" },
      { key: "students", label: "Admit-level view", icon: UserRound, path: "/results/students" },
      { key: "model", label: "Model details", icon: Cpu, path: "/results/model" },
    ],
  },
  {
    key: "scenarios",
    label: "Scenarios",
    icon: SlidersHorizontal,
    step: 7,
    title: "Explore Scenarios",
    blurb: "Test what-if scenarios and find opportunities to improve yield.",
    cta: "Explore Scenarios",
    subs: [
      { key: "adjust", label: "Adjust your scenario", icon: SlidersVertical, path: "/scenarios/adjust" },
      { key: "actions", label: "Recommended actions", icon: Lightbulb, path: "/scenarios/actions" },
    ],
  },
  {
    key: "reports",
    label: "Reports",
    icon: FileText,
    cta: "Share Report",
    subs: [
      { key: "summary", label: "Executive summary", icon: Sparkles, path: "/reports/summary" },
      { key: "history", label: "Report history", icon: History, path: "/reports/history" },
    ],
  },
];

export const STEPS = SECTIONS.filter((s) => s.step);
export const stepSection = (n: number) => STEPS.find((s) => s.step === n)!;

/** Every page in order, for Back / Next. */
export const FLOW = SECTIONS.flatMap((s) => s.subs.map((sub, i) => ({ section: s, sub, index: i })));

/* ---------------------------------------------------------------- project */

export type { Project };
export const GROUP_LABEL = { FTF: "First-Time Freshman", TRN: "Transfer" } as const;
export const groupLabel = (p?: Project | null) => GROUP_LABEL[p?.setup.group ?? "FTF"];

const ACTIVE = "yieldpilot:project";
const SNAP = "yieldpilot:p:";
const local = {
  get: (k: string) => {
    try {
      return typeof window === "undefined" ? null : localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage full or blocked: the server copy is the source of truth anyway */
    }
  },
};

/** The last copy of the active project, so the app paints instantly while the server copy loads. */
function snapshot(): Project | undefined {
  const id = local.get(ACTIVE);
  const raw = id ? local.get(SNAP + id) : null;
  try {
    return raw ? (JSON.parse(raw) as Project) : undefined;
  } catch {
    return undefined;
  }
}

let current: Project | undefined = snapshot();
let synced = false;
let loading: Promise<Project> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function set(p: Project) {
  current = p;
  synced = true;
  local.set(ACTIVE, p.id);
  local.set(SNAP + p.id, JSON.stringify(p));
  emit();
  warm(p);
  return p;
}

/** Loads the active project from the server (or creates the first one). */
async function load(): Promise<Project> {
  const saved = local.get(ACTIVE);
  if (saved) {
    try {
      return set(await API.project(saved));
    } catch {
      /* deleted or another institution: fall through */
    }
  }
  // the workspace is shared: open your own most recent study, else the institution's most recent, else start one
  const list = await API.projects();
  const pick = list.find((x) => x.mine) ?? list[0];
  return set(pick ? await API.project(pick.id) : await API.createProject());
}

/* ----------------------------------------------------------------- queries */

export const rowsKey = (p: Project) => `rows:${p.id}:${p.dataset?.id}:${p.dataset?.version}`;
const dk = (p: Project) => `${p.id}:${p.dataset?.id}:${p.dataset?.version}:${JSON.stringify(p.mapping)}`;

/** Cache keys and fetchers for every read. Keys change exactly when the answer can change. */
export const Q = {
  audit: (p: Project) => [`audit:${dk(p)}`, () => API.audit(p.id)] as const,
  plan: (p: Project) => [`plan:${dk(p)}`, () => API.auditPlan(p.id)] as const,
  terms: (p: Project) => [`terms:${dk(p)}:${p.setup.term}:${p.setup.custom_terms?.length ?? 0}`, () => API.terms(p.id)] as const,
  features: (p: Project) => [`features:${dk(p)}`, () => API.features(p.id)] as const,
  history: (p: Project) => [`history:${p.id}:${p.forecast_id}:${p.forecast?.is_production}`, () => API.history(p.id)] as const,
  summary: (fid: string) => [`summary:${fid}`, () => API.summary(fid)] as const,
  levers: (fid: string) => [`levers:${fid}`, () => API.levers(fid)] as const,
  actions: (fid: string) => [`actions:${fid}`, () => API.actions(fid)] as const,
  ideas: (fid: string) => [`ideas:${fid}`, () => API.ideas(fid)] as const,
  allForecasts: (inst: string) => [`forecasts:${inst}`, () => API.allForecasts()] as const,
};

let warmed = "";
/** Prefetch the steps ahead in the background, so each page opens with its answer ready. */
function warm(p: Project) {
  if (!p.dataset || warmed === `${dk(p)}:${p.forecast_id}`) return;
  warmed = `${dk(p)}:${p.forecast_id}`;
  setTimeout(() => {
    prefetch(rowsKey(p), () => API.rows(p.id, 0, 200));
    prefetch(...Q.terms(p));
    prefetch(...Q.history(p));
    void fetchQuery(...Q.audit(p))
      .then((a) => (current?.id === p.id && current.audit?.score !== a.score ? projectStore.refresh() : undefined))
      .catch(() => undefined);
    void fetchQuery(...Q.features(p))
      .then(() => (current?.id === p.id && !current.features.selected?.length ? projectStore.refresh() : undefined))
      .catch(() => undefined);
    prefetch(...Q.plan(p));
    if (p.forecast && !p.stale) {  // an out-of-date forecast is about to be replaced: don't fetch its extras
      prefetch(...Q.levers(p.forecast.id));
      prefetch(...Q.actions(p.forecast.id));
      prefetch(...Q.summary(p.forecast.id));
      prefetch(...Q.ideas(p.forecast.id));
    }
  }, 200);
}

export const projectStore = {
  get: () => current,
  set,
  async refresh() {
    if (current) set(await API.project(current.id));
  },
  /** Optimistic: the screen updates at once, then takes the server's copy (or rolls back on error). */
  async patch(b: Parameters<typeof API.patchProject>[1]) {
    const before = current;
    if (!before) return;
    current = {
      ...before,
      ...(b.name !== undefined && { name: b.name }),
      ...(b.mapping && { mapping: b.mapping }),
      ...(b.mapping_confirmed !== undefined && { mapping_confirmed: b.mapping_confirmed }),
      ...(b.setup && { setup: { ...before.setup, ...b.setup } }),
      ...(b.features && { features: { ...before.features, ...b.features } }),
      ...(b.results_seen !== undefined && { results_seen: b.results_seen }),
      ...(b.scenarios_seen !== undefined && { scenarios_seen: b.scenarios_seen }),
      ...(b.audit_reviewed !== undefined && before.audit && { audit: { ...before.audit, reviewed: b.audit_reviewed } }),
    };
    emit();
    try {
      set(await API.patchProject(before.id, b));
    } catch (e) {
      set(before);
      throw e;
    }
  },
  /** A new prediction always starts at step 1, connecting its data (earlier data is offered there). */
  async startNew() {
    return set(await API.createProject());
  },
  /** Delete a prediction and its reports, then open the next one (or a fresh one). */
  async remove(id: string) {
    await API.deleteProject(id);
    if (current?.id !== id) return current;
    const list = await API.projects();
    return set(list.length ? await API.project(list[0].id) : await API.createProject());
  },
  async open(id: string) {
    return set(await API.project(id));
  },
  clear() {
    current = undefined;
    synced = false;
    loading = null;
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(SNAP) || k === ACTIVE)
        .forEach((k) => localStorage.removeItem(k));
    } catch {
      /* nothing stored */
    }
    emit();
  },
};

export function useProject(): Project | undefined {
  const p = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
    () => undefined,
  );
  useEffect(() => {
    // a viewer in a workspace with no studies yet can't start one: nothing to open, and no error to show
    if (!synced && !loading) loading = load().catch(() => current as Project).finally(() => (loading = null));
  }, []);
  return p;
}

/* --------------------------------------------------------------- progress */

export function stepDone(p: Project | undefined, step: number): boolean {
  if (!p) return false;
  switch (step) {
    case 1:
      return !!p.dataset && !!p.mapping.term && !!p.mapping.outcome && p.mapping_confirmed;
    case 2:
      return !!p.audit?.reviewed;
    case 3:
      return !!p.setup.term && (!!p.setup.group || !p.mapping.studentType) && !!p.setup.train_terms?.length;
    case 4:
      return !!p.features.confirmed && !!p.features.selected?.length;
    case 5:
      return !!p.forecast && !p.stale;
    case 6:
      return !!p.results_seen && !!p.forecast;
    case 7:
      return !!p.scenarios_seen;
    default:
      return false;
  }
}

export function currentStep(p: Project | undefined) {
  for (let s = 1; s <= 7; s++) if (!stepDone(p, s)) return s;
  return 7;
}

/* ------------------------------------------------------------------ runs */

/** A forecast run starts only from the Run button. `step` is the server's real progress (learning, then each later step);
 * the run belongs to one prediction, so switching predictions while it runs doesn't mix them up. */
let run = { running: false, project: "", step: undefined as Step | undefined, error: "" };
const runListeners = new Set<() => void>();
const setRun = (r: Partial<typeof run>) => {
  run = { ...run, ...r };
  runListeners.forEach((l) => l());
};

export function useRunner() {
  return useSyncExternalStore(
    (l) => (runListeners.add(l), () => runListeners.delete(l)),
    () => run,
    () => run,
  );
}

let stop: AbortController | null = null;
export async function runNow() {
  const p = current;
  if (!p || run.running) return;
  const abort = (stop = new AbortController());
  setRun({ running: true, project: p.id, step: { pct: 0, label: "Starting" }, error: "" });
  try {
    // progress never goes backwards
    const out = await streamForecast(p.id, (s) => (!run.step || s.pct >= run.step.pct) && setRun({ step: s }), abort.signal);
    if (current?.id === out.id) set(out);
    setRun({ running: false, step: { pct: 100, label: "Done" } });
  } catch (e) {
    setRun({ running: false, step: undefined, error: abort.signal.aborted ? "" : (e as Error).message });
  }
}

/** The Cancel button: stop the server's run and the wait for it. */
export function cancelRun() {
  if (!run.running) return;
  void API.cancelRun(run.project).catch(() => undefined);
  stop?.abort();
  setRun({ running: false, step: undefined, error: "" });
}

/** A cached read tied to the project: `useProjectQuery(p, Q.audit, !!p?.dataset)`. */
export function useProjectQuery<A, T>(arg: A | undefined, q: (a: A) => readonly [string, () => Promise<T>], when = true, maxAge = Infinity) {
  const [key, fn] = arg !== undefined && when ? q(arg) : [null, () => Promise.reject(new Error("unused"))];
  return useQuery<T>(key, fn, maxAge);
}
