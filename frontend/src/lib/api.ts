/** Typed client for the YieldPilot API. All data and logic live in the backend. */
import { store } from "@yield/core";
import { setStep, type Step } from "./query";

export const DEV_AUTH = process.env.NEXT_PUBLIC_AUTH_MODE === "dev";

export type Group = "FTF" | "TRN";
export type FieldKey = "studentId" | "term" | "outcome" | "admitStatus" | "studentType" | "college" | "major" | "residency" | "gpa" | "aid" | "housing";
export type Mapping = Partial<Record<FieldKey, string>>;

export interface ColumnProfile {
  name: string;
  kind: "numeric" | "boolean" | "date" | "categorical" | "text" | "identifier";
  missing_pct: number;
  distinct: number;
  sample: string[];
}

export interface Summary {
  recipe: string;
  model: string;
  target_term: string;
  group: Group | null;
  train_terms: string[];
  train_rows: number;
  features: string[];
  excluded_features: { feature: string; reason: string }[];
  applications: number;
  admits: number;
  expected: number;
  range: [number, number];
  yield: number;
  prior: { term: string; applications: number; admits: number; enrolled: number; yield: number } | null;
  actual: { enrolled: number; yield: number; known?: number } | null;
  backtest: {
    term: string; predicted: number; actual: number; error_pct: number; auc: number | null; brier: number; admits?: number;
    calibration?: { bin: number; n: number; predicted: number; actual: number }[];
  } | null;
  /** The term already happened: what really enrolled next to the forecast, for the admits with a recorded outcome.
   * The model never saw these outcomes; they are compared only after the forecast is made. */
  evaluation?: {
    roc_auc: number | null; pr_auc: number | null; brier: number; log_loss: number; accuracy: number; precision: number; recall: number; f1: number;
    threshold: number; admits: number; actual_enrolled: number; predicted_enrolled: number; error_pct: number;
    calibration: { bin: number; n: number; predicted: number; actual: number }[];
  };
  model_info?: {
    family: string; recipe: string; trees: number; depth: number; learning_rate: number; folds: number; calibration: string; recency_decay: number;
    train_terms: string[]; train_rows: number; train_enrolled: number; test_term: string; test_rows: number; columns: string[];
    excluded: { feature: string; reason: string }[]; row_order: string; seconds: number;
  };
  shrinkage?: { alpha: number; min_cohort: number; cycle_ratio: number; ratios: Record<string, number> };
  confidence: "High" | "Medium" | "Low";
  segments: Record<"high" | "medium" | "low", { n: number; expected: number }>;
  distribution: { bin: string; n: number; band: "high" | "medium" | "low" }[];
  trend: { term: string; actual?: number; projected?: number }[];
  funnel: { stage: string; value: number }[];
  drivers: { feature: string; share: number; direction: "up" | "down" | "mixed" }[];
  by_college: { college: string; admits: number; expected: number; yield: number; prior_yield: number | null }[];
  college_field: string | null;
  breakdowns: { field: string; rows: Breakdown[] }[];
  executive_summary?: string;
}

export interface Breakdown {
  value: string; admits: number; expected: number; yield: number;
  prior_admits: number | null; prior_enrolled: number | null; prior_yield: number | null;
}
export interface Registry { model: string; version: string | null; console: string; pending?: boolean; error?: string }

export interface Person { id: string; name: string | null }
export interface Project {
  id: string;
  name: string;
  /** who created the study (studies are shared by everyone in the institution) */
  owner?: Person;
  updated_by?: string | null;
  source: {
    connector?: string; label?: string; detail?: string; ai_mapped?: boolean;
    fit?: { ok: boolean; relevant: boolean; kind: string; summary: string; problems: string[] };
  };
  mapping: Mapping;
  mapping_confirmed: boolean;
  audit: { score: number; status: string; reviewed: boolean } | null;
  fixes_applied: string[];
  setup: { term?: string; group?: Group; train_terms?: string[]; custom_terms?: string[] };
  features: { selected?: string[]; ai?: string[]; confirmed?: boolean };
  forecast_id: string | null;
  stale: boolean;
  results_seen: boolean;
  scenarios_seen: boolean;
  updated_at: string | null;
  dataset: {
    id: string;
    version: number;
    filename: string;
    rows: number;
    columns: string[];
    id_column: string | null;
    dropped: { column: string; reason: string }[];
    warnings: string[];
    profile: ColumnProfile[];
    parent_version: number | null;
  } | null;
  forecast: { id: string; summary: Summary; created_at: string; is_production: boolean; registry: Registry | null; run_by?: Person } | null;
}

export interface Audit {
  score: number;
  status: string;
  checks: { key: string; title: string; value: string; status: "pass" | "warn" | "fail"; detail: string }[];
}

export interface Issue {
  id: string; title: string; severity: "high" | "medium" | "low"; column?: string; explanation: string; impact: string;
  op: string; columns?: string[]; pairs?: { from: string; to: string }[]; strategy?: string; value?: string; values?: string[];
}
export interface AuditPlan { summary: string; issues: Issue[]; source: "gemini" | "rules" }

export interface ConnectorField { key: string; label: string; placeholder: string; secret: boolean; optional: boolean; type: "text" | "textarea"; hint?: string }
/** One way to sign in to a system; all its fields are required. */
export interface AuthMethod { key: string; label: string; hint: string; fields: ConnectorField[] }
export interface Connector {
  kind: string; name: string; group: string; mono: string; color: string; blurb: string; help?: string;
  source: "sql" | "soql" | "file" | "none"; fields: ConnectorField[]; auth?: AuthMethod[];
}
export interface Conn { id: string; name: string; kind: string; source: Connector["source"]; where: string; last_used_at: string | null; by?: string | null; manage?: boolean }

export interface TermInfo {
  terms: {
    code: string; admits: number; known: number; has_outcomes: boolean; year: number; season: string;
    groups: Record<Group, number>; outcomes: Partial<Record<Group, { known: number; enrolled: number }>>;
  }[];
  past: string[];
  default_term: string | null;
  prior_term: string | null;
  recommended_train_terms: string[];
}

export interface FeatureProfile {
  name: string;
  category: string;
  kind: "number" | "category";
  missing_pct: number;
  distinct: number;
  min?: number | null;
  max?: number | null;
  top?: { value: string; count: number; rate: number | null }[];
  bins?: { label: string; n: number; rate: number }[];
  relevance: number;
  strength: string;
  direction?: "up" | "down";
  insight: string;
  excluded: string | null;
}

export interface Student { row: number; student: string; probability: number; band: "high" | "medium" | "low"; college: string; major: string; actual: number | null }
export interface Lever {
  feature: string; label: string; hint: string; action: string; kind: "pct" | "share" | "count"; min: number; max: number; step: number;
  /** something the office can do (aid, outreach, visits, decision speed), as opposed to a change in who is admitted */
  actionable?: boolean;
}
export interface HistoryRow {
  id: string; created_at: string; run_by?: string | null; run_by_id?: string; current: boolean; is_production: boolean; term: string; group: string; applications: number; admits: number;
  expected: number; yield: number; prior_yield: number | null; confidence: string; train_terms: string[]; features: number; dataset: string; shares: number;
  feature_names?: string[]; auc?: number | null; error_pct?: number | null; range?: [number, number];
  prior?: { term: string; applications: number; admits: number; enrolled: number; yield: number } | null;
}
const focusQs = (days: number, institution?: string, user?: string) =>
  new URLSearchParams({ days: String(days), ...(institution ? { institution_id: institution } : {}), ...(user ? { user_id: user } : {}) }).toString();
export interface MemberRunsRow {
  id: string; name: string | null; email: string; role: string; active: boolean; can_run: boolean; used: number; limit: number | null; custom: boolean;
  left: number | null; ai_questions: number; last_run_at: string | null;
}
export interface MemberRunsView {
  enforced: boolean; period_start: string; per_user_default: number | null; total: number | null; used: number; left: number | null; allotted: number;
  unallotted: number | null; members: MemberRunsRow[]; can_edit: boolean;
}
export type MlVal = number | string | null;
export type MlObjective = "roc_auc" | "pr_auc" | "f1" | "brier" | "error_pct";
export interface MlParam {
  key: string; group: string; label: string; help: string; kind: "int" | "float" | "choice"; min: number; max: number; options: string[] | null;
  /** the default (the workspace's own, when it has one) */
  default: MlVal;
  /** the research lab's value */
  lab: MlVal;
  used: MlVal; saved: MlVal;
}
export interface MlCandidate {
  name: string; why: string; source: string;
  /** changes from the defaults */
  params: Record<string, MlVal>;
  /** every setting's value */
  values?: Record<string, MlVal>;
  /** the AI's reason for each value */
  reasons?: Record<string, string>;
}
export type MlMetrics = Record<"roc_auc" | "pr_auc" | "brier" | "log_loss" | "accuracy" | "precision" | "recall" | "f1" | "error_pct", number | null>;
export interface MlResult {
  metrics: MlMetrics; predicted: number | null; actual: number | null; admits: number | null; family: string | null; seconds: number;
  roc: { fpr: number; tpr: number }[]; values?: Record<string, MlVal>;
}
export interface MlConfig { objective: MlObjective; rounds?: number; trials?: number; space?: Record<string, [number, number]>; note?: string }
export interface MlTest {
  id: string; mode: string; status: "running" | "stopping" | "done" | "failed" | "cancelled"; candidates: MlCandidate[]; results: MlResult[] | null; best: number | null;
  holdout: { target: string; train: string[] } | null; error: string | null; seconds: number | null; at: string;
  progress: { pct: number; label: string; detail: string; at: string } | null; config: MlConfig;
}
/** One experiment with every number: each candidate's values and scores. */
export interface MlExperiment {
  id: string; at: string; mode: string; status: string; objective: MlObjective; seconds: number | null; best: number | null;
  holdout: { target: string; train: string[] } | null; error: string | null;
  candidates: { name: string; why: string | null; source: string; params: Record<string, MlVal>; values: Record<string, MlVal> | null; metrics: MlMetrics | null;
    predicted: number | null; actual: number | null; seconds: number | null }[];
}
export interface MlSettings {
  project: { id: string; name: string }; can_edit: boolean; can_default: boolean; stale: boolean; params: MlParam[];
  workspace_default: { params: Record<string, MlVal>; by: string | null; at: string | null } | null;
  objectives: { key: MlObjective; label: string; higher: boolean }[];
  searchable: { key: string; scale: "lin" | "log"; from: number; to: number }[];
  last_run: { id: string; at: string; by: string | null; recorded: boolean; changed: string[]; family: string | null } | null;
  saved_by: string | null; saved_at: string | null; can_tune: boolean;
  suggestions: { id: string; at: string; candidates: MlCandidate[] } | null; test: MlTest | null;
  history: MlExperiment[];
  forecast: {
    term: string | null; expected: number | null; seconds: number | null; drivers: { feature: string; share: number; direction: string }[];
    evaluation: MlMetrics | null;
  } | null;
}
export interface MlMember {
  id: string; name: string | null; email: string; role: string; active: boolean; always: boolean; granted: boolean; granted_by: string | null; granted_at: string | null;
}
export interface Me {
  id: string; email: string; name: string | null; title: string | null; department: string | null; photo: string | null; role: string;
  /** YieldPilot staff: sees the operator dashboard */
  operator?: boolean;
  /** can open the ML workspace (admins and owners, or given access) */
  ml?: boolean;
  /** every workspace this person can use; they switch between them from the workspace menu */
  workspaces?: { id: string; name: string; logo: string | null; role: string; current: boolean; personal: boolean; domain: string | null; people: number }[];
  /** null until they create or join an institution (the welcome screen) */
  institution: { id: string; name: string; domain: string | null; personal: boolean; logo?: string | null; website?: string | null } | null;
}
export interface InstitutionCard {
  id: string; name: string; logo: string | null; website: string | null; kind: string | null; country: string | null; region: string | null; members: number;
}
export type JoinAction = "join" | "request" | "invite_only";
export interface Onboarding {
  invitations: { id: string; role: string; invited_by: string | null; created_at: string; institution: InstitutionCard }[];
  suggestions: (InstitutionCard & { action: JoinAction })[];
  requests: { id: string; created_at: string; institution: InstitutionCard }[];
  email_domain: string | null;
  member_of: { id: string; name: string; personal: boolean } | null;
}
export interface OrgPreview {
  domain: string; found: boolean; website: string; name: string; logo: string | null; description: string | null; kind: string;
  country: string | null; region: string | null; claimable: boolean; existing: (InstitutionCard & { action: JoinAction }) | null;
}
export interface InstitutionProfile {
  id: string; name: string; logo: string | null; website: string | null; description: string | null; kind: string | null; country: string | null;
  region: string | null; domain: string | null; members: number; join_policy: "domain" | "request" | "invite"; default_role: string;
  discoverable: boolean; join_code: string | null; join_code_enabled: boolean | null; invite_url: string | null; claimable_domain: string | null;
  created_at: string;
}
export interface JoinRequestRow { id: string; name: string | null; email: string; photo: string | null; message: string | null; created_at: string }
export type SignInMethod = "google" | "microsoft" | "email";
export type Limits = Record<"seats" | "runs_per_user" | "runs_per_institution" | "rows_per_dataset" | "storage_gb" | "ai_questions" | "scenarios_per_study" | "history_months", number | null>;
export interface PlanInfo { key: string; name: string; price_month: number | null; price_year: number | null; limits: Limits; features: string[]; self_serve: boolean }
export interface Invoice { id: string; amount: number; currency: string; status: string; description: string | null; url: string | null; pdf?: string | null; created_at: string; institution?: string; test_mode?: boolean }
export interface Billing {
  plan: string | null; status: string; interval: string | null; seats: number | null; current_period_end: string | null; limits: Limits; enforced: boolean;
  usage: { seats: number; pending_invites: number; runs_month: number; ai_questions: number; storage_gb: number; period_start: string; runs_by_user: { name: string; runs: number }[] };
  plans: PlanInfo[]; invoices: Invoice[]; payments_ready: boolean; test_mode: boolean; has_customer: boolean; cancel_at_period_end: boolean;
}
export interface AdminOverview {
  institutions: number; users: number; active_users: number; runs_month: number; runs_failed_month: number; avg_run_seconds: number;
  mrr_cents: number; revenue_month_cents: number; failed_payments: number; plan_mix: { label: string; value: number }[];
  runs_per_day: { day: string; runs: number }[]; signups_per_week: { week: string; users: number }[]; revenue_per_month: { month: string; cents: number }[];
}
export interface AdminInstitution {
  id: string; name: string; domain: string; personal: boolean; created_at: string; plan: string | null; plan_name: string | null; status: string;
  interval: string | null; custom_limits: Partial<Limits>; seats_used: number; pending_invites: number; runs_month: number; studies: number;
  paid_cents: number; mrr_cents: number; last_active: string | null; suspended: boolean; join_policy: "domain" | "request" | "invite"; logo?: string | null; website?: string | null;
}
export interface AdminInstitutionDetail {
  id: string; name: string; logo: string | null; website: string | null; domain: string | null; personal: boolean; description: string | null;
  kind: string | null; country: string | null; region: string | null; created_at: string; join_policy: "domain" | "request" | "invite";
  default_role: string; discoverable: boolean; suspended: boolean; invite_url: string | null; plan: string | null; plan_name: string | null;
  status: string; interval: string | null; custom_limits: Partial<Limits>; mrr_cents: number; paid_cents: number; studies: number; runs_month: number;
  pending_requests: number;
  members: { id: string; name: string | null; email: string; photo: string | null; role: string; active: boolean; last_login_at: string | null; runs_month: number }[];
  invitations: { id: string; email: string; role: string; created_at: string }[];
}
export interface AdminUser {
  id: string; email: string; name: string | null; institution_id: string | null; institution: string; role: string; active: boolean; created_at: string;
  last_login_at: string | null; runs_month: number; ml: boolean; runs_30: number; run_seconds_30: number; cpu_seconds_30: number; ai_calls_30: number;
  tokens_30: number; imports_30: number; cost_30: number; last_active_at: string | null;
  workspaces: { id: string; name: string; role: string; active: boolean; current: boolean }[];
}
export interface Member {
  id: string; email: string; name: string | null; title: string | null; department: string | null; photo: string | null;
  role: string; active: boolean; you: boolean; last_login_at: string | null;
}
export interface Notice { id: string; kind: string; title: string; body: string | null; link: string | null; read: boolean; created_at: string }

function authHeaders(): Record<string, string> {
  return DEV_AUTH ? { "X-Dev-User": store.get().user?.email ?? "" } : {};
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders(), ...((init.headers as Record<string, string>) ?? {}) };
  if (init.body && typeof init.body === "string") headers["Content-Type"] = "application/json";
  const res = await fetch(`/api/v1${path}`, { ...init, headers });
  if (!res.ok) throw await failure(res, path);
  return res.json() as Promise<T>;
}

async function failure(res: Response, path: string): Promise<Error> {
  if (res.status === 409 && !path.startsWith("/onboarding") && !path.startsWith("/me")) {
    const body = await res.clone().json().catch(() => ({}));
    if (body.detail === "onboarding_required" && window.location.pathname !== "/welcome" && !window.location.pathname.startsWith("/admin")) window.location.assign("/welcome"); // an operator needs no workspace for the dashboard
  }
  if (res.status === 401 && !DEV_AUTH && !path.startsWith("/me")) {
    store.signOut();
    try {
      localStorage.removeItem("yieldpilot:me");
      sessionStorage.setItem("yp:next", window.location.pathname + window.location.search); // back here after signing in again
    } catch {
      /* storage blocked */
    }
    window.location.assign("/login");
  }
  const body = await res.json().catch(() => ({}));
  return new Error(typeof body.detail === "string" ? body.detail : `Request failed (${res.status})`);
}

/** A long request with real progress: the server streams {pct, label, detail} lines, then the result. */
export async function streaming<T>(path: string, init: RequestInit, onStep: (s: Step) => void): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders(), Accept: "application/x-ndjson" };
  if (typeof init.body === "string") headers["Content-Type"] = "application/json";
  const res = await fetch(`/api/v1${path}`, { ...init, headers });
  if (!res.ok || !res.body) throw await failure(res, path);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as Partial<Step> & { done?: boolean; result?: T; error?: string | Record<string, unknown> };
      if (msg.error) {
        // a structured refusal (e.g. more rows than the plan allows) keeps its details for the screen to act on
        const info = typeof msg.error === "object" ? msg.error : undefined;
        throw Object.assign(new Error(info ? String(info.message ?? "That couldn't be done.") : (msg.error as string)), { info });
      }
      if (msg.done) return msg.result as T;
      if (msg.pct !== undefined) onStep({ pct: msg.pct, label: msg.label ?? "", detail: msg.detail });
    }
  }
  throw new Error("The connection closed before this finished. Please try again.");
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

async function authCall<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/auth${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(typeof out.detail === "string" ? out.detail : "Sign-in isn't available right now."), { status: res.status });
  return out as T;
}

export type UsageScope = "institution" | "me";
export interface UsageTotals {
  runs: number; done: number; failed: number; cancelled: number; seconds: number; avg_seconds: number; ai_calls: number; input_tokens: number; output_tokens: number;
  imports: number; rows_imported: number; run_cost: number; ai_cost: number; import_cost: number; storage_gb: number; storage_cost: number; total_cost: number;
}
export interface UsagePoint { at: string; done: number; failed: number; cancelled: number; run_cost: number; ai_cost: number; import_cost: number }
export interface UsageReport {
  days: number; unit: "day" | "month"; since: string; scope: UsageScope; totals: UsageTotals; previous: UsageTotals; series: UsagePoint[];
  by_person: (UsageTotals & { id: string; name: string; last_at: string })[];
  by_study: { id: string; name: string; runs: number; done: number; failed: number; cancelled: number; seconds: number; cost: number; last_at: string }[];
  by_purpose: { purpose: string; label: string; kind: "ai" | "import"; count: number; tokens: number; seconds: number; rows: number; cost: number }[];
  by_model: { model: string; calls: number; input_tokens: number; output_tokens: number; cost: number }[];
  /** how many runs' costs are Google's actual hourly charges, and how many are still estimates (Google bills a few hours late) */
  run_costs?: { from_bill: number; estimated: number; billed_until: string | null };
}
export type OperatorInstitutionCost = UsageTotals & { id: string; name: string; logo: string | null; domain: string | null; website: string | null; people: number; collected_cents: number };
export interface OperatorCosts extends UsageReport {
  meters: { available: boolean; reason?: string; services?: { service: string; billed_hours: number; requests: number }[] };
  actual: { connected: boolean; reason?: string; source?: "export"; detailed?: boolean; first_day?: string | null; by_sku?: { name: string; cost: number }[]; total?: number;
    gross?: number; credits?: number; currency?: string; as_of?: string | null; by_service?: { name: string; cost: number }[]; by_day?: { day: string; cost: number }[];
    by_resource?: { name: string; detail: string; cost: number; kept_ready: number }[] };
  /** "google" when the totals are Google's bill; items are what it was spent on */
  source?: "google"; estimate_total?: number; items?: { label: string; detail: string; period: number }[];
  fixed: { label: string; detail: string; monthly: number; period: number }[]; fixed_total: number; fixed_monthly: number; usage_total: number; grand_total: number;
  cost_per_run: number | null; collected_cents: number; margin: number; by_institution: OperatorInstitutionCost[]; rates: { item: string; price: string }[];
}
export interface RowPage<T> { rows: T[]; more: boolean }
export interface OperatorPerson { email: string; name: string | null; photo: string | null; main: boolean; signed_up: boolean; last_login_at: string | null; added_at: string | null; added_by: string | null }
export interface RunRow {
  id: string; at: string; by: string; by_id: string; institution: string; study: string; project_id: string | null; forecast_id: string | null;
  outcome: "done" | "failed" | "cancelled"; seconds: number | null; cost: number; billed: boolean; kind: "forecast" | "tuning"; cpu_seconds: number | null; peak_memory_mb: number | null; vcpu: number; memory_gib: number; error: string | null; term: string | null; group: string | null; admits: number | null; expected: number | null;
}
export interface EventRow {
  id: string; at: string; by: string; by_id: string; institution: string; kind: "ai" | "import"; what: string; model: string | null; tokens: number; seconds: number | null; rows: number | null; cost: number;
}

export const API = {
  discover: (email: string) => authCall<{ method: SignInMethod; note?: string | null }>(`/discover?email=${encodeURIComponent(email)}`),
  providers: () => authCall<{ microsoft: boolean; google: boolean; email: boolean; dev: boolean; microsoft_any?: boolean }>("/providers"),
  emailStart: (email: string) => authCall<{ sent: boolean; code?: boolean }>("/email/start", { email }),
  emailFinish: (b: { token?: string; code?: string; oob_code?: string; hint?: string; email?: string }) => authCall<{ ok: boolean }>("/email/finish", b),
  billing: () => api<Billing>("/billing"),
  memberRuns: () => api<MemberRunsView>("/billing/members"),
  setMemberRuns: (userId: string, runs: number | null) => api<MemberRunsView>(`/billing/members/${userId}/runs`, json("PUT", { runs })),
  adminInstitutionRuns: (id: string) => api<MemberRunsView>(`/admin/institutions/${id}/runs`),
  adminSetInstitutionRuns: (id: string, userId: string, runs: number | null) => api<MemberRunsView>(`/admin/institutions/${id}/runs/${userId}`, json("PUT", { runs })),
  quota: () => api<{ enforced: boolean; runs_used_me: number; runs_limit_me: number | null; runs_used: number; runs_limit: number | null; rows_limit: number | null }>("/billing/quota"),
  checkout: (plan: string, interval: "month" | "year") => api<{ url: string }>("/billing/checkout", json("POST", { plan, interval })),
  billingPortal: () => api<{ url: string }>("/billing/portal", json("POST", {})),
  adminOverview: () => api<AdminOverview>("/admin/overview"),
  adminInstitutions: () => api<AdminInstitution[]>("/admin/institutions"),
  adminCreateInstitution: (b: { name: string; domain: string; plan?: string | null; owner_email?: string; join_policy?: string }) =>
    api<{ id: string }>("/admin/institutions", json("POST", b)),
  adminUpdateInstitution: (id: string, b: Partial<{ name: string; plan: string | null; status: string; custom_limits: Partial<Limits>; suspended: boolean; join_policy: string }>) =>
    api(`/admin/institutions/${id}`, json("PATCH", b)),
  adminDeleteInstitution: (id: string, confirm: string) => api(`/admin/institutions/${id}/delete`, json("POST", { confirm })),
  adminInstitution: (id: string) => api<AdminInstitutionDetail>(`/admin/institutions/${id}`),
  adminCancelInvitation: (institutionId: string, invitationId: string) => api(`/admin/institutions/${institutionId}/invitations/${invitationId}`, json("DELETE")),
  adminAddMember: (institutionId: string, email: string, role: string) => api(`/admin/institutions/${institutionId}/members`, json("POST", { email, role })),
  adminUsers: (q = "") => api<AdminUser[]>(`/admin/users?q=${encodeURIComponent(q)}`),
  adminUpdateUser: (id: string, b: Partial<{ role: string; active: boolean; institution_id: string }>) => api(`/admin/users/${id}`, json("PATCH", b)),
  adminDeleteUser: (id: string) => api(`/admin/users/${id}`, { method: "DELETE" }),
  adminPayments: () => api<Invoice[]>("/admin/payments"),
  adminPlans: () => api<PlanInfo[]>("/admin/plans"),
  adminOperators: () => api<{ can_manage: boolean; operators: OperatorPerson[] }>("/admin/operators"),
  adminAddOperator: (email: string) => api("/admin/operators", json("POST", { email })),
  adminRemoveOperator: (email: string) => api(`/admin/operators/${encodeURIComponent(email)}`, json("DELETE")),
  adminCosts: (days: number) => api<OperatorCosts>(`/admin/costs?days=${days}`),
  adminRuns: (days: number, institution?: string, user?: string) => api<RowPage<RunRow>>(`/admin/runs?${focusQs(days, institution, user)}`),
  adminEvents: (days: number, institution?: string, user?: string) => api<RowPage<EventRow>>(`/admin/events?${focusQs(days, institution, user)}`),
  adminUsage: (days: number, institution?: string, user?: string) => api<UsageReport>(`/admin/usage?${focusQs(days, institution, user)}`),
  adminSignOut: (id: string) => api(`/admin/users/${id}/signout`, json("POST", {})),
  adminSetMl: (id: string, granted: boolean) => api(`/admin/users/${id}/ml`, json("PUT", { granted })),
  usage: (days: number, scope: UsageScope) => api<UsageReport>(`/usage?days=${days}&scope=${scope}`),
  usageRuns: (days: number, scope: UsageScope) => api<RowPage<RunRow>>(`/usage/runs?days=${days}&scope=${scope}`),
  usageEvents: (days: number, scope: UsageScope) => api<RowPage<EventRow>>(`/usage/events?days=${days}&scope=${scope}`),
  me: () => api<Me>("/me"),
  switchWorkspace: (institutionId: string) => api<Me>("/me/workspace", json("POST", { institution_id: institutionId })),
  adminSetWorkspace: (userId: string, institutionId: string, role: string) => api(`/admin/users/${userId}/workspaces/${institutionId}`, json("PUT", { role })),
  adminRemoveWorkspace: (userId: string, institutionId: string) => api(`/admin/users/${userId}/workspaces/${institutionId}`, { method: "DELETE" }),
  mlSettings: (projectId: string) => api<MlSettings>(`/ml/projects/${projectId}`),
  /** The settings this prediction's forecast runs use. */
  mlSave: (projectId: string, params: Record<string, MlVal>, note?: string) => api<MlSettings>(`/ml/projects/${projectId}`, json("PUT", { params, note })),
  /** Make these the workspace's default settings (admins and owners). */
  mlMakeDefault: (projectId: string, params: Record<string, MlVal>, note?: string) => api<MlSettings>(`/ml/projects/${projectId}/default`, json("PUT", { params, note })),
  mlClearDefault: (projectId: string) => api<MlSettings>(`/ml/projects/${projectId}/default`, { method: "DELETE" }),
  mlReset: (projectId: string) => api<MlSettings>(`/ml/projects/${projectId}`, { method: "DELETE" }),
  mlRecommend: (projectId: string) => api<MlSettings>(`/ml/projects/${projectId}/recommend`, json("POST", {})),
  /** Starts a settings test on the server and answers at once; follow it with mlWatch. */
  mlTune: (projectId: string, b: { mode: string; params?: Record<string, MlVal>; trials?: number; space?: Record<string, [number, number]>; objective: MlObjective }) =>
    api<MlSettings>(`/ml/projects/${projectId}/tune`, json("POST", b)),
  /** The running test's progress, then the workspace with its results ({again: true} when the watch should simply start again). */
  mlWatch: (projectId: string, onStep: (s: Step) => void, signal?: AbortSignal) =>
    streaming<MlSettings | { again: true }>(`/ml/projects/${projectId}/tune/watch`, { signal }, onStep),
  mlTuneCancel: (projectId: string) => api<MlSettings>(`/ml/projects/${projectId}/tune/cancel`, json("POST", {})),
  trimOptions: (projectId: string) => api<TrimSummary & { limit: number | null }>(`/projects/${projectId}/data/trim`),
  trimData: (projectId: string, keep: Keep) => api<Project>(`/projects/${projectId}/data/trim`, json("POST", keep)),
  mlAccess: () => api<MlMember[]>("/ml/access"),
  mlSetAccess: (userId: string, granted: boolean) => api(`/ml/access/${userId}`, json("PUT", { granted })),
  updateMe: (b: { name?: string; title?: string; department?: string }) => api<Me>("/me", json("PATCH", b)),
  setPhoto: (photo: string) => api<Me>("/me/photo", json("PUT", { photo })),
  removePhoto: () => api<Me>("/me/photo", json("DELETE")),
  members: () => api<Member[]>("/members"),
  updateMember: (id: string, b: { role?: string; active?: boolean }) => api(`/members/${id}`, json("PATCH", b)),
  deleteMember: (id: string) => api<{ ok: boolean; account_deleted: boolean }>(`/members/${id}`, json("DELETE")),
  invitations: () => api<{ id: string; email: string; role: string; created_at: string }[]>("/invitations"),
  invite: (email: string, role: string) => api("/invitations", json("POST", { email, role })),
  cancelInvite: (id: string) => api(`/invitations/${id}`, json("DELETE")),
  notifications: () => api<Notice[]>("/notifications"),
  readNotifications: (ids: string[] = []) => api("/notifications/read", json("POST", { ids })),

  projects: () => api<{
    id: string; name: string; updated_at: string; owner: Person; mine: boolean; updated_by: string | null;
    last_run: { by: string | null; at: string; expected: number } | null;
  }[]>("/projects"),
  createProject: () => api<Project>("/projects", json("POST", {})),
  project: (id: string) => api<Project>(`/projects/${id}`),
  patchProject: (id: string, b: Partial<Pick<Project, "name" | "mapping" | "mapping_confirmed" | "setup" | "features" | "results_seen" | "scenarios_seen">> & { audit_reviewed?: boolean }) =>
    api<Project>(`/projects/${id}`, json("PATCH", b)),
  deleteProject: (id: string) => api(`/projects/${id}`, json("DELETE")),
  cancelRun: (id: string) => api(`/projects/${id}/forecasts/cancel`, json("POST")),
  deleteData: (id: string) => api<Project>(`/projects/${id}/data`, json("DELETE")),
  reuseData: (id: string, dataset_id: string) => api<Project>(`/projects/${id}/data/reuse`, json("POST", { dataset_id })),
  datasets: () => api<{ id: string; name: string; created_at: string; latest_version: number; rows: number | null; columns: number | null; by?: string | null; mine?: boolean }[]>("/datasets"),
  deleteForecast: (fid: string) => api(`/forecasts/${fid}`, json("DELETE")),
  rows: (id: string, offset: number, limit: number, view: { sort?: string; desc?: boolean; col?: string; q?: string } = {}) =>
    api<{ total: number; columns: string[]; rows: (Record<string, string> & { _row: number })[]; can_undo: boolean }>(
      `/projects/${id}/rows?${new URLSearchParams({ offset: String(offset), limit: String(limit), ...Object.fromEntries(Object.entries(view).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])) })}`,
    ),
  edit: (id: string, b: { op: "delete_rows" | "delete_columns" | "edit_cell"; rows?: number[]; columns?: string[]; row?: number; column?: string; value?: string }) =>
    api<Project>(`/projects/${id}/edits`, json("POST", b)),
  undo: (id: string) => api<Project>(`/projects/${id}/undo`, json("POST")),
  audit: (id: string) => api<Audit>(`/projects/${id}/audit`),
  /** The AI review streams its progress under `plan:<project>`, so the readiness pages can show it. */
  auditPlan: (id: string) => streaming<AuditPlan>(`/projects/${id}/audit/plan`, {}, (s) => setStep(`plan:${id}`, s)).finally(() => setStep(`plan:${id}`, null)),
  fix: (id: string, ids: string[]) => api<Project>(`/projects/${id}/fixes`, json("POST", { ids })),
  chat: (id: string, question: string, history: { role: string; text: string }[]) =>
    api<{ answer: string }>(`/projects/${id}/chat`, json("POST", { question, history })),
  terms: (id: string) => api<TermInfo>(`/projects/${id}/terms`),
  addTerm: (id: string, season: string, year: number) => api<Project>(`/projects/${id}/terms`, json("POST", { season, year })),
  features: (id: string) => api<{ profiles: FeatureProfile[]; recommended: string[] }>(`/projects/${id}/features`),
  runForecast: (id: string) => api<Project>(`/projects/${id}/forecasts`, json("POST")),
  history: (id: string) => api<HistoryRow[]>(`/projects/${id}/forecasts`),
  openForecast: (id: string, fid: string) => api<Project>(`/projects/${id}/forecasts/${fid}/open`, json("POST")),

  students: (fid: string, q: { band?: string; q?: string; college?: string; major?: string; sort?: string; desc?: boolean; offset: number; limit: number }) =>
    api<{ total: number; rows: Student[]; facets: { college: string[]; major: string[] } | null }>(
      `/forecasts/${fid}/students?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]))}`,
    ),
  factors: (fid: string, row: number) => api<{ feature: string; effect: number; value: string }[]>(`/forecasts/${fid}/students/${row}/factors`),
  levers: (fid: string) => api<Lever[]>(`/forecasts/${fid}/levers`),
  scenario: (fid: string, values: Record<string, number>) =>
    api<{ baseline_expected: number; baseline_yield: number; expected: number; yield: number; gain: number }>(`/forecasts/${fid}/scenario`, json("POST", { values })),
  actions: (fid: string) => api<{ actions: (Lever & { step: number; lift: number })[]; combined: number; baseline: number }>(`/forecasts/${fid}/actions`),
  forecastInfo: (fid: string) =>
    api<{ id: string; summary: Summary; created_at: string; owned: boolean; member?: boolean; group: string; by: string | null; is_production: boolean }>(`/forecasts/${fid}`),
  summary: (fid: string, fresh = false) => api<{ text: string }>(`/forecasts/${fid}/summary${fresh ? "?fresh=true" : ""}`),
  saveSummary: (fid: string, text: string) => api<{ text: string }>(`/forecasts/${fid}/summary`, json("PUT", { text })),
  share: (fid: string, b: { recipients: string[]; files: string[]; message?: string }) =>
    api<{ ok: boolean; recipients: string[]; invited: string[] }>(`/forecasts/${fid}/share`, json("POST", b)),
  promote: (fid: string) => api<{ registry: Registry | null; error: string | null }>(`/forecasts/${fid}/promote`, json("POST")),
  ideas: (fid: string) =>
    api<{ scenarios: { title: string; rationale: string; values: Record<string, number>; expected: number; gain: number; yield: number }[]; plans: Record<string, string> }>(
      `/forecasts/${fid}/ideas`,
    ),
  allForecasts: () => api<(HistoryRow & { project_id: string; project: string; mine: boolean; manage: boolean; shared_by: string | null })[]>("/forecasts"),
  onboarding: () => api<Onboarding>("/onboarding"),
  orgPreview: (value: string) => api<OrgPreview>("/onboarding/preview", json("POST", { value })),
  createInstitution: (b: { name: string; website?: string | null; kind?: string | null; country?: string | null; region?: string | null; description?: string | null; logo?: string | null; claim_domain: boolean }) =>
    api<{ id: string; name: string }>("/onboarding/institutions", json("POST", b)),
  codePreview: (code: string) => api<InstitutionCard & { role: string; member: boolean }>(`/onboarding/code/${encodeURIComponent(code)}`),
  joinWithCode: (code: string) => api<{ id: string; name: string }>("/onboarding/code", json("POST", { code })),
  findInstitution: (website: string) => api<{ found: (InstitutionCard & { action: JoinAction; member: boolean }) | null }>(`/onboarding/find?website=${encodeURIComponent(website)}`),
  requestToJoin: (institution_id: string, message?: string) =>
    api<{ joined: boolean; requested?: boolean; name: string }>("/onboarding/requests", json("POST", { institution_id, message })),
  cancelRequest: (id: string) => api(`/onboarding/requests/${id}`, json("DELETE")),
  answerInvitation: (id: string, accept: boolean) => api<{ ok: boolean; name: string }>(`/onboarding/invitations/${id}`, json("POST", { accept })),
  institution: () => api<InstitutionProfile>("/institution"),
  updateInstitution: (b: Partial<Omit<InstitutionProfile, "id" | "members" | "invite_url" | "claimable_domain" | "created_at" | "domain">> & { claim_domain?: boolean; rotate_code?: boolean }) =>
    api<InstitutionProfile>("/institution", json("PATCH", b)),
  refreshInstitution: () => api<InstitutionProfile>("/institution/refresh", json("POST", {})),
  joinRequests: () => api<JoinRequestRow[]>("/institution/requests"),
  decideRequest: (id: string, approve: boolean, role?: string) => api(`/institution/requests/${id}`, json("POST", { approve, role })),
  registry: (fid: string) => api<Registry | null>(`/forecasts/${fid}/registry`),
  exportUrl: (fid: string, format: "csv" | "txt") => `/api/v1/forecasts/${fid}/export?format=${format}`,

  connectors: () => api<Connector[]>("/connectors"),
  connections: () => api<Conn[]>("/connections"),
  createConnection: (b: { kind: string; name: string; values: Record<string, string> }) =>
    api<Conn & { warehouse_state?: string | null }>("/connections", json("POST", b)),
  deleteConnection: (cid: string) => api(`/connections/${cid}`, json("DELETE")),
  tables: (cid: string) => api<{ name: string; type: "TABLE" | "VIEW" }[]>(`/connections/${cid}/tables`),
  preview: (cid: string, b: { table?: string; query?: string; path?: string }, onStep: (s: Step) => void = () => undefined, signal?: AbortSignal) =>
    streaming<{ columns: string[]; rows: Record<string, string>[] }>(`/connections/${cid}/preview`, { ...json("POST", b), signal }, onStep),
  importFrom: (cid: string, b: { project_id: string; table?: string; query?: string; path?: string; trim?: Keep }, onStep: (s: Step) => void, signal?: AbortSignal) =>
    streaming<Project>(`/connections/${cid}/import`, { ...json("POST", b), signal }, onStep),
};

/** Run a forecast and follow the server's progress (one JSON line per stage, plus a heartbeat). */
export const streamForecast = (projectId: string, onStep: (s: Step) => void, signal?: AbortSignal) =>
  streaming<Project>(`/projects/${projectId}/forecasts/stream`, { method: "POST", signal }, onStep);

/** Downloads through fetch so dev auth headers and the session cookie both apply. */
export async function download(url: string) {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error("Download failed.");
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "download";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await res.blob());
  a.download = name;
  a.click();
}

/** Two-step upload: the file goes straight to storage (byte progress), then the backend validates, cleans and
 * versions it (step progress). Sending the file is the first 40% of the bar. */
export type TrimMode = "recent" | "first" | "sample";
/** Which rows to keep when data has more than the plan allows. The server decides how many: never more than the plan. */
export interface Keep {
  mode: TrimMode | "terms" | "rows" | "values"; terms?: string[]; start?: number; end?: number; column?: string; values?: string[]; then?: TrimMode;
}
/** Exact counts for choosing rows: rows per term, and the values of short-list columns. */
export interface TrimSummary {
  rows: number; term_column: string | null; terms: { value: string; rows: number }[]; columns: { name: string; values: { value: string; rows: number }[] }[];
}
/** More rows than the plan allows: the server kept the file and offers to choose which of its rows to keep. */
export interface OverPlan extends TrimSummary { code: "rows_over_plan"; message: string; limit: number; upload_id: string | null }
export const overPlan = (e: unknown) => ((e as { info?: OverPlan }).info?.code === "rows_over_plan" ? (e as { info: OverPlan }).info : null);

/** Finish an upload the server kept, keeping only the plan's number of rows (chosen on the server). */
export async function finishUpload(uploadId: string, projectId: string, trim: Keep, onStep: (s: Step) => void): Promise<Project> {
  const done = await streaming<{ project: Project }>(`/datasets/uploads/${uploadId}/complete`, json("POST", { project_id: projectId, trim }), onStep);
  return done.project;
}

export async function uploadToProject(file: File, projectId: string, onStep: (s: Step) => void): Promise<Project> {
  const start = await api<{ upload_id: string; upload_url: string; headers: Record<string, string> }>("/datasets/uploads", json("POST", {
    filename: file.name, size: file.size, content_type: file.type || "application/octet-stream",
  }));
  const local = start.upload_url.startsWith("/");
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
  const SEND = 40;
  onStep({ pct: 0, label: "Uploading your file", detail: `0 of ${mb(file.size)}` });
  await new Promise<void>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", start.upload_url);
    Object.entries({ ...(local ? authHeaders() : {}), ...start.headers }).forEach(([k, v]) => x.setRequestHeader(k, v));
    x.upload.onprogress = (e) =>
      e.lengthComputable && onStep({ pct: (e.loaded / e.total) * SEND, label: "Uploading your file", detail: `${mb(e.loaded)} of ${mb(e.total)}` });
    x.onload = () => (x.status < 300 ? resolve() : reject(new Error("The file upload failed. Please try again.")));
    x.onerror = () => reject(new Error("The file upload failed. Check your connection and try again."));
    x.send(file);
  });
  const done = await streaming<{ project: Project }>(`/datasets/uploads/${start.upload_id}/complete`, json("POST", { project_id: projectId }), (s) =>
    onStep({ ...s, pct: SEND + (s.pct * (100 - SEND)) / 100 }),
  );
  return done.project;
}
