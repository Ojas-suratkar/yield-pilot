import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { ArrowRight, Building2, Check, Clock, ImagePlus, Link2, Loader2, LogOut, Mail, Search, Sparkles, Users } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Input } from "@yield/core/ui/input";
import { Label } from "@yield/core/ui/label";
import { Logo } from "../components/Logo";
import { Loading } from "../components/ui";
import { API, type InstitutionCard, type JoinAction, type OrgPreview } from "../lib/api";
import { refreshSession, signOut, useSession } from "../lib/auth";
import { projectStore } from "../lib/project";
import { dropQueries } from "../lib/query";

const PENDING_CODE = "yieldpilot:join";
const ROLE_NAME: Record<string, string> = { viewer: "Viewer", analyst: "Analyst", data_manager: "Data manager", admin: "Admin", owner: "Owner", guest: "Guest" };
const KINDS = [
  ["university", "University"],
  ["college", "College"],
  ["school", "School or district"],
  ["organization", "Organization"],
] as const;

export const rememberCode = (code: string) => {
  try {
    sessionStorage.setItem(PENDING_CODE, code);
  } catch {
    /* storage blocked */
  }
};
const takeCode = () => {
  try {
    const c = sessionStorage.getItem(PENDING_CODE);
    sessionStorage.removeItem(PENDING_CODE);
    return c;
  } catch {
    return null;
  }
};

/** Into the new institution's shared workspace: a fresh session and no study from anywhere else. */
async function enter(nav: ReturnType<typeof useNavigate>, name: string) {
  projectStore.clear();
  dropQueries("");
  await refreshSession();
  toast.success(`Welcome to ${name}`);
  nav("/", { replace: true });
}

export function Crest({ inst, size = 44 }: { inst: { name: string; logo?: string | null }; size?: number }) {
  const initials = inst.name.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w) && !/^(of|the|and|at|for)$/i.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return inst.logo ? (
    <img src={inst.logo} alt="" style={{ width: size, height: size }} className="shrink-0 rounded-xl border bg-white object-contain p-1" />
  ) : (
    <span style={{ width: size, height: size }} className="grid shrink-0 place-items-center rounded-xl bg-primary/10 text-[14px] font-semibold text-primary">
      {initials || <Building2 className="h-5 w-5" />}
    </span>
  );
}

function Tile({ inst, note, children }: { inst: InstitutionCard; note?: React.ReactNode; children?: React.ReactNode }) {
  const where = [inst.region, inst.country].filter(Boolean).join(", ");
  return (
    <div className="flex flex-wrap items-center gap-3.5 rounded-2xl border bg-card p-4">
      <Crest inst={inst} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-semibold">{inst.name}</div>
        <div className="mt-0.5 text-[12.5px] text-muted-foreground">
          {[where, inst.website?.replace(/^https?:\/\//, ""), `${inst.members} member${inst.members === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
        </div>
        {note && <div className="mt-1 text-[12.5px]">{note}</div>}
      </div>
      {children && <div className="flex shrink-0 gap-2">{children}</div>}
    </div>
  );
}

function JoinButtons({ inst, action, onDone }: { inst: InstitutionCard; action: JoinAction; onDone: (joined: boolean, name: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [msg, setMsg] = useState("");
  if (action === "invite_only")
    return <span className="max-w-[220px] text-right text-[12.5px] text-muted-foreground">Invite only. Ask one of its admins to invite you.</span>;
  const go = async () => {
    setBusy(true);
    try {
      const r = await API.requestToJoin(inst.id, msg.trim() || undefined);
      onDone(r.joined, r.name);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (action === "join")
    return (
      <Button onClick={go} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <Check className="h-4 w-4" />} Join
      </Button>
    );
  return asking ? (
    <div className="flex w-full flex-col gap-2 sm:w-[300px]">
      <textarea
        value={msg}
        onChange={(e) => setMsg(e.target.value)}
        maxLength={500}
        rows={2}
        placeholder="Optional note for the admins, e.g. your team or role"
        className="rounded-xl border border-input bg-background px-3 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <Button onClick={go} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : null} Send request
      </Button>
    </div>
  ) : (
    <Button variant="outline" onClick={() => setAsking(true)}>
      Request to join
    </Button>
  );
}

function readImage(file: File): Promise<string> {
  return new Promise((ok, fail) => {
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) return fail(new Error("Use a PNG, JPEG or WebP image."));
    if (file.size > 1_000_000) return fail(new Error("Use an image under 1 MB."));
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(new Error("That image couldn't be read."));
    r.readAsDataURL(file);
  });
}

export function LogoPicker({ value, name, onChange, disabled }: { value: string | null; name: string; onChange: (v: string | null) => void; disabled?: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-3">
      <Crest inst={{ name: name || "?", logo: value }} size={56} />
      {!disabled && (
        <div className="flex flex-col items-start gap-1">
          <button type="button" onClick={() => file.current?.click()} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-primary hover:underline">
            <ImagePlus className="h-4 w-4" /> {value ? "Replace logo" : "Upload a logo"}
          </button>
          {value && (
            <button type="button" onClick={() => onChange(null)} className="text-[12px] text-muted-foreground hover:text-foreground hover:underline">
              Remove
            </button>
          )}
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) readImage(f).then(onChange, (err: Error) => toast.error(err.message));
            }}
          />
        </div>
      )}
    </div>
  );
}

type Form = { name: string; website: string; kind: string; country: string; region: string; description: string; logo: string | null };
const emptyForm: Form = { name: "", website: "", kind: "university", country: "", region: "", description: "", logo: null };

function CreatePanel({ emailDomain, domainTaken, onJoined }: { emailDomain: string | null; domainTaken: boolean; onJoined: (joined: boolean, name: string) => void }) {
  const nav = useNavigate();
  const [value, setValue] = useState(emailDomain ?? "");
  const [looking, setLooking] = useState(false);
  const [preview, setPreview] = useState<OrgPreview | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [separate, setSeparate] = useState(false);
  const [claim, setClaim] = useState(true);
  const [busy, setBusy] = useState(false);
  const lookup = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!value.trim()) return;
    setLooking(true);
    try {
      const p = await API.orgPreview(value.trim());
      setPreview(p);
      setSeparate(false);
      setForm({ name: p.found ? p.name : "", website: p.website, kind: p.kind || "organization", country: p.country ?? "", region: p.region ?? "",
                description: p.description ?? "", logo: p.logo });
      if (!p.found) toast.info(`We couldn't find a website at ${p.domain}. Fill in the details yourself.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLooking(false);
    }
  };
  useEffect(() => {
    if (emailDomain) void lookup();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form || form.name.trim().length < 2) return toast.error("Enter your institution's name.");
    setBusy(true);
    try {
      const r = await API.createInstitution({ ...form, website: form.website || null, country: form.country || null, region: form.region || null,
                                             description: form.description || null, claim_domain: claim && !!emailDomain });
      await enter(nav, r.name);
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  };
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => (f ? { ...f, [k]: e.target.value } : f));

  return (
    <div className="space-y-4">
      <form onSubmit={lookup} className="space-y-1.5">
        <Label htmlFor="org">Your institution's website or work email</Label>
        <div className="flex gap-2">
          <Input id="org" value={value} onChange={(e) => setValue(e.target.value)} placeholder="csulb.edu" className="h-11 rounded-xl" autoComplete="off" />
          <Button type="submit" variant="outline" className="h-11 rounded-xl" disabled={looking || !value.trim()}>
            {looking ? <Loader2 className="animate-spin" /> : <Search className="h-4 w-4" />} Look up
          </Button>
        </div>
        <p className="text-[12px] text-muted-foreground">
          We fill in the official name, logo and location from its website. You can change anything.{" "}
          {!form && (
            <button type="button" className="font-medium text-primary hover:underline" onClick={() => setForm(emptyForm)}>
              Enter details yourself
            </button>
          )}
        </p>
      </form>
      {looking && (
        <div className="flex items-center gap-2 rounded-2xl border border-dashed p-4 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Looking up {value.trim()}…
        </div>
      )}
      {!looking && preview?.existing && !separate && (
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-[13px] font-medium">
            <Sparkles className="h-4 w-4 text-primary" /> {preview.existing.name} is already on YieldPilot
          </p>
          <Tile inst={preview.existing}>
            <JoinButtons inst={preview.existing} action={preview.existing.action} onDone={onJoined} />
          </Tile>
          <button type="button" onClick={() => setSeparate(true)} className="text-[12.5px] text-muted-foreground hover:text-foreground hover:underline">
            Create a separate workspace instead (for example, for one department)
          </button>
        </div>
      )}
      {!looking && form && (!preview?.existing || separate) && (
        <form onSubmit={create} className="space-y-4 rounded-2xl border bg-card p-5">
          <LogoPicker value={form.logo} name={form.name} onChange={(logo) => setForm((f) => (f ? { ...f, logo } : f))} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="o-name">Name</Label>
              <Input id="o-name" required value={form.name} onChange={set("name")} placeholder="California State University, Long Beach" className="h-10" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="o-web">Website</Label>
              <Input id="o-web" value={form.website} onChange={set("website")} placeholder="https://www.csulb.edu" className="h-10" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="o-kind">Type</Label>
              <select id="o-kind" value={form.kind} onChange={set("kind")} className="h-10 w-full rounded-lg border border-input bg-card px-2.5 text-[13.5px]">
                {KINDS.map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="o-region">State or region</Label>
              <Input id="o-region" value={form.region} onChange={set("region")} placeholder="California" className="h-10" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="o-country">Country</Label>
              <Input id="o-country" value={form.country} onChange={set("country")} placeholder="United States" className="h-10" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="o-desc">About</Label>
              <textarea id="o-desc" value={form.description} onChange={set("description")} rows={2} maxLength={600}
                className="w-full rounded-lg border border-input bg-card px-3 py-2 text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            </div>
          </div>
          {emailDomain && !domainTaken && (
            <label className="flex items-start gap-2.5 rounded-xl bg-muted/50 p-3 text-[13px]">
              <input type="checkbox" checked={claim} onChange={(e) => setClaim(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" />
              <span>
                Colleagues who sign in with a verified <b className="font-medium">@{emailDomain}</b> address can find this workspace and ask to join.
                <span className="block text-muted-foreground">You approve each request. You can change this later in Institution settings.</span>
              </span>
            </label>
          )}
          <Button type="submit" disabled={busy} className="h-11 w-full rounded-xl">
            {busy ? <Loader2 className="animate-spin" /> : <Building2 className="h-4 w-4" />} Create {form.name.trim() || "institution"}
          </Button>
          <p className="text-center text-[12px] text-muted-foreground">You'll be its owner, and can invite your team right after.</p>
        </form>
      )}
    </div>
  );
}

function JoinPanel({ onJoined }: { onJoined: (joined: boolean, name: string) => void }) {
  const nav = useNavigate();
  const [code, setCode] = useState("");
  const [site, setSite] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [found, setFound] = useState<Awaited<ReturnType<typeof API.findInstitution>> | null>(null);
  const openCode = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim().split("/").pop() ?? "";
    if (c) nav(`/join/${encodeURIComponent(c)}`);
  };
  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("find");
    try {
      setFound(await API.findInstitution(site.trim()));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-6">
      <form onSubmit={openCode} className="space-y-1.5">
        <Label htmlFor="code" className="flex items-center gap-1.5">
          <Link2 className="h-4 w-4 text-primary" /> Invite link or code
        </Label>
        <div className="flex gap-2">
          <Input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-EFGH-JKMN or the full link" className="h-11 rounded-xl" autoComplete="off" />
          <Button type="submit" className="h-11 rounded-xl" disabled={!code.trim()}>
            Continue <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-[12px] text-muted-foreground">An admin of your institution can copy it from Team in YieldPilot.</p>
      </form>
      <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" /> or find your institution <span className="h-px flex-1 bg-border" />
      </div>
      <form onSubmit={search} className="space-y-1.5">
        <Label htmlFor="site">Your institution's website</Label>
        <div className="flex gap-2">
          <Input id="site" value={site} onChange={(e) => { setSite(e.target.value); setFound(null); }} placeholder="csulb.edu" className="h-11 rounded-xl" autoComplete="off" />
          <Button type="submit" variant="outline" className="h-11 rounded-xl" disabled={!site.trim() || busy === "find"}>
            {busy === "find" ? <Loader2 className="animate-spin" /> : <Search className="h-4 w-4" />} Find
          </Button>
        </div>
      </form>
      {found &&
        (found.found ? (
          found.found.member ? (
            <Tile inst={found.found} note="You're already a member." />
          ) : (
            <Tile inst={found.found}>
              <JoinButtons inst={found.found} action={found.found.action} onDone={onJoined} />
            </Tile>
          )
        ) : (
          <p className="rounded-2xl border border-dashed p-4 text-[13px] text-muted-foreground">
            No workspace uses that website yet. Ask a colleague for an invite link, or create your institution.
          </p>
        ))}
    </div>
  );
}

/** First sign-in: create your institution (details looked up from its website) or join your colleagues. */
export function WelcomePage() {
  const { status, me } = useSession();
  const nav = useNavigate();
  const [data, setData] = useState<Awaited<ReturnType<typeof API.onboarding>> | null>(null);
  const [tab, setTab] = useState<"create" | "join">("create");
  const [sent, setSent] = useState<string | null>(null);
  const [code] = useState(() => (typeof window !== "undefined" ? takeCode() : null));
  const load = () => API.onboarding().then(setData, (e: Error) => toast.error(e.message));
  useEffect(() => {
    if (status === "in") void load();
  }, [status]);
  if (status === "loading") return <Loading text="One moment…" />;
  if (status === "out") return <Navigate to="/login" replace />;
  if (code) return <Navigate to={`/join/${encodeURIComponent(code)}`} replace />;
  const switching = !!me?.institution && !me.institution.personal;
  const joined = async (j: boolean, name: string) => {
    if (j) return enter(nav, name);
    setSent(name);
    void load();
  };
  const first = me?.name?.split(" ")[0];

  return (
    <div className="min-h-screen bg-background px-5 py-10">
      <div className="mx-auto w-full max-w-[640px]">
        <div className="mb-8 flex items-center justify-between">
          <Logo />
          {me?.operator && <Link to="/admin" className="ml-auto mr-4 text-[13px] font-medium text-primary hover:underline">Operator dashboard</Link>}
          <button onClick={() => void signOut().then(() => nav("/login"))} className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
        <h1 className="text-[28px] font-semibold tracking-[-0.03em]">{switching ? "Add a workspace" : `Welcome to YieldPilot${first ? `, ${first}` : ""}`}</h1>
        <p className="mt-1.5 text-[14.5px] text-muted-foreground">
          {switching
            ? `You're in ${me?.institution?.name}. Join or create another workspace, such as another department's, and switch between them from the workspace menu. You keep this one.`
            : "Your institution's enrollment team forecasts together in one shared workspace. Create it, or join your colleagues."}
        </p>
        {!data ? (
          <Loading text="Checking for invitations…" />
        ) : (
          <div className="mt-7 space-y-7">
            {sent && (
              <div className="flex gap-2.5 rounded-2xl border border-primary/25 bg-primary/[0.06] p-4 text-[13.5px]">
                <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div>
                  <b className="font-semibold">Request sent to {sent}.</b> An admin there will review it. We'll email you and show it here once you're approved.
                </div>
              </div>
            )}
            {data.invitations.length > 0 && (
              <section className="space-y-2.5">
                <h2 className="flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  <Mail className="h-4 w-4" /> You're invited
                </h2>
                {data.invitations.map((i) => (
                  <Tile key={i.id} inst={i.institution} note={<>{i.invited_by ? `${i.invited_by} invited you` : "You're invited"} as <b className="font-medium">{ROLE_NAME[i.role] ?? i.role}</b></>}>
                    <Button variant="ghost" onClick={() => API.answerInvitation(i.id, false).then(load, (e: Error) => toast.error(e.message))}>
                      Decline
                    </Button>
                    <Button onClick={() => API.answerInvitation(i.id, true).then((r) => enter(nav, r.name), (e: Error) => toast.error(e.message))}>
                      Join
                    </Button>
                  </Tile>
                ))}
              </section>
            )}
            {data.suggestions.length > 0 && (
              <section className="space-y-2.5">
                <h2 className="flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  <Users className="h-4 w-4" /> Your colleagues are here
                </h2>
                {data.suggestions.map((sg) => (
                  <Tile key={sg.id} inst={sg} note={<span className="text-muted-foreground">For people with an @{data.email_domain} address</span>}>
                    {data.requests.some((r) => r.institution.id === sg.id) ? (
                      <span className="text-[12.5px] text-muted-foreground">Request sent</span>
                    ) : (
                      <JoinButtons inst={sg} action={sg.action} onDone={joined} />
                    )}
                  </Tile>
                ))}
              </section>
            )}
            {data.requests.length > 0 && (
              <section className="space-y-2.5">
                <h2 className="flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  <Clock className="h-4 w-4" /> Waiting for approval
                </h2>
                {data.requests.map((r) => (
                  <Tile key={r.id} inst={r.institution} note={<span className="text-muted-foreground">An admin will review your request.</span>}>
                    <Button variant="ghost" onClick={() => API.cancelRequest(r.id).then(load, (e: Error) => toast.error(e.message))}>
                      Cancel request
                    </Button>
                  </Tile>
                ))}
              </section>
            )}
            {(
              <section className="rounded-3xl border bg-card p-6 shadow-[var(--shadow-card)]">
                <div className="mb-5 inline-flex rounded-full border bg-muted/40 p-1 text-[13px]" role="tablist">
                  {(
                    [
                      ["create", "Create an institution", Building2],
                      ["join", "Join an institution", Users],
                    ] as const
                  ).map(([k, label, Icon]) => (
                    <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                      className={cn("inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 font-medium transition-colors",
                        tab === k ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                      <Icon className="h-4 w-4" /> {label}
                    </button>
                  ))}
                </div>
                {tab === "create" ? <CreatePanel emailDomain={data.email_domain} domainTaken={false} onJoined={joined} /> : <JoinPanel onJoined={joined} />}
              </section>
            )}
            {switching && (
              <Link to="/" className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">
                Back to {me?.institution?.name} <ArrowRight className="h-4 w-4" />
              </Link>
            )}
            <p className="text-center text-[12px] text-muted-foreground">Signed in as {me?.email}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** An invite link (/join/CODE): who it's for and the role it gives, then one click to join. */
export function JoinPage() {
  const { code = "" } = useParams();
  const { status, me } = useSession();
  const nav = useNavigate();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof API.codePreview>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (status === "in") API.codePreview(code).then(setInfo, (e: Error) => setError(e.message));
  }, [status, code]);
  if (status === "loading") return <Loading text="One moment…" />;
  if (status === "out") {
    rememberCode(code);
    return <Navigate to="/login" replace />;
  }
  const join = async () => {
    setBusy(true);
    try {
      const r = await API.joinWithCode(code);
      await enter(nav, r.name);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  const leaving = me?.institution && !me.institution.personal && info && !info.member ? me.institution.name : null;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-5 py-12">
      <div className="w-full max-w-[440px]">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="space-y-5 rounded-2xl border bg-card p-8 text-center shadow-[var(--shadow-card)]">
          {error ? (
            <>
              <h1 className="text-[20px] font-semibold tracking-[-0.02em]">This invite link doesn't work</h1>
              <p className="text-[13.5px] text-muted-foreground">{error}</p>
              <Button className="h-11 w-full rounded-xl" onClick={() => nav(me?.institution ? "/" : "/welcome", { replace: true })}>
                Continue to YieldPilot
              </Button>
            </>
          ) : !info ? (
            <Loading text="Opening your invitation…" />
          ) : (
            <>
              <div className="flex justify-center">
                <Crest inst={info} size={64} />
              </div>
              <div>
                <h1 className="text-[20px] font-semibold tracking-[-0.02em]">{info.member ? `You're already in ${info.name}` : `Join ${info.name}`}</h1>
                <p className="mt-1 text-[13.5px] text-muted-foreground">
                  {[[info.region, info.country].filter(Boolean).join(", "), `${info.members} member${info.members === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
                </p>
              </div>
              {info.member ? (
                <Button className="h-11 w-full rounded-xl" onClick={() => nav("/", { replace: true })}>
                  Open the workspace
                </Button>
              ) : (
                <>
                  <p className="text-[13.5px]">
                    You'll join as <b className="font-semibold">{ROLE_NAME[info.role] ?? info.role}</b> and see the institution's shared predictions and reports.
                    {leaving && <span className="mt-2 block text-muted-foreground">You'll leave {leaving}.</span>}
                  </p>
                  <Button className="h-11 w-full rounded-xl" disabled={busy} onClick={join}>
                    {busy ? <Loader2 className="animate-spin" /> : null} Join {info.name}
                  </Button>
                  <p className="text-[12px] text-muted-foreground">Signed in as {me?.email}</p>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
