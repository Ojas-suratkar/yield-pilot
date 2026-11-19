import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, Link2, Loader2, Mail, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { cn, fmtDate } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Input } from "@yield/core/ui/input";
import { ConfirmDelete, Failed, Loading, Page , SortTh, TableSearch, useTable} from "../components/ui";
import { API } from "../lib/api";
import { can, useSession } from "../lib/auth";
import { useQuery } from "../lib/query";

export const ROLE_INFO: Record<string, { label: string; text: string }> = {
  owner: { label: "Owner", text: "Everything, including roles and billing" },
  admin: { label: "Admin", text: "Manage people, data and forecasts" },
  data_manager: { label: "Data manager", text: "Add and fix data, run and publish forecasts" },
  analyst: { label: "Analyst", text: "Run forecasts, scenarios and share reports" },
  viewer: { label: "Viewer", text: "Read every prediction and report in the workspace" },
  guest: { label: "Guest", text: "Outside the institution: sees only reports shared with them" },
};
const ORDER = ["guest", "viewer", "analyst", "data_manager", "admin", "owner"];

function RoleSelect({ value, max, onChange, disabled }: { value: string; max: string; onChange: (r: string) => void; disabled?: boolean }) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 rounded-lg border border-input bg-card px-2.5 text-[13px] disabled:opacity-60"
      aria-label="Role"
    >
      {ORDER.filter((r) => ORDER.indexOf(r) <= ORDER.indexOf(max)).map((r) => (
        <option key={r} value={r}>
          {ROLE_INFO[r].label}
        </option>
      ))}
    </select>
  );
}

export function TeamPage() {
  const { me } = useSession();
  const admin = can(me, "admin");
  const members = useQuery("team:members", API.members, 10_000);
  const invites = useQuery(admin ? "team:invites" : null, API.invitations, 10_000);
  const requests = useQuery(admin ? "team:requests" : null, API.joinRequests, 10_000);
  const inst = useQuery(admin ? "institution" : null, API.institution, 10_000);
  const [grant, setGrant] = useState<Record<string, string>>({});
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("analyst");
  const [busy, setBusy] = useState(false);
  const t = useTable((members.data ?? []).map((m) => ({ ...m, who: m.name || m.email })), { key: "who", desc: false }, (m) => `${m.name ?? ""} ${m.email} ${m.role}`);
  if (members.error) return <Failed error={members.error} retry={members.reload} />;
  if (!me || !members.data) return <Loading text="Loading your team…" />;

  const change = async (id: string, b: { role?: string; active?: boolean }) => {
    try {
      await API.updateMember(id, b);
      toast.success("Saved");
      void members.reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await API.invite(email.trim(), role);
      toast.success(`Invited ${email.trim()}`, { description: `They'll see the invitation when they sign in, and join as ${ROLE_INFO[role].label.toLowerCase()}.` });
      setEmail("");
      void invites.reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Team" description={`People in ${me.institution?.name} and what each can do.`} width="normal" mode="top">
      {admin && (
        <form onSubmit={invite} className="surface mb-5 flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-[240px] flex-1">
            <label htmlFor="inv" className="mb-1 block text-[12.5px] font-medium">
              Invite someone
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="inv" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@csulb.edu or any email" className="h-9 pl-9" />
            </div>
          </div>
          <div>
            <span className="mb-1 block text-[12.5px] font-medium">Role</span>
            <RoleSelect value={role} max={me.role} onChange={setRole} />
          </div>
          <Button type="submit" disabled={busy || !email.trim()} className="h-9">
            {busy ? <Loader2 className="animate-spin" /> : <UserPlus />} Invite
          </Button>
          <p className="w-full text-[12px] text-muted-foreground">{ROLE_INFO[role].text}. They accept it the next time they sign in with that email.</p>
          {inst.data?.invite_url && inst.data.join_code_enabled && (
            <div className="flex w-full flex-wrap items-center gap-2 border-t pt-3 text-[12.5px]">
              <Link2 className="h-4 w-4 text-primary" />
              <span className="text-muted-foreground">Or share the invite link: anyone with it joins as {ROLE_INFO[inst.data.default_role]?.label.toLowerCase()}.</span>
              <Button type="button" variant="outline" size="sm" className="h-7" onClick={() =>
                navigator.clipboard.writeText(inst.data!.invite_url!).then(() => toast.success("Invite link copied"), () => toast.error("Couldn't copy"))}>
                <Copy className="h-3.5 w-3.5" /> Copy link
              </Button>
              <Link to="/settings/institution" className="text-primary hover:underline">Link settings</Link>
            </div>
          )}
        </form>
      )}

      {admin && !!requests.data?.length && (
        <section className="surface mb-5 p-4">
          <h2 className="text-[13.5px] font-semibold">Asking to join ({requests.data.length})</h2>
          <ul className="mt-2 divide-y">
            {requests.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-3">
                {r.photo ? (
                  <img src={r.photo} alt="" referrerPolicy="no-referrer" className="h-8 w-8 rounded-full object-cover" />
                ) : (
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-secondary text-[12px] font-semibold uppercase">{(r.name || r.email).slice(0, 2)}</span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium">{r.name || r.email}</div>
                  <div className="truncate text-[12px] text-muted-foreground">
                    {r.email} · {fmtDate(r.created_at)}
                    {r.message ? ` · "${r.message}"` : ""}
                  </div>
                </div>
                <RoleSelect value={grant[r.id] ?? inst.data?.default_role ?? "viewer"} max={me.role === "owner" ? "admin" : "data_manager"} onChange={(v) => setGrant({ ...grant, [r.id]: v })} />
                <Button variant="ghost" size="sm" onClick={() => API.decideRequest(r.id, false).then(() => (toast.success("Declined"), void requests.reload()), (e: Error) => toast.error(e.message))}>
                  Decline
                </Button>
                <Button size="sm" onClick={() =>
                  API.decideRequest(r.id, true, grant[r.id] ?? inst.data?.default_role).then(() => {
                    toast.success(`${r.name || r.email} joined`);
                    void requests.reload();
                    void members.reload();
                  }, (e: Error) => toast.error(e.message))}>
                  <Check className="h-4 w-4" /> Approve
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {members.data.length > 5 && <TableSearch value={t.q} onChange={t.setQ} placeholder="Find a person" className="mb-2" />}
      <div className="surface overflow-hidden">
        <table className="w-full text-[13.5px]">
          <thead className="border-b bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
            <tr>
              <SortTh label="Person" k="who" sort={t.sort} onSort={t.setSort} className="py-2.5" />
              <SortTh label="Role" k="role" sort={t.sort} onSort={t.setSort} className="py-2.5" />
              <SortTh label="Last sign-in" k="last_login_at" sort={t.sort} onSort={t.setSort} className="hidden py-2.5 md:table-cell" />
              {admin && <th className="px-4 py-2.5 text-right">Manage</th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {t.shown.map((m) => {
              const editable = admin && !m.you && ORDER.indexOf(m.role) <= ORDER.indexOf(me.role);
              return (
                <tr key={m.id} className={cn(!m.active && "opacity-50")}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {m.photo ? (
                        <img src={m.photo} alt="" referrerPolicy="no-referrer" className="h-8 w-8 rounded-full object-cover" />
                      ) : (
                        <span className="grid h-8 w-8 place-items-center rounded-full bg-secondary text-[12px] font-semibold uppercase">{(m.name || m.email).slice(0, 2)}</span>
                      )}
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          {m.name || m.email} {m.you && <span className="text-[12px] font-normal text-muted-foreground">(you)</span>}
                        </div>
                        <div className="truncate text-[12px] text-muted-foreground">
                          {m.email}
                          {m.title ? ` · ${m.title}` : ""}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {editable ? (
                      <RoleSelect value={m.role} max={me.role} onChange={(r) => void change(m.id, { role: r })} />
                    ) : (
                      <span className="text-[13px]">{ROLE_INFO[m.role]?.label ?? m.role}</span>
                    )}
                    <div className="mt-0.5 text-[11.5px] text-muted-foreground">{ROLE_INFO[m.role]?.text}</div>
                  </td>
                  <td className="hidden px-4 py-3 text-[12.5px] text-muted-foreground md:table-cell">{m.last_login_at ? fmtDate(m.last_login_at) : "Never"}</td>
                  {admin && (
                    <td className="px-4 py-3 text-right">
                      {editable && (
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <Button variant="ghost" size="sm" onClick={() => void change(m.id, { active: !m.active })}>
                            {m.active ? "Remove access" : "Restore access"}
                          </Button>
                          <ConfirmDelete
                            label="Delete user"
                            confirm="Click again to delete"
                            onConfirm={async () => {
                              const r = await API.deleteMember(m.id);
                              toast.success(r.account_deleted
                                ? `${m.name || m.email} is deleted. They'd need to sign up again to come back.`
                                : `${m.name || m.email} is removed from this workspace. Their other workspaces stay.`);
                              await members.reload();
                            }}
                          />
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {admin && invites.data && invites.data.length > 0 && (
        <div className="surface mt-5 p-4">
          <div className="mb-2 text-[13.5px] font-semibold">Waiting to join</div>
          <ul className="divide-y text-[13px]">
            {invites.data.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 py-2">
                <span>
                  {i.email} <span className="text-muted-foreground">· {ROLE_INFO[i.role]?.label} · invited {fmtDate(i.created_at)}</span>
                </span>
                <button
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`Cancel invitation for ${i.email}`}
                  onClick={() =>
                    API.cancelInvite(i.id)
                      .then(() => invites.reload())
                      .catch((e) => toast.error((e as Error).message))
                  }
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!admin && <p className="mt-4 text-[12.5px] text-muted-foreground">Only owners and admins can invite people or change roles.</p>}
    </Page>
  );
}
