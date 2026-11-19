import { useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import * as D from "@radix-ui/react-dialog";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Trash2,
  Activity, AlertTriangle, Building2, ChevronRight, Copy, CreditCard, ExternalLink, LayoutGrid, Loader2, Mail, Play, Plus, Receipt, Search, ShieldCheck, ShieldOff, TrendingUp, UserPlus, Users,
  Wallet, X,
} from "lucide-react";
import { toast } from "sonner";
import { cn, fmtDate } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Input } from "@yield/core/ui/input";
import { MemberRuns } from "../components/MemberRuns";
import { ConfirmDelete, Failed, Loading, SortTh, useTable } from "../components/ui";
import { CostsTab, RunsTab, type Focus } from "./OperatorCosts";
import { Kpi, duration, usd } from "./Usage";
import { API, type AdminInstitution, type AdminUser, type PlanInfo } from "../lib/api";
import { useSession } from "../lib/auth";
import { useQuery } from "../lib/query";
import { money } from "./Billing";
import { copy } from "./Institution";
import { ROLE_INFO } from "./Team";
import { Crest } from "./Welcome";

const axis = { stroke: "hsl(var(--muted-foreground))", fontSize: 11, tickLine: false, axisLine: false } as const;
const tip = { borderRadius: 12, border: "1px solid hsl(var(--border))", fontSize: 12 };
const STATUSES = ["full_access", "free", "trialing", "active", "past_due", "canceled"];
const STATUS: Record<string, { label: string; tone: string }> = {
  full_access: { label: "Full access", tone: "bg-primary/10 text-primary" },
  free: { label: "Free", tone: "bg-muted text-muted-foreground" },
  trialing: { label: "Trial", tone: "bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  active: { label: "Active", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  past_due: { label: "Payment due", tone: "bg-amber-500/15 text-amber-800 dark:text-amber-300" },
  canceled: { label: "Cancelled", tone: "bg-muted text-muted-foreground" },
};
const JOIN: Record<string, string> = { domain: "Domain joins at once", request: "Asks to join", invite: "Invite only" };
const field = "h-9 w-full rounded-lg border border-input bg-card px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring";
const ago = (iso: string | null) => {
  if (!iso) return "Never";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 30 ? `${days} days ago` : fmtDate(iso);
};

function Badge({ children, tone = "bg-muted text-foreground/80" }: { children: React.ReactNode; tone?: string }) {
  return <span className={cn("inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold", tone)}>{children}</span>;
}

function Avatar({ name, photo, size = 32 }: { name: string; photo?: string | null; size?: number }) {
  return photo ? (
    <img src={photo} alt="" referrerPolicy="no-referrer" style={{ width: size, height: size }} className="shrink-0 rounded-full object-cover" />
  ) : (
    <span style={{ width: size, height: size }} className="grid shrink-0 place-items-center rounded-full bg-secondary text-[11.5px] font-semibold uppercase">
      {name.slice(0, 2)}
    </span>
  );
}

function BarsCard({ title, data, x, y, fmt = (v) => v.toLocaleString() }: { title: string; data: Record<string, unknown>[]; x: string; y: string; fmt?: (v: number) => string }) {
  return (
    <div className="surface p-4">
      <div className="mb-2 text-[13px] font-semibold">{title}</div>
      {data.length ? (
        <div className="h-[170px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 6, right: 8, left: -10, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey={x} {...axis} tickFormatter={(v: string) => (v.length > 7 ? v.slice(5) : v)} minTickGap={12} />
              <YAxis {...axis} width={44} allowDecimals={false} tickFormatter={(v: number) => fmt(v)} />
              <Tooltip contentStyle={tip} formatter={(v: number) => [fmt(v), title]} cursor={{ fill: "hsl(var(--muted) / 0.5)" }} />
              <Bar dataKey={y} fill="var(--series-ours)" radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="grid h-[170px] place-items-center text-[13px] text-muted-foreground">Nothing yet</p>
      )}
    </div>
  );
}

/** A panel that slides in from the right, for managing one institution or one person. */
function Sheet({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: React.ReactNode; title: string }) {
  return (
    <D.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <D.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[560px] flex-col border-l bg-background shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-right"
        >
          <D.Title className="sr-only">{title}</D.Title>
          <D.Close className="absolute right-4 top-4 rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close">
            <X className="h-4 w-4" />
          </D.Close>
          <div className="flex-1 overflow-y-auto">{children}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="border-t px-6 py-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function InstitutionPanel({ id, plans, onChanged, onClose }: { id: string | null; plans: PlanInfo[]; onChanged: () => void; onClose: () => void }) {
  const q = useQuery(id ? `admin:institution:${id}` : null, () => API.adminInstitution(id!), 0);
  const [confirmName, setConfirmName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("analyst");
  const [busy, setBusy] = useState<string | null>(null);
  const i = q.data;
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      await q.reload();
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet open={!!id} onClose={onClose} title={i?.name ?? "Institution"}>
      {!i ? (
        q.error ? <div className="p-6"><Failed error={q.error} retry={q.reload} /></div> : <Loading text="Loading the institution…" />
      ) : (
        <>
          <div className="flex items-start gap-4 px-6 pb-5 pt-6">
            <Crest inst={i} size={56} />
            <div className="min-w-0 flex-1 pr-6">
              <h2 className="text-[18px] font-semibold leading-snug tracking-[-0.02em]">{i.name}</h2>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground">
                {i.personal ? <span>Personal workspace</span> : i.domain && <span>@{i.domain}</span>}
                {[i.region, i.country].filter(Boolean).length > 0 && <span>{[i.region, i.country].filter(Boolean).join(", ")}</span>}
                {i.website && (
                  <a href={i.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                    {i.website.replace(/^https?:\/\//, "")} <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {i.plan_name && <Badge>{i.plan_name}</Badge>}
                <Badge tone={STATUS[i.status]?.tone}>{STATUS[i.status]?.label ?? i.status}</Badge>
                {i.suspended && <Badge tone="bg-destructive/10 text-destructive">Suspended</Badge>}
                <span className="text-[12px] text-muted-foreground">since {fmtDate(i.created_at)}</span>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-4 border-t">
            {[
              ["People", String(i.members.filter((m) => m.active).length)],
              ["Predictions", String(i.studies)],
              ["Forecasts this month", String(i.runs_month)],
              ["Income each month", i.mrr_cents ? money(i.mrr_cents) : "–"],
            ].map(([k, v]) => (
              <div key={k} className="border-r px-4 py-3 last:border-r-0">
                <div className="text-[11.5px] text-muted-foreground">{k}</div>
                <div className="text-[17px] font-semibold tabular-nums">{v}</div>
              </div>
            ))}
          </div>

          <Section title="Plan">
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1 text-[12.5px] font-medium">
                Plan
                <select className={field} value={i.plan ?? ""} disabled={!!busy}
                  onChange={(e) => run("plan", () => API.adminUpdateInstitution(i.id, { plan: e.target.value || null }), "Plan updated")}>
                  <option value="">No plan</option>
                  {plans.map((p) => (
                    <option key={p.key} value={p.key}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-[12.5px] font-medium">
                Status
                <select className={field} value={i.status} disabled={!!busy}
                  onChange={(e) => run("status", () => API.adminUpdateInstitution(i.id, { status: e.target.value }), "Status updated")}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>{STATUS[s].label}</option>
                  ))}
                </select>
              </label>
            </div>
          </Section>

          {!i.personal && (
            <Section title="Joining">
              <div className="grid gap-2">
                {(["request", "domain", "invite"] as const).map((k) => (
                  <label key={k} className={cn("flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-[13px]", i.join_policy === k && "border-primary/40 bg-primary/[0.04]",
                    k === "domain" && !i.domain && "opacity-50")}>
                    <input type="radio" name="join" checked={i.join_policy === k} disabled={!!busy || (k === "domain" && !i.domain)} className="accent-[hsl(var(--primary))]"
                      onChange={() => run("join", () => API.adminUpdateInstitution(i.id, { join_policy: k }), "Joining updated")} />
                    {JOIN[k]}
                    {k === "domain" && i.domain && <span className="text-muted-foreground">(@{i.domain})</span>}
                  </label>
                ))}
              </div>
              {i.invite_url && (
                <div className="mt-3 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-lg border bg-muted/40 px-3 py-2 text-[12px]">{i.invite_url}</code>
                  <Button variant="outline" size="sm" onClick={() => copy(i.invite_url!, "Invite link copied")}>
                    <Copy className="h-3.5 w-3.5" /> Copy
                  </Button>
                </div>
              )}
              {i.pending_requests > 0 && <p className="mt-2 text-[12.5px] text-muted-foreground">{i.pending_requests} request(s) waiting for its admins.</p>}
            </Section>
          )}

          <Section title="Runs this month">
            <MemberRuns flat id={i.id} load={() => API.adminInstitutionRuns(i.id)} save={(u, runs) => API.adminSetInstitutionRuns(i.id, u, runs)} />
          </Section>
          <Section title={`People (${i.members.length})`}>
            <form
              className="mb-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run("invite", () => API.adminAddMember(i.id, email.trim(), role), `Invited ${email.trim()}`).then(() => setEmail(""));
              }}
            >
              <div className="relative flex-1">
                <Mail className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Add someone by email" className="h-9 pl-8" />
              </div>
              <select className={cn(field, "w-36")} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
                {Object.entries(ROLE_INFO).map(([k, r]) => (
                  <option key={k} value={k}>{r.label}</option>
                ))}
              </select>
              <Button type="submit" size="sm" className="h-9" disabled={busy === "invite" || !email.trim()}>
                {busy === "invite" ? <Loader2 className="animate-spin" /> : <UserPlus className="h-4 w-4" />} Invite
              </Button>
            </form>
            <ul className="divide-y rounded-xl border">
              {i.members.map((m) => (
                <li key={m.id} className={cn("flex items-center gap-3 px-3 py-2.5", !m.active && "opacity-50")}>
                  <Avatar name={m.name || m.email} photo={m.photo} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{m.name || m.email}</div>
                    <div className="truncate text-[11.5px] text-muted-foreground">
                      {m.email} · {ago(m.last_login_at)} · {m.runs_month} forecast{m.runs_month === 1 ? "" : "s"} this month
                    </div>
                  </div>
                  <select className={cn(field, "h-8 w-32 text-[12.5px]")} value={m.role} disabled={!!busy} aria-label={`Role of ${m.name || m.email}`}
                    onChange={(e) => run(`role-${m.id}`, () => API.adminUpdateUser(m.id, { role: e.target.value }), "Role updated")}>
                    {Object.entries(ROLE_INFO).map(([k, r]) => (
                      <option key={k} value={k}>{r.label}</option>
                    ))}
                  </select>
                </li>
              ))}
              {!i.members.length && <li className="px-3 py-4 text-center text-[13px] text-muted-foreground">No one has joined yet.</li>}
            </ul>
            {i.invitations.length > 0 && (
              <>
                <div className="mb-2 mt-4 text-[12.5px] font-medium">Invited, not joined yet</div>
                <ul className="divide-y rounded-xl border">
                  {i.invitations.map((v) => (
                    <li key={v.id} className="flex items-center gap-3 px-3 py-2">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{v.email}</span>
                      <Badge>{ROLE_INFO[v.role]?.label ?? v.role}</Badge>
                      <button className="text-[12px] text-muted-foreground hover:text-destructive"
                        onClick={() => run(`inv-${v.id}`, () => API.adminCancelInvitation(i.id, v.id), "Invitation cancelled")}>
                        Cancel
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Section>

          <Section title="Access">
            <div className="flex items-center justify-between gap-4 rounded-xl border border-destructive/20 bg-destructive/[0.03] p-4">
              <div className="text-[13px]">
                <div className="font-medium">{i.suspended ? "Suspended" : "Suspend this institution"}</div>
                <div className="text-muted-foreground">{i.suspended ? "No one here can use YieldPilot until it's reactivated." : "Everyone here is blocked at once. Their data stays."}</div>
              </div>
              <Button variant={i.suspended ? "default" : "outline"} disabled={!!busy}
                onClick={() => run("suspend", () => API.adminUpdateInstitution(i.id, { suspended: !i.suspended }), i.suspended ? "Reactivated" : "Suspended")}>
                {i.suspended ? "Reactivate" : <><ShieldOff className="h-4 w-4" /> Suspend</>}
              </Button>
            </div>
            <div className="mt-3 rounded-xl border border-destructive/40 p-4 text-[13px]">
              <div className="font-medium text-destructive">Delete this institution</div>
              <div className="text-muted-foreground">
                Removes its predictions, data, forecasts, files, invitations, usage and billing records for good. People keep their accounts and any
                other workspaces. This can't be undone.
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={`Type ${i.name} to confirm`}
                  aria-label="Type the institution's name to confirm" className="h-9 min-w-[220px] flex-1" />
                <Button variant="destructive" disabled={!!busy || confirmName.trim().toLowerCase() !== i.name.trim().toLowerCase()}
                  onClick={async () => {
                    setBusy("delete");
                    try {
                      await API.adminDeleteInstitution(i.id, confirmName);
                      toast.success(`${i.name} is deleted`);
                      setConfirmName("");
                      onChanged();
                      onClose();
                    } catch (e) {
                      toast.error((e as Error).message);
                    } finally {
                      setBusy(null);
                    }
                  }}>
                  {busy === "delete" ? <Loader2 className="animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete institution
                </Button>
              </div>
            </div>
          </Section>
        </>
      )}
    </Sheet>
  );
}

function PersonPanel({ user, institutions, onChanged, onClose, openInstitution, onViewUsage }: {
  user: AdminUser | null; institutions: AdminInstitution[]; onChanged: () => void; onClose: () => void; openInstitution: (id: string) => void;
  onViewUsage: (u: AdminUser) => void;
}) {
  const [busy, setBusy] = useState(false);
  const save = async (b: Parameters<typeof API.adminUpdateUser>[1], ok: string) => {
    if (!user) return;
    setBusy(true);
    try {
      await API.adminUpdateUser(user.id, b);
      toast.success(ok);
      onChanged();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      onChanged();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const always = user?.role === "admin" || user?.role === "owner";
  return (
    <Sheet open={!!user} onClose={onClose} title={user?.name || user?.email || "Person"}>
      {user && (
        <>
          <div className="flex items-center gap-4 px-6 pb-5 pt-6">
            <Avatar name={user.name || user.email} size={52} />
            <div className="min-w-0 pr-6">
              <h2 className="truncate text-[18px] font-semibold tracking-[-0.02em]">{user.name || user.email}</h2>
              <div className="truncate text-[13px] text-muted-foreground">{user.email}</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Badge>{ROLE_INFO[user.role]?.label ?? user.role}</Badge>
                {!user.active && <Badge tone="bg-destructive/10 text-destructive">Disabled</Badge>}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-3 border-t">
            {[["Joined", fmtDate(user.created_at)], ["Last sign-in", ago(user.last_login_at)], ["Forecasts this month", String(user.runs_month)]].map(([k, v]) => (
              <div key={k} className="border-r px-4 py-3 last:border-r-0">
                <div className="text-[11.5px] text-muted-foreground">{k}</div>
                <div className="text-[15px] font-semibold">{v}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-4 border-t">
            {[["Forecasts", String(user.runs_30)], ["CPU time", duration(user.cpu_seconds_30)], ["AI calls", String(user.ai_calls_30)], ["Cost", usd(user.cost_30)]].map(([k, v]) => (
              <div key={k} className="border-r px-4 py-3 last:border-r-0">
                <div className="text-[11.5px] text-muted-foreground">{k}</div>
                <div className="text-[15px] font-semibold tabular-nums">{v}</div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between border-t px-6 py-2 text-[12px] text-muted-foreground">
            <span>Last 30 days, at Google's prices</span>
            <button className="font-medium text-primary hover:underline" onClick={() => onViewUsage(user)}>See every run and AI call →</button>
          </div>
          <Section title={`Workspaces (${user.workspaces.length})`}>
            {user.workspaces.length ? (
              <ul className="mb-3 divide-y rounded-xl border">
                {user.workspaces.map((w) => {
                  const wi = institutions.find((x) => x.id === w.id);
                  return (
                    <li key={w.id} className="flex flex-wrap items-center gap-2 p-3">
                      <button onClick={() => openInstitution(w.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                        {wi && <Crest inst={wi} size={24} />}
                        <span className="truncate text-[13px] font-medium hover:underline">{w.name}</span>
                        {w.current && <Badge>Working in</Badge>}
                        {!w.active && <Badge tone="bg-destructive/10 text-destructive">No access</Badge>}
                      </button>
                      <select className={cn(field, "h-8 w-[150px]")} value={w.role} disabled={busy} aria-label={`Role in ${w.name}`}
                        onChange={(e) => void act(() => API.adminSetWorkspace(user.id, w.id, e.target.value), `Role in ${w.name} updated`)}>
                        {Object.entries(ROLE_INFO).map(([k, r]) => (
                          <option key={k} value={k}>{r.label}</option>
                        ))}
                      </select>
                      <Button size="sm" variant="ghost" className="h-8 text-destructive" disabled={busy}
                        onClick={() => void act(() => API.adminRemoveWorkspace(user.id, w.id), `Removed from ${w.name}`)}>
                        Remove
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mb-3 text-[13px] text-muted-foreground">Hasn't created or joined a workspace yet.</p>
            )}
            <label className="space-y-1 text-[12.5px] font-medium">
              Add to a workspace
              <select className={field} value="" disabled={busy}
                onChange={(e) => e.target.value && void act(() => API.adminSetWorkspace(user.id, e.target.value, "viewer"), "Added. They can switch to it from the workspace menu.")}>
                <option value="">Choose a workspace</option>
                {institutions.filter((x) => !user.workspaces.some((w) => w.id === x.id)).map((x) => (
                  <option key={x.id} value={x.id}>{x.name}</option>
                ))}
              </select>
            </label>
            <p className="mt-1.5 text-[12px] text-muted-foreground">They join as a viewer; change the role above. People can belong to several workspaces and switch between them.</p>
          </Section>
          <Section title="Access">
            <div className="flex items-center justify-between gap-4 rounded-xl border p-4">
              <div className="text-[13px]">
                <div className="font-medium">{user.active ? "Can sign in" : "Disabled"}</div>
                <div className="text-muted-foreground">{user.active ? "Disabling signs them out everywhere at once." : "They can't sign in until enabled."}</div>
              </div>
              <Button variant={user.active ? "outline" : "default"} disabled={busy} onClick={() => save({ active: !user.active }, user.active ? "Disabled" : "Enabled")}>
                {user.active ? "Disable" : "Enable"}
              </Button>
            </div>
          </Section>
          <Section title="More controls">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-4 rounded-xl border p-4">
                <div className="text-[13px]">
                  <div className="font-medium">ML workspace</div>
                  <div className="text-muted-foreground">{always ? "Always on for admins and owners." : user.ml ? "Can change the model settings of their predictions." : "Can't open the ML workspace."}</div>
                </div>
                {!always && user.institution_id && user.role !== "guest" && (
                  <Button variant="outline" disabled={busy} onClick={() => void act(() => API.adminSetMl(user.id, !user.ml), user.ml ? "ML workspace removed" : "ML workspace given")}>
                    {user.ml ? "Remove" : "Give access"}
                  </Button>
                )}
              </div>
              <div className="flex items-center justify-between gap-4 rounded-xl border p-4">
                <div className="text-[13px]">
                  <div className="font-medium">Sign out everywhere</div>
                  <div className="text-muted-foreground">Ends their sessions on every device. They can sign in again.</div>
                </div>
                <Button variant="outline" disabled={busy} onClick={() => void act(() => API.adminSignOut(user.id), "Signed out on every device")}>Sign out</Button>
              </div>
            </div>
          </Section>
          <Section title="Delete">
            <div className="flex items-center justify-between gap-4 rounded-xl border border-destructive/30 p-4">
              <div className="text-[13px]">
                <div className="font-medium">Delete this person</div>
                <div className="text-muted-foreground">They're signed out at once and would have to sign up again. Work they shared stays, shown as "Former member".</div>
              </div>
              <ConfirmDelete label="Delete user" confirm="Click again to delete" onConfirm={async () => {
                try {
                  await API.adminDeleteUser(user.id);
                  toast.success(`${user.name || user.email} is deleted.`);
                  onChanged();
                  onClose();
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }} />
            </div>
          </Section>
        </>
      )}
    </Sheet>
  );
}

function NewInstitution({ plans, open, onClose, onDone }: { plans: PlanInfo[]; open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const [f, setF] = useState({ name: "", domain: "", plan: "", owner_email: "", join_policy: "request" });
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await API.adminCreateInstitution({ ...f, domain: f.domain.trim().toLowerCase(), plan: f.plan || null, owner_email: f.owner_email.trim() || undefined });
      toast.success(`${f.name} created${f.owner_email ? `; ${f.owner_email} is invited as owner` : ""}`);
      setF({ name: "", domain: "", plan: "", owner_email: "", join_policy: "request" });
      onDone(r.id);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <D.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <D.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-background p-6 shadow-2xl outline-none">
          <D.Title className="text-[18px] font-semibold tracking-[-0.02em]">Set up an institution for a customer</D.Title>
          <p className="mt-1 text-[13px] text-muted-foreground">
            For a customer you onboard yourself, such as an Enterprise contract paid by invoice: choose its plan and invite its owner. People can also create
            their own institution when they sign up. Its logo, website and location are filled in from the email domain.
          </p>
          <form onSubmit={submit} className="mt-5 grid gap-3">
            <label className="space-y-1 text-[12.5px] font-medium">
              Name <span className="text-destructive">*</span>
              <Input required value={f.name} onChange={set("name")} placeholder="University of New South Wales" />
            </label>
            <label className="space-y-1 text-[12.5px] font-medium">
              Email domain <span className="text-destructive">*</span>
              <Input required value={f.domain} onChange={set("domain")} placeholder="unsw.edu.au" />
            </label>
            <label className="space-y-1 text-[12.5px] font-medium">
              Owner's email
              <Input type="email" value={f.owner_email} onChange={set("owner_email")} placeholder="director@unsw.edu.au" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1 text-[12.5px] font-medium">
                Plan
                <select className={field} value={f.plan} onChange={set("plan")}>
                  <option value="">Full access</option>
                  {plans.map((p) => (
                    <option key={p.key} value={p.key}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-[12.5px] font-medium">
                Joining
                <select className={field} value={f.join_policy} onChange={set("join_policy")}>
                  {Object.entries(JOIN).map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Plus className="h-4 w-4" />} Create institution
              </Button>
            </div>
          </form>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** A row action that stays on screen however wide the table gets. */
const stickyCell = "sticky right-0 bg-card px-3 py-2 text-right shadow-[-12px_0_12px_-12px_hsl(var(--border))]";

function InstitutionsTable({ rows, q, onOpen }: { rows: AdminInstitution[]; q: string; onOpen: (id: string) => void }) {
  const t = useTable(rows as (AdminInstitution & Record<string, unknown>)[], { key: "last_active", desc: true }, (i) => `${i.name} ${i.domain ?? ""} ${i.plan_name ?? ""} ${i.status}`);
  const shown = t.shown.filter((i) => !q.trim() || `${i.name} ${i.domain ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="surface overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-[13px]">
          <thead className="border-b bg-muted/30 text-left text-[11.5px] font-semibold text-muted-foreground">
            <tr>
              <SortTh label="Institution" k="name" sort={t.sort} onSort={t.setSort} className="py-2.5 pl-4" />
              <SortTh label="People" k="seats_used" sort={t.sort} onSort={t.setSort} className="py-2.5 text-right [&>button]:justify-end" />
              <SortTh label="Forecasts this month" k="runs_month" sort={t.sort} onSort={t.setSort} className="py-2.5 text-right [&>button]:justify-end" />
              <th className="px-4 py-2.5">Plan</th>
              <th className="px-4 py-2.5">Joining</th>
              <SortTh label="Last active" k="last_active" sort={t.sort} onSort={t.setSort} className="py-2.5" />
              <th className={cn(stickyCell, "bg-muted/30 py-2.5")} />
            </tr>
          </thead>
          <tbody className="divide-y">
            {shown.map((i) => (
              <tr key={i.id} onClick={() => onOpen(i.id)} className={cn("cursor-pointer transition-colors hover:bg-muted/40", i.suspended && "bg-destructive/[0.03]")}>
                <td className="py-2.5 pl-4 pr-4">
                  <div className="flex items-center gap-3">
                    <Crest inst={i} size={34} />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{i.name}</div>
                      <div className="truncate text-[11.5px] text-muted-foreground">{i.personal ? "Personal workspace" : (i.domain ?? i.website?.replace(/^https?:\/\//, "") ?? "No domain")}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {i.seats_used}
                  {i.pending_invites ? <span className="text-muted-foreground"> +{i.pending_invites} invited</span> : null}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{i.runs_month}</td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {i.plan_name && <Badge>{i.plan_name}</Badge>}
                    <Badge tone={STATUS[i.status]?.tone}>{STATUS[i.status]?.label ?? i.status}</Badge>
                    {i.suspended && <Badge tone="bg-destructive/10 text-destructive">Suspended</Badge>}
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{i.personal ? "–" : JOIN[i.join_policy]}</td>
                <td className="whitespace-nowrap px-4 py-2.5">{ago(i.last_active)}</td>
                <td className={stickyCell}>
                  <Button size="sm" variant="outline" className="h-8" onClick={(e) => (e.stopPropagation(), onOpen(i.id))}>
                    Manage <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!shown.length && <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">{q ? "No institution matches." : "No institutions yet."}</p>}
    </div>
  );
}

function PeopleTable({ rows, q, institutions, onOpen }: { rows: AdminUser[]; q: string; institutions: AdminInstitution[]; onOpen: (u: AdminUser) => void }) {
  const t = useTable(rows as (AdminUser & Record<string, unknown>)[], { key: "last_login_at", desc: true }, (u) => `${u.name ?? ""} ${u.email} ${u.institution} ${u.role}`);
  const shown = t.shown.filter((u) => !q.trim() || `${u.name ?? ""} ${u.email} ${u.institution}`.toLowerCase().includes(q.trim().toLowerCase()));
  const byId = useMemo(() => Object.fromEntries(institutions.map((i) => [i.id, i])), [institutions]);
  return (
    <div className="surface overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1120px] text-[13px]">
          <thead className="border-b bg-muted/30 text-left text-[11.5px] font-semibold text-muted-foreground">
            <tr>
              <SortTh label="Person" k="email" sort={t.sort} onSort={t.setSort} className="py-2.5 pl-4" />
              <SortTh label="Institution" k="institution" sort={t.sort} onSort={t.setSort} className="py-2.5" />
              <SortTh label="Role" k="role" sort={t.sort} onSort={t.setSort} className="py-2.5" />
              <SortTh label="Forecasts (30 days)" k="runs_30" sort={t.sort} onSort={t.setSort} className="py-2.5 text-right [&>button]:justify-end" />
              <SortTh label="CPU time" k="cpu_seconds_30" sort={t.sort} onSort={t.setSort} className="py-2.5 text-right [&>button]:justify-end" />
              <SortTh label="AI calls" k="ai_calls_30" sort={t.sort} onSort={t.setSort} className="py-2.5 text-right [&>button]:justify-end" />
              <SortTh label="Cost (30 days)" k="cost_30" sort={t.sort} onSort={t.setSort} className="py-2.5 text-right [&>button]:justify-end" />
              <SortTh label="Last sign-in" k="last_login_at" sort={t.sort} onSort={t.setSort} className="py-2.5" />
              <th className={cn(stickyCell, "bg-muted/30 py-2.5")} />
            </tr>
          </thead>
          <tbody className="divide-y">
            {shown.map((u) => {
              const inst = u.institution_id ? byId[u.institution_id] : null;
              return (
                <tr key={u.id} onClick={() => onOpen(u)} className={cn("cursor-pointer transition-colors hover:bg-muted/40", !u.active && "opacity-60")}>
                  <td className="py-2.5 pl-4 pr-4">
                    <div className="flex items-center gap-3">
                      <Avatar name={u.name || u.email} />
                      <div className="min-w-0">
                        <div className="truncate font-medium">{u.name || u.email}</div>
                        <div className="truncate text-[11.5px] text-muted-foreground">{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {inst ? (
                      <span className="flex items-center gap-2">
                        <Crest inst={inst} size={22} />
                        <span className="max-w-[220px] truncate">{inst.name}</span>
                        {u.workspaces.length > 1 && <span className="shrink-0 text-[11px] text-muted-foreground">+{u.workspaces.length - 1} more</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{u.institution}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge>{ROLE_INFO[u.role]?.label ?? u.role}</Badge>
                    {!u.active && <Badge tone="ml-1 bg-destructive/10 text-destructive">Disabled</Badge>}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{u.runs_30}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">{u.cpu_seconds_30 ? duration(u.cpu_seconds_30) : "–"}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{u.ai_calls_30}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">{usd(u.cost_30)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5">{ago(u.last_login_at)}</td>
                  <td className={stickyCell}>
                    <Button size="sm" variant="outline" className="h-8" onClick={(e) => (e.stopPropagation(), onOpen(u))}>
                      Manage <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!shown.length && <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">{q ? "No one matches." : "No one has signed up yet."}</p>}
    </div>
  );
}

function PaymentsTable({ q }: { q: string }) {
  const p = useQuery("admin:payments", API.adminPayments, 30_000);
  const [status, setStatus] = useState<"all" | "failed" | "open" | "paid">("all");
  if (p.error) return <Failed error={p.error} retry={p.reload} />;
  if (!p.data) return <Loading text="Loading payments…" />;
  const all = p.data.filter((x) => !q.trim() || `${x.institution ?? ""} ${x.description ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  const rows = all.filter((x) => status === "all" || x.status === status);
  const label = { all: "All", failed: "Failed", open: "Unpaid", paid: "Paid" } as const;
  const tone: Record<string, string> = { paid: STATUS.active.tone, open: STATUS.trialing.tone, failed: "bg-destructive/10 text-destructive", void: STATUS.canceled.tone };
  return (
    <div className="surface overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 text-[12.5px]">
        {(["all", "failed", "open", "paid"] as const).map((s) => {
          const count = s === "all" ? all.length : all.filter((x) => x.status === s).length;
          return (
            <button key={s} onClick={() => setStatus(s)}
              className={cn("rounded-full px-3 py-1 font-medium", status === s ? "bg-primary text-primary-foreground" : s === "failed" && count ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground hover:text-foreground")}>
              {label[s]} ({count})
            </button>
          );
        })}
        <span className="ml-auto text-muted-foreground">Failed: Stripe couldn't charge the card. Unpaid: the invoice is still open.</span>
      </div>
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead className="border-b bg-muted/30 text-left text-[11.5px] font-semibold text-muted-foreground">
              <tr>
                <th className="py-2.5 pl-4 pr-4">Date</th>
                <th className="px-4 py-2.5">Institution</th>
                <th className="px-4 py-2.5">Description</th>
                <th className="px-4 py-2.5 text-right">Amount</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((x) => (
                <tr key={x.id}>
                  <td className="whitespace-nowrap py-2.5 pl-4 pr-4">{fmtDate(x.created_at)}</td>
                  <td className="px-4 py-2.5">{x.institution}</td>
                  <td className="px-4 py-2.5">
                    {x.url ? <a href={x.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">{x.description ?? "Invoice"}</a> : (x.description ?? "Invoice")}
                  </td>
                  <td className="px-4 py-2.5 text-right font-medium tabular-nums">{money(x.amount, x.currency)}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={tone[x.status]}>{x.status}</Badge>
                    {x.test_mode && <Badge tone="ml-1 bg-amber-500/15 text-amber-800">Test</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex flex-col items-center px-4 py-12 text-center">
          <CreditCard className="h-7 w-7 text-muted-foreground" />
          <p className="mt-2 text-[13.5px] font-medium">No payments yet</p>
          <p className="text-[12.5px] text-muted-foreground">Invoices appear here as Stripe sends them, once payments are connected.</p>
        </div>
      )}
    </div>
  );
}

/** Who can open this dashboard. Only a main operator (named in the deployment settings) can add or remove people. */
function OperatorsTab() {
  const q = useQuery("admin:operators", API.adminOperators, 15_000);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  if (q.error) return <Failed error={q.error} retry={q.reload} />;
  const list = q.data;
  if (!list) return <Loading text="Loading operators…" />;
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await API.adminAddOperator(email.trim());
      toast.success(`${email.trim()} now has operator access`);
      setEmail("");
      await q.reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="surface overflow-hidden p-0">
      <div className="border-b p-4">
        <div className="text-[13.5px] font-semibold">Who can open this dashboard</div>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          Operators see every institution, person, cost and payment on YieldPilot, and can change plans and access. They can't open an institution's student records.
        </p>
        {list.can_manage ? (
          <form onSubmit={add} className="mt-3 flex max-w-[520px] gap-2">
            <div className="relative flex-1">
              <Mail className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Add someone by email" aria-label="Email to give operator access" className="h-9 pl-8" />
            </div>
            <Button type="submit" size="sm" className="h-9" disabled={busy || !email.trim()}>
              {busy ? <Loader2 className="animate-spin" /> : <UserPlus className="h-4 w-4" />} Give access
            </Button>
          </form>
        ) : (
          <p className="mt-2 text-[12.5px] text-muted-foreground">Only the main operator can add or remove people.</p>
        )}
      </div>
      <ul className="divide-y">
        {list.operators.map((o) => (
          <li key={o.email} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Avatar name={o.name || o.email} photo={o.photo} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-medium">{o.name || o.email}</div>
              <div className="truncate text-[12px] text-muted-foreground">
                {o.name ? `${o.email} · ` : ""}{o.main ? "Set in the deployment" : `Added by ${o.added_by} on ${fmtDate(o.added_at!)}`}
              </div>
            </div>
            {o.main && <Badge tone="bg-primary/10 text-primary">Main operator</Badge>}
            <span className="whitespace-nowrap text-[12.5px] text-muted-foreground">{o.signed_up ? `Last sign-in: ${ago(o.last_login_at)}` : "Hasn't signed in yet"}</span>
            {list.can_manage && !o.main && (
              <ConfirmDelete label="Remove" confirm="Click again to remove" onConfirm={async () => {
                await API.adminRemoveOperator(o.email);
                toast.success(`${o.email} no longer has operator access`);
                await q.reload();
              }} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

type Tab = "overview" | "costs" | "runs" | "institutions" | "people" | "payments" | "operators";

/** YieldPilot staff only: the whole business at a glance, and every institution and person one click away. Counts and money only. */
export function AdminPage() {
  const { me } = useSession();
  const on = !!me?.operator;
  const overview = useQuery(on ? "admin:overview" : null, API.adminOverview, 15_000);
  const plans = useQuery(on ? "admin:plans" : null, API.adminPlans, 300_000);
  const insts = useQuery(on ? "admin:institutions" : null, API.adminInstitutions, 15_000);
  const users = useQuery(on ? "admin:users" : null, () => API.adminUsers(), 15_000);
  const [tab, setTab] = useState<Tab>("overview");
  const [q, setQ] = useState("");
  const [inst, setInst] = useState<string | null>(null);
  const [person, setPerson] = useState<AdminUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [focus, setFocus] = useState<Focus>({});
  const viewUsage = (u: AdminUser) => {
    setFocus({ institution_id: u.institution_id ?? undefined, user_id: u.id });
    setPerson(null);
    setTab("runs");
  };
  if (me && !on) return <Navigate to="/" replace />;
  if (overview.error) return <Failed error={overview.error} retry={overview.reload} />;
  const o = overview.data;
  const planList = plans.data ?? [];
  const instList = insts.data ?? [];
  const refresh = () => {
    void insts.reload();
    void users.reload();
    void overview.reload();
  };
  const tabs: [Tab, string, typeof Users, number | null][] = [
    ["overview", "Overview", LayoutGrid, null],
    ["costs", "Costs", Receipt, null],
    ["runs", "Usage explorer", Activity, null],
    ["institutions", "Institutions", Building2, insts.data?.length ?? null],
    ["people", "People", Users, users.data?.length ?? null],
    ["payments", "Payments", CreditCard, null],
    ["operators", "Operators", ShieldCheck, null],
  ];

  return (
    <div className="page-enter mx-auto flex max-w-[1320px] flex-col gap-5 px-6 py-8 lg:px-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-[-0.03em]">Operator dashboard</h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">How YieldPilot is doing, and everyone using it. Student records are never shown here.</p>
        </div>
        <Button className="h-10 rounded-full px-5" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> Set up an institution
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex flex-wrap rounded-xl border bg-card p-1 text-[13px]" role="tablist">
          {tabs.map(([k, label, Icon, n]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => (setTab(k), setQ(""))}
              className={cn("inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 font-medium transition-colors",
                tab === k ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="h-4 w-4" /> {label}
              {n != null && <span className={cn("rounded-full px-1.5 text-[11px] tabular-nums", tab === k ? "bg-white/20" : "bg-muted")}>{n}</span>}
            </button>
          ))}
        </div>
        {(tab === "institutions" || tab === "people" || tab === "payments") && (
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${tab}`} className="h-9 rounded-full pl-9" />
          </div>
        )}
      </div>

      {tab === "overview" && !o && <Loading text="Loading the dashboard…" />}
      {tab === "overview" && o && <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <Kpi icon={Building2} label="Institutions" value={o.institutions.toLocaleString()} />
        <Kpi icon={Users} label="People" value={o.users.toLocaleString()} note={`${o.active_users} signed in during the last 30 days`} />
        <Kpi icon={Play} label="Forecasts finished this month" value={o.runs_month.toLocaleString()} note={`${o.avg_run_seconds ? `about ${Math.round(o.avg_run_seconds)} seconds each` : "none yet"}${o.runs_failed_month ? ` · ${o.runs_failed_month} failed` : ""}`} />
        <Kpi icon={TrendingUp} label="Expected income each month" value={money(o.mrr_cents)} note="from active paid plans" />
        <Kpi icon={Wallet} label="Money received this month" value={money(o.revenue_month_cents)} />
        <Kpi icon={AlertTriangle} label="Payments that failed" value={String(o.failed_payments)} note="last 30 days" alert={o.failed_payments > 0} />
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr_0.8fr]">
        <BarsCard title="Forecasts finished each day" data={o.runs_per_day} x="day" y="runs" />
        <BarsCard title="New people each week" data={o.signups_per_week} x="week" y="users" />
        <BarsCard title="Money received each month" data={o.revenue_per_month} x="month" y="cents" fmt={(v) => money(v)} />
        <div className="surface p-4">
          <div className="mb-3 text-[13px] font-semibold">Which plans institutions are on</div>
          <ul className="space-y-2.5">
            {o.plan_mix.map((m) => (
              <li key={m.label} className="text-[12.5px]">
                <div className="flex justify-between">
                  <span>{m.label}</span>
                  <span className="tabular-nums text-muted-foreground">{m.value}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-[var(--series-ours)]" style={{ width: `${(m.value / Math.max(1, o.institutions)) * 100}%` }} />
                </div>
              </li>
            ))}
            {!o.plan_mix.length && <li className="text-[12.5px] text-muted-foreground">No institutions yet.</li>}
          </ul>
        </div>
      </div>
      </>}

      {tab === "costs" && <CostsTab />}
      {tab === "runs" && <RunsTab focus={focus} onFocus={setFocus} />}
      {tab === "institutions" && (insts.data ? <InstitutionsTable rows={insts.data} q={q} onOpen={setInst} /> : <Loading text="Loading institutions…" />)}
      {tab === "people" && (users.data ? <PeopleTable rows={users.data} q={q} institutions={instList} onOpen={setPerson} /> : <Loading text="Loading people…" />)}
      {tab === "payments" && <PaymentsTable q={q} />}
      {tab === "operators" && <OperatorsTab />}

      <p className="text-[12px] text-muted-foreground">Every change made here is recorded.</p>

      <InstitutionPanel id={inst} plans={planList} onChanged={refresh} onClose={() => setInst(null)} />
      <PersonPanel user={person} institutions={instList} onChanged={refresh} onClose={() => setPerson(null)} onViewUsage={viewUsage}
        openInstitution={(id) => (setPerson(null), setInst(id))} />
      <NewInstitution plans={planList} open={creating} onClose={() => setCreating(false)} onDone={(id) => (setCreating(false), refresh(), setInst(id))} />
    </div>
  );
}
