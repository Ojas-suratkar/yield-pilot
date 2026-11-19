import { useEffect, useState } from "react";
import { Check, Copy, Globe, Link2, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { cn, fmtDate } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Input } from "@yield/core/ui/input";
import { Label } from "@yield/core/ui/label";
import { Failed, Loading, Page, Soft } from "../components/ui";
import { API, type InstitutionProfile } from "../lib/api";
import { can, refreshSession, useSession } from "../lib/auth";
import { useQuery } from "../lib/query";
import { LogoPicker } from "./Welcome";

const KINDS: [string, string][] = [["university", "University"], ["college", "College"], ["school", "School or district"], ["organization", "Organization"]];
const START_ROLES: [string, string][] = [["viewer", "Viewer: reads predictions and reports"], ["analyst", "Analyst: runs forecasts and scenarios"],
                                         ["data_manager", "Data manager: also brings in data"]];

export function copy(text: string, what = "Copied") {
  void navigator.clipboard.writeText(text).then(() => toast.success(what), () => toast.error("Couldn't copy. Select it and copy it yourself."));
}

/** The institution's profile, how colleagues get in, and its invite link. Everyone sees it; admins change it. */
export function InstitutionPage() {
  const { me } = useSession();
  const admin = can(me, "admin");
  const q = useQuery("institution", API.institution, 10_000);
  const [form, setForm] = useState<InstitutionProfile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setForm(q.data);
  }, [q.data]);
  if (q.error) return <Failed error={q.error} retry={q.reload} />;
  if (!form || !q.data) return <Loading text="Loading your institution…" />;
  const i = q.data;

  const save = async (b: Parameters<typeof API.updateInstitution>[0], key = "save", msg = "Saved") => {
    setBusy(key);
    try {
      const out = await API.updateInstitution(b);
      setForm(out);
      void q.reload();
      void refreshSession(); // the name and logo in the sidebar
      toast.success(msg);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const changed = (["name", "website", "kind", "country", "region", "description", "logo"] as const).some((k) => (form[k] ?? "") !== (i[k] ?? ""));
  const set = (k: keyof InstitutionProfile) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <Page title="Institution" description={`${i.name}'s profile, who can join, and the invite link. Everyone here shares one workspace.`} width="normal" mode="top">
      <Soft className="space-y-5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <LogoPicker value={form.logo} name={form.name} disabled={!admin} onChange={(logo) => setForm({ ...form, logo })} />
          {admin && (
            <Button variant="outline" size="sm" disabled={!!busy || !(i.website || i.domain)} onClick={async () => {
              setBusy("refresh");
              try {
                const out = await API.refreshInstitution();
                setForm(out);
                void q.reload();
                void refreshSession();
                toast.success("Updated from the website");
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(null);
              }
            }}>
              {busy === "refresh" ? <Loader2 className="animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh from website
            </Button>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="i-name">Name</Label>
            <Input id="i-name" value={form.name} onChange={set("name")} disabled={!admin} className="h-10" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="i-web">Website</Label>
            <Input id="i-web" value={form.website ?? ""} onChange={set("website")} disabled={!admin} placeholder="https://www.example.edu" className="h-10" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="i-kind">Type</Label>
            <select id="i-kind" value={form.kind ?? "organization"} onChange={set("kind")} disabled={!admin} className="h-10 w-full rounded-lg border border-input bg-card px-2.5 text-[13.5px] disabled:opacity-60">
              {KINDS.map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="i-region">State or region</Label>
            <Input id="i-region" value={form.region ?? ""} onChange={set("region")} disabled={!admin} className="h-10" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="i-country">Country</Label>
            <Input id="i-country" value={form.country ?? ""} onChange={set("country")} disabled={!admin} className="h-10" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="i-desc">About</Label>
            <textarea id="i-desc" value={form.description ?? ""} onChange={set("description")} disabled={!admin} rows={2} maxLength={600}
              className="w-full rounded-lg border border-input bg-card px-3 py-2 text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60" />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t pt-4 text-[12.5px] text-muted-foreground">
          <span>{i.members} member{i.members === 1 ? "" : "s"} · on YieldPilot since {fmtDate(i.created_at)}</span>
          {admin && (
            <Button disabled={!changed || !!busy} onClick={() =>
              save({ name: form.name, website: form.website, kind: form.kind, country: form.country, region: form.region, description: form.description, logo: form.logo })}>
              {busy === "save" ? <Loader2 className="animate-spin" /> : null} Save profile
            </Button>
          )}
        </div>
      </Soft>

      {admin && (
        <>
          <Soft className="mt-4 space-y-3 p-6">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold">
              <Link2 className="h-4 w-4 text-primary" /> Invite link
            </h2>
            <p className="text-[13px] text-muted-foreground">
              Anyone with this link or code joins {i.name} as a {START_ROLES.find(([k]) => k === i.default_role)?.[1].split(":")[0].toLowerCase() ?? i.default_role}.
              Share it with your team; replace it if it reaches the wrong people.
            </p>
            {i.join_code_enabled && i.invite_url ? (
              <div className="flex flex-wrap items-center gap-2">
                <code className="flex-1 truncate rounded-lg border bg-muted/40 px-3 py-2 text-[13px]">{i.invite_url}</code>
                <Button variant="outline" onClick={() => copy(i.invite_url!, "Invite link copied")}>
                  <Copy className="h-4 w-4" /> Copy link
                </Button>
                <Button variant="ghost" onClick={() => copy(i.join_code!, "Code copied")} title="Copy just the code">
                  {i.join_code}
                </Button>
              </div>
            ) : (
              <p className="rounded-lg bg-muted/50 px-3 py-2 text-[13px] text-muted-foreground">The invite link is off. People can only join by invitation or request.</p>
            )}
            <div className="flex flex-wrap gap-2">
              {i.join_code_enabled && (
                <Button variant="outline" size="sm" disabled={!!busy} onClick={() => save({ rotate_code: true }, "rotate", "New link made; the old one no longer works")}>
                  <RefreshCw className="h-4 w-4" /> Replace link
                </Button>
              )}
              <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => save({ join_code_enabled: !i.join_code_enabled }, "toggle", i.join_code_enabled ? "Invite link turned off" : "Invite link turned on")}>
                {i.join_code_enabled ? "Turn off the link" : "Turn on the invite link"}
              </Button>
            </div>
          </Soft>

          <Soft className="mt-4 space-y-4 p-6">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold">
              <ShieldCheck className="h-4 w-4 text-primary" /> Who can join
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <Globe className="h-4 w-4 text-muted-foreground" />
              {i.domain ? (
                <span>
                  Verified email domain: <b className="font-semibold">@{i.domain}</b>
                </span>
              ) : i.claimable_domain ? (
                <>
                  <span className="text-muted-foreground">No verified email domain yet.</span>
                  <Button variant="outline" size="sm" disabled={!!busy} onClick={() => save({ claim_domain: true }, "claim", `@${i.claimable_domain} verified`)}>
                    Verify @{i.claimable_domain}
                  </Button>
                </>
              ) : (
                <span className="text-muted-foreground">No verified email domain. An admin who signs in with an institution address can verify it.</span>
              )}
            </div>
            <fieldset className="space-y-2">
              <legend className="mb-1 text-[13px] font-medium">People who find {i.name} {i.domain ? `with an @${i.domain} address or ` : ""}by its website</legend>
              {(
                [
                  ["domain", `Join at once if they sign in with a verified @${i.domain ?? "your domain"} address`, !i.domain],
                  ["request", "Ask to join, and an admin approves each request", false],
                  ["invite", "Can't join without an invitation or the invite link", false],
                ] as const
              ).map(([k, label, off]) => (
                <label key={k} className={cn("flex items-start gap-2.5 rounded-xl border p-3 text-[13px]", i.join_policy === k && "border-primary/40 bg-primary/[0.04]", off && "opacity-50")}>
                  <input type="radio" name="policy" checked={i.join_policy === k} disabled={off || !!busy} onChange={() => save({ join_policy: k })} className="mt-0.5 accent-[hsl(var(--primary))]" />
                  {label}
                  {i.join_policy === k && <Check className="ml-auto h-4 w-4 text-primary" />}
                </label>
              ))}
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="i-role">New members start as</Label>
                <select id="i-role" value={i.default_role} disabled={!!busy} onChange={(e) => save({ default_role: e.target.value })}
                  className="h-10 w-full rounded-lg border border-input bg-card px-2.5 text-[13.5px]">
                  {START_ROLES.map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </select>
                <p className="text-[12px] text-muted-foreground">For the invite link and approved requests. Invitations set their own role.</p>
              </div>
              <label className="flex items-start gap-2.5 self-start rounded-xl border p-3 text-[13px]">
                <input type="checkbox" checked={i.discoverable} disabled={!!busy} onChange={(e) => save({ discoverable: e.target.checked })} className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" />
                <span>
                  Findable by its website
                  <span className="block text-[12px] text-muted-foreground">People who type your website can see {i.name} and ask to join. Off: only invitations and the link.</span>
                </span>
              </label>
            </div>
          </Soft>
        </>
      )}
    </Page>
  );
}
