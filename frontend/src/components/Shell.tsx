import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { BarChart3, Bell, Camera, FlaskConical, Loader2, Building2, Check, ChevronsUpDown, CreditCard, Eye, LayoutDashboard, LogOut, Menu, MessageCircle, Pencil, Plus, Users, X, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { cn, fmtDate } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Input } from "@yield/core/ui/input";
import { Label } from "@yield/core/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@yield/core/ui/popover";
import { Logo } from "./Logo";
import { FLOW, SECTIONS, STEPS, groupLabel, projectStore, stepDone, useProject } from "../lib/project";
import { API, type Notice } from "../lib/api";
import { termName } from "../lib/labels";
import { can, setMe, signOut, useSession } from "../lib/auth";
import { ConfirmDelete, ErrorBoundary, StepTrack, tone } from "./ui";
import { clearSavedQueries, dropQueries } from "../lib/query";
import { YieldChat } from "./ReportTools";
import { Crest } from "../views/Welcome";
import { tuning, useTuning } from "../lib/tuning";

const GROUPS: { label: string; keys: string[] }[] = [
  { label: "Overview", keys: ["home"] },
  { label: "Workflow", keys: ["data", "audit", "setup", "features", "train", "results", "scenarios"] },
  { label: "Insights", keys: ["reports"] },
];

/** A page in the sidebar that isn't one of the forecast steps. */
function PageLink({ to, label, icon: Icon, toneKey, onGo }: { to: string; label: string; icon: LucideIcon; toneKey: string; onGo?: () => void }) {
  const on = useLocation().pathname.startsWith(to);
  return (
    <Link
      to={to}
      onClick={onGo}
      className={cn(
        "group flex items-center gap-2.5 rounded-lg px-2 py-[5px] text-[13.5px] transition-colors duration-150",
        on ? "bg-card font-semibold text-foreground shadow-[var(--shadow-card)] ring-1 ring-border" : "font-medium text-foreground/70 hover:bg-card/70 hover:text-foreground",
      )}
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors" style={{ background: tone(toneKey, on ? 0.16 : 0.09), color: tone(toneKey) }}>
        <Icon className="h-[15px] w-[15px]" />
      </span>
      <span className="flex-1">{label}</span>
    </Link>
  );
}

function Nav({ onGo }: { onGo?: () => void }) {
  const p = useProject();
  const { pathname } = useLocation();
  const { me } = useSession();
  const active = SECTIONS.find((s) => s.subs.some((x) => x.path === pathname))?.key;
  const groups = !me?.institution ? [] : me.role === "guest" ? GROUPS.filter((g) => g.label === "Insights") : GROUPS; // guests see shared reports only

  return (
    <nav aria-label="Main" className="space-y-6">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="mb-1.5 px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">{g.label}</div>
          <div className="space-y-0.5">
            {SECTIONS.filter((s) => g.keys.includes(s.key)).map((s) => {
              const isActive = s.key === active;
              const done = s.step ? stepDone(p, s.step) : false;
              return (
                <div key={s.key}>
                  <Link
                    to={s.subs[0].path}
                    onClick={onGo}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-lg px-2 py-[5px] text-[13.5px] transition-colors duration-150",
                      isActive
                        ? "bg-card font-semibold text-foreground shadow-[var(--shadow-card)] ring-1 ring-border"
                        : "font-medium text-foreground/70 hover:bg-card/70 hover:text-foreground",
                    )}
                  >
                    <span
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors"
                      style={{ background: tone(s.key, isActive ? 0.16 : 0.09), color: tone(s.key) }}
                    >
                      <s.icon className="h-[15px] w-[15px]" />
                    </span>
                    <span className="flex-1">{s.label}</span>
                    {s.step ? (
                      done ? (
                        <span className="grid h-[18px] w-[18px] place-items-center rounded-full bg-good/12 text-good">
                          <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                        </span>
                      ) : (
                        <span className="text-[11px] font-medium tabular-nums text-muted-foreground/70">{s.step}</span>
                      )
                    ) : null}
                  </Link>
                  {isActive && s.subs.length > 1 && (
                    <ul className="ml-[19px] mt-1 space-y-px border-l border-border pl-3 animate-in fade-in-0 duration-200">
                      {s.subs.map((sub) => (
                        <li key={sub.key}>
                          <NavLink
                            to={sub.path}
                            onClick={onGo}
                            style={({ isActive: on }) => (on ? { borderColor: tone(s.key) } : undefined)}
                            className={({ isActive: on }) =>
                              cn(
                                "-ml-px flex items-center gap-2 border-l-2 py-1.5 pl-3 text-[13px] transition-colors duration-150",
                                on ? "font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                              )
                            }
                          >
                            {sub.label}
                          </NavLink>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
            {g.label === "Insights" && me?.ml && <PageLink to="/ml" label="ML workspace" icon={FlaskConical} toneKey="reports" onGo={onGo} />}
            {g.label === "Insights" && me?.role !== "guest" && <PageLink to="/usage" label={me?.role === "owner" ? "Usage and costs" : "My usage and costs"} icon={BarChart3} toneKey="reports" onGo={onGo} />}
          </div>
        </div>
      ))}
    </nav>
  );
}

const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", data_manager: "Data manager", analyst: "Analyst", viewer: "Viewer", guest: "Guest" };

/** A picture from the computer or phone, made small in the browser before it's sent (the server re-draws it again as a 256px PNG). */
function shrink(file: File, max = 512): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) return reject(new Error("Choose a PNG, JPEG or WebP picture."));
    if (file.size > 15 * 1024 * 1024) return reject(new Error("That picture is too large. Choose one under 15 MB."));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.width, img.height); // the centre square, like the profile circle
      const size = Math.min(max, side);
      const c = document.createElement("canvas");
      c.width = c.height = size;
      c.getContext("2d")!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.9));
    };
    img.onerror = () => (URL.revokeObjectURL(url), reject(new Error("That picture couldn't be opened.")));
    img.src = url;
  });
}

function Profile() {
  const { me } = useSession();
  const nav = useNavigate();
  const pickPhoto = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const photo = async (fn: () => Promise<Parameters<typeof setMe>[0]>, ok: string) => {
    setPhotoBusy(true);
    try {
      setMe(await fn());
      toast.success(ok);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPhotoBusy(false);
    }
  };
  const [name, setName] = useState(me?.name ?? "");
  const [title, setTitle] = useState(me?.title ?? "");
  const [dept, setDept] = useState(me?.department ?? "");
  useEffect(() => {
    setName(me?.name ?? "");
    setTitle(me?.title ?? "");
    setDept(me?.department ?? "");
  }, [me?.name, me?.title, me?.department]);
  const initials = (me?.name || me?.email || "")
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2);
  const Avatar = ({ size }: { size: string }) =>
    me?.photo ? (
      <img src={me.photo} alt="" referrerPolicy="no-referrer" className={cn("shrink-0 rounded-full object-cover", size)} />
    ) : (
      <span className={cn("grid shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold uppercase text-primary-foreground", size)}>{initials}</span>
    );
  return (
    <Popover>
      <PopoverTrigger className="flex items-center gap-2.5 rounded-full py-1 pl-1 pr-3 transition-colors hover:bg-muted" aria-label="Your profile">
        <Avatar size="h-8 w-8" />
        <span className="hidden text-left leading-tight sm:block">
          <span className="block text-[13px] font-semibold">{me?.name || me?.email}</span>
          <span className="block text-[11px] text-muted-foreground">{me?.title || (me ? ROLE[me.role] : "")}</span>
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="flex items-center gap-3 border-b p-4">
          <button type="button" onClick={() => pickPhoto.current?.click()} disabled={photoBusy} title="Change your photo"
            className="group relative shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Avatar size="h-14 w-14 text-sm" />
            <span className="absolute inset-0 grid place-items-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              {photoBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
            </span>
          </button>
          <input ref={pickPhoto} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void photo(async () => API.setPhoto(await shrink(f)), "Photo updated");
            }} />
          <div className="min-w-0">
            <div className="truncate font-semibold">{me?.name || me?.email}</div>
            <div className="truncate text-xs text-muted-foreground">{me?.email}</div>
            <div className="mt-1 flex gap-3 text-[11.5px] font-medium">
              <button type="button" disabled={photoBusy} className="text-primary hover:underline" onClick={() => pickPhoto.current?.click()}>
                {me?.photo ? "Change photo" : "Add a photo"}
              </button>
              {me?.photo && (
                <button type="button" disabled={photoBusy} className="text-muted-foreground hover:text-foreground hover:underline"
                  onClick={() => void photo(API.removePhoto, "Photo removed")}>Remove</button>
              )}
            </div>
            {me && (
              <div className="truncate text-xs text-muted-foreground">
                {me.institution?.name} · {ROLE[me.role]}
              </div>
            )}
          </div>
        </div>
        <form
          className="space-y-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            API.updateMe({ name, title, department: dept })
              .then((m) => {
                setMe(m);
                toast.success("Profile saved");
              })
              .catch((err) => toast.error((err as Error).message));
          }}
        >
          {(
            [
              ["pf-name", "Name", name, setName],
              ["pf-title", "Job title", title, setTitle],
              ["pf-dept", "Department", dept, setDept],
            ] as const
          ).map(([id, label, value, setter]) => (
            <div key={id} className="space-y-1">
              <Label htmlFor={id} className="text-xs">
                {label}
              </Label>
              <Input id={id} value={value} onChange={(e) => setter(e.target.value)} className="h-9" />
            </div>
          ))}
          <Button type="submit" size="sm" className="w-full">
            Save profile
          </Button>
        </form>
        {me?.institution?.personal ? (
          <Link
            to="/welcome"
            className="flex w-full items-center gap-2 border-t px-4 py-3 text-sm font-medium text-primary transition-colors hover:bg-muted"
          >
            <Building2 className="h-4 w-4" /> Create or join an institution
          </Link>
        ) : (
          <Link
            to="/settings/institution"
            className="flex w-full items-center gap-2 border-t px-4 py-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Building2 className="h-4 w-4" /> Institution
          </Link>
        )}
        <Link
          to="/settings/team"
          className="flex w-full items-center gap-2 border-t px-4 py-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Users className="h-4 w-4" /> Team and roles
        </Link>
        {can(me, "owner") && (
          <Link
            to="/settings/billing"
            className="flex w-full items-center gap-2 border-t px-4 py-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <CreditCard className="h-4 w-4" /> Billing
          </Link>
        )}
        {me?.operator && (
          <Link
            to="/admin"
            className="flex w-full items-center gap-2 border-t px-4 py-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <LayoutDashboard className="h-4 w-4" /> Operator dashboard
          </Link>
        )}
        <button
          onClick={() => {
            projectStore.clear();
            void signOut().then(() => nav("/login"));
          }}
          className="flex w-full items-center gap-2 border-t px-4 py-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <LogOut className="h-4 w-4" /> Sign out
        </button>
      </PopoverContent>
    </Popover>
  );
}

/** Ask Gemini about the current prediction's data and forecast, from any page. */
function AskAi() {
  const p = useProject();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  if (!p?.dataset || ["/results/forecast", "/reports/summary", "/usage", "/ml", "/admin", "/settings"].some((x) => pathname.startsWith(x))) return null;
  return (
    <>
      <Button variant={open ? "secondary" : "ghost"} size="sm" className="h-9 rounded-full px-3.5" onClick={() => setOpen(!open)}>
        <MessageCircle className="text-muted-foreground" /> <span className="hidden sm:inline">Ask a question</span>
      </Button>
      {open && (
        <div className="fixed bottom-4 right-4 top-[4.5rem] z-40 w-[380px] max-w-[calc(100vw-2rem)] animate-in fade-in-0 slide-in-from-right-2 duration-200">
          <YieldChat p={p} className="h-full shadow-2xl" title="Ask about your data" onClose={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}

/** People with view-only access learn why some buttons are missing, once, without a scary error. */
function ViewOnly() {
  const { me } = useSession();
  if (!me?.institution || (me.role !== "viewer" && me.role !== "guest")) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-card px-4 py-2 text-[12.5px] text-muted-foreground shadow-[var(--shadow-lift)] lg:left-[calc(50%+124px)]">
      <Eye className="h-4 w-4" />
      {me.role === "guest" ? "You're a guest: you see the reports shared with you." : "You have view-only access. An admin can change your role."}
    </div>
  );
}

/** In-app notifications (reports shared with you), polled every minute. */
function Notifications() {
  const nav = useNavigate();
  const [items, setItems] = useState<Notice[]>([]);
  useEffect(() => {
    const load = () => API.notifications().then(setItems, () => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  const unread = items.filter((n) => !n.read);
  return (
    <Popover
      onOpenChange={(o) => {
        if (!o && unread.length) API.readNotifications(unread.map((n) => n.id)).then(() => setItems((x) => x.map((n) => ({ ...n, read: true }))), () => undefined);
      }}
    >
      <PopoverTrigger className="relative rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Notifications">
        <Bell className="h-[18px] w-[18px]" />
        {unread.length > 0 && (
          <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
            {unread.length}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-4 py-3 text-[13px] font-semibold">Notifications</div>
        <ul className="max-h-80 divide-y overflow-y-auto">
          {items.map((n) => (
            <li key={n.id}>
              <button
                onClick={() => n.link && nav(n.link)}
                className={cn("block w-full px-4 py-3 text-left transition-colors hover:bg-muted/60", !n.read && "bg-primary/[0.04]")}
              >
                <div className="text-[13px] font-medium">{n.title}</div>
                {n.body && <div className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">{n.body}</div>}
                <div className="mt-1 text-[11px] text-muted-foreground">{fmtDate(n.created_at)}</div>
              </button>
            </li>
          ))}
          {!items.length && <li className="px-4 py-8 text-center text-[13px] text-muted-foreground">Nothing new.</li>}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** The current prediction at the foot of the sidebar: what it is, how far along, and a switcher to the others. */
function ProjectCard() {
  const p = useProject();
  const me = useSession().me;
  const guest = me?.role === "guest";
  const nav = useNavigate();
  const [list, setList] = useState<Awaited<ReturnType<typeof API.projects>>>([]);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [find, setFind] = useState("");
  const canCreate = can(me, "analyst");
  const rename = async () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    setRenaming(null);
    if (!name) return;
    setList((l) => l.map((y) => (y.id === renaming.id ? { ...y, name } : y)));
    try {
      const out = await API.patchProject(renaming.id, { name });
      if (renaming.id === p?.id) projectStore.set(out);
      toast.success("Renamed");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  if (!p || guest) return null;
  const done = STEPS.filter((s) => stepDone(p, s.step!)).length;
  return (
    <Popover onOpenChange={(o) => o && API.projects().then(setList, () => undefined)}>
      <PopoverTrigger className="m-3 block w-[calc(100%-1.5rem)] rounded-xl border bg-card p-3.5 text-left shadow-[var(--shadow-card)] transition-colors hover:border-foreground/20">
        <div className="flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Current prediction <ChevronsUpDown className="h-3.5 w-3.5" />
        </div>
        <div className="mt-1 truncate text-[13px] font-semibold">
          {p.setup.term ? `${termName(p.setup.term)} · ${groupLabel(p)}` : p.name}
        </div>
        {p.owner?.name && <div className="truncate text-[11px] text-muted-foreground">by {p.owner.id === me?.id ? "you" : p.owner.name}</div>}
        <div className="mt-2.5 flex items-center gap-2">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${(done / 7) * 100}%` }} />
          </span>
          <span className="text-[11px] font-medium tabular-nums text-muted-foreground">{done}/7</span>
        </div>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-64 p-1">
        {list.length > 6 && (
          <input
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder="Find a prediction"
            className="mb-1 h-8 w-full rounded-md border border-input bg-background px-2.5 text-[12.5px] outline-none"
          />
        )}
        <ul className="max-h-72 overflow-y-auto">
          {list.filter((x) => !find.trim() || x.name.toLowerCase().includes(find.trim().toLowerCase())).map((x) => (
            <li key={x.id} className="flex items-center gap-1 rounded-md pr-1 hover:bg-muted">
              {renaming?.id === x.id ? (
                <input
                  autoFocus
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: x.id, name: e.target.value })}
                  onBlur={() => void rename()}
                  onKeyDown={(e) => (e.key === "Enter" ? void rename() : e.key === "Escape" ? setRenaming(null) : undefined)}
                  maxLength={200}
                  aria-label="New name"
                  className="m-1 h-8 min-w-0 flex-1 rounded border border-primary bg-background px-2 text-[13px] outline-none"
                />
              ) : (
                <button
                  onClick={() => void projectStore.open(x.id).then(() => nav("/"))}
                  className={cn("flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-[13px]", x.id === p.id && "font-semibold")}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{x.name}</span>
                    <span className="block truncate text-[11px] font-normal text-muted-foreground">
                      {x.mine ? "You" : (x.owner?.name ?? "A colleague")}
                      {x.last_run ? ` · run by ${x.last_run.by ?? "a colleague"}` : ""}
                    </span>
                  </span>
                  {x.id === p.id && <Check className="h-3.5 w-3.5 text-primary" />}
                </button>
              )}
              {canCreate && renaming?.id !== x.id && (
                <button
                  onClick={() => setRenaming({ id: x.id, name: x.name })}
                  className="rounded-full p-1.5 text-muted-foreground/70 hover:bg-primary/10 hover:text-primary"
                  aria-label={`Rename ${x.name}`}
                  title="Rename"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
              {canCreate && (
                <ConfirmDelete
                  label={undefined}
                  confirm="Delete"
                  onConfirm={async () => {
                    const next = await projectStore.remove(x.id);
                    setList((l) => l.filter((y) => y.id !== x.id));
                    toast.success(`Deleted ${x.name}`);
                    if (x.id === p.id) nav(next?.dataset ? "/" : "/data/source");
                  }}
                />
              )}
            </li>
          ))}
        </ul>
        {canCreate && <div className="border-t pt-1">
          <button
            onClick={() => void projectStore.startNew().then(() => nav("/data/source"))}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-[13px] font-medium text-primary hover:bg-muted"
          >
            <Plus className="h-3.5 w-3.5" /> New prediction
          </button>
        </div>}
      </PopoverContent>
    </Popover>
  );
}

const roleName = (r: string) => r.replace("_", " ").replace(/^./, (c) => c.toUpperCase());

/** The workspace being worked in, under the logo: a menu of every workspace this person belongs to, to switch between them. */
function Workspace({ onGo }: { onGo?: () => void }) {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const inst = me?.institution;
  if (!inst) return null;
  const list = me?.workspaces ?? [];
  const go = async (id: string) => {
    if (id === inst.id) return setOpen(false);
    setBusy(id);
    try {
      await API.switchWorkspace(id);
      projectStore.clear();
      dropQueries("");
      clearSavedQueries(true);
      window.location.assign("/"); // a fresh start in the other workspace: its predictions, people and settings
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(null);
    }
  };
  const item = "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[13px] transition-colors hover:bg-muted";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button aria-label="Switch workspace"
          className="mx-3 mb-1 flex w-[calc(100%-1.5rem)] items-center gap-2.5 rounded-xl border bg-card px-2.5 py-2 text-left transition-colors hover:border-foreground/20">
          <Crest inst={inst} size={28} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-semibold leading-tight">{inst.name}</span>
            <span className="block text-[10.5px] text-muted-foreground">
              {list.length > 1 ? `${list.length} workspaces · switch` : inst.personal ? "Personal workspace" : "Shared workspace"}
            </span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[288px] p-1.5">
        <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Your workspaces</div>
        {list.map((w) => (
          <button key={w.id} className={item} disabled={!!busy} onClick={() => void go(w.id)}>
            <Crest inst={w} size={24} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{w.name}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {roleName(w.role)}{w.domain ? ` · ${w.domain}` : ""} · {w.people} {w.people === 1 ? "person" : "people"}
              </span>
            </span>
            {busy === w.id ? <Loader2 className="h-4 w-4 animate-spin" /> : w.current && <Check className="h-4 w-4 text-primary" />}
          </button>
        ))}
        <div className="my-1 border-t" />
        <Link to="/settings/institution" className={item} onClick={() => (setOpen(false), onGo?.())}>
          <Building2 className="h-4 w-4 text-muted-foreground" /> Settings for {inst.name}
        </Link>
        <Link to="/welcome" className={item} onClick={() => (setOpen(false), onGo?.())}>
          <Plus className="h-4 w-4 text-muted-foreground" /> Join or create another workspace
        </Link>
      </PopoverContent>
    </Popover>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { pathname, search } = useLocation();
  const { me } = useSession();
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.scrollTo(0, 0); // every page opens at its top
  }, [pathname]);
  // shared links carry ?project=…: open that prediction
  useEffect(() => {
    const want = new URLSearchParams(search).get("project");
    if (want && projectStore.get()?.id !== want) projectStore.open(want).catch(() => toast.error("That prediction isn't available to you."));
  }, [search]);
  const sidebar = (
    <div className="flex h-full flex-col border-r bg-[hsl(var(--sidebar))]">
      <Link to="/" onClick={() => setOpen(false)} className="flex h-14 items-center px-5">
        <Logo tagline={false} />
      </Link>
      <Workspace onGo={() => setOpen(false)} />
      <div className="flex-1 overflow-y-auto px-3 pb-4 pt-3">
        <Nav onGo={() => setOpen(false)} />
      </div>
      {me?.operator && (
        <div className="px-3 pt-2">
          <PageLink to="/admin" label="Operator dashboard" icon={LayoutDashboard} toneKey="home" onGo={() => setOpen(false)} />
        </div>
      )}
      <ProjectCard />
    </div>
  );
  return (
    <div className="h-dvh overflow-hidden lg:pl-[248px]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/25 animate-in fade-in-0" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[248px] shadow-xl animate-in slide-in-from-left duration-200">{sidebar}</aside>
          <button className="absolute left-[260px] top-3 rounded-full bg-background p-2 shadow" onClick={() => setOpen(false)} aria-label="Close menu">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <header className="relative z-20 flex h-14 items-center gap-3 border-b bg-card px-4 sm:px-7">
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-[-1px] h-[2px] opacity-70"
          style={{ background: "linear-gradient(90deg, hsl(var(--c-home)), hsl(var(--c-data)), hsl(var(--c-audit)), hsl(var(--c-features)), hsl(var(--c-scenarios)))" }}
        />
        <button onClick={() => setOpen(true)} className="rounded-lg p-2 hover:bg-muted lg:hidden" aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </button>
        {FLOW.some((f) => f.sub.path === pathname && f.section.key !== "home") ? <StepTrack /> : <span className="text-[13.5px] font-semibold">{pathname.startsWith("/settings/institution") ? "Institution" : pathname.startsWith("/settings/team") ? "Team" : pathname.startsWith("/settings/billing") ? "Billing" : pathname.startsWith("/ml") ? "ML workspace" : pathname.startsWith("/usage") ? "Usage and costs" : pathname.startsWith("/admin") ? "Operator dashboard" : "Home"}</span>}
        <div className="ml-auto flex items-center gap-1">
          <TestDock />
          <AskAi />
          <Notifications />
          <Profile />
        </div>
      </header>
      <ViewOnly />
      <main id="main" ref={main} className="h-[calc(100dvh-3.5rem)] overflow-y-auto">
        <ErrorBoundary key={pathname}>{children}</ErrorBoundary>
      </main>
    </div>
  );
}

/** A settings test keeps running on the server while people use the rest of YieldPilot: a pill in the header follows it on every
 * page (its progress, then the outcome), with Open and Stop. Only Stop ends it early. */
function TestDock() {
  const live = useTuning();
  const p = useProject();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [stopping, setStopping] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => tuning.resume(), []);
  if (!live || (pathname.startsWith("/ml") && p?.id === live.projectId)) return null; // the ML workspace shows it itself
  const going = live.status === "running" || live.status === "stopping";
  if (!going && live.seen) return null;
  const done = live.status === "done";
  const show = async () => {
    setOpen(false);
    if (p?.id !== live.projectId) await projectStore.open(live.projectId);
    nav("/ml");
  };
  const stop = async () => {
    setStopping(true);
    try {
      await API.mlTuneCancel(live.projectId);
      tuning.stopping(live.projectId);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setStopping(false);
    }
  };
  const pct = Math.round(live.step?.pct ?? 0);
  const short = live.status === "stopping" ? "Stopping test" : going ? `Testing settings · ${pct}%` : done ? "Test finished" : live.status === "cancelled" ? "Test stopped" : "Test didn't finish";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn("relative mr-1 flex h-9 items-center gap-2 overflow-hidden rounded-full border px-3 text-[12.5px] font-semibold transition-colors",
          going ? "border-primary/30 bg-primary/[0.06] text-primary hover:bg-primary/10" : done ? "border-good/30 bg-good/[0.08] text-good hover:bg-good/[0.12]" : "bg-muted text-muted-foreground")}
        aria-label={short}
      >
        {going ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : done ? <Check className="h-3.5 w-3.5" /> : <FlaskConical className="h-3.5 w-3.5" />}
        <span className="hidden whitespace-nowrap tabular-nums md:inline">{short}</span>
        <span className="tabular-nums md:hidden">{going ? `${pct}%` : ""}</span>
        {going && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-primary/15"><span className="block h-full bg-primary transition-[width] duration-500" style={{ width: `${pct}%` }} /></span>}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3.5">
        <div className="text-[13px] font-semibold">{going ? "Testing model settings" : done ? "Settings test finished" : live.status === "cancelled" ? "Settings test stopped" : "Settings test couldn't finish"}</div>
        <div className="truncate text-[12px] text-muted-foreground">{live.name}</div>
        {going && (
          <div className="mt-3">
            <div className="flex justify-between gap-2 text-[11.5px] text-muted-foreground">
              <span className="truncate">{live.step?.label ?? "Starting"}{live.step?.detail ? ` · ${live.step.detail}` : ""}</span>
              <span className="tabular-nums">{pct}%</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${Math.max(3, pct)}%` }} />
            </div>
            <p className="mt-2 text-[11.5px] text-muted-foreground">It runs on YieldPilot's server and keeps going while you work. Only Stop ends it early.</p>
          </div>
        )}
        {!going && live.error && <p className="mt-2 text-[12px] text-muted-foreground">{live.error}</p>}
        <div className="mt-3 flex gap-2">
          <Button size="sm" className="h-8" onClick={() => void show()}>{going ? "Open" : done ? "See results" : "Open ML workspace"}</Button>
          {live.status === "running" && (
            <Button size="sm" variant="ghost" className="h-8" disabled={stopping} onClick={() => void stop()}>{stopping && <Loader2 className="animate-spin" />} Stop test</Button>
          )}
          {!going && <Button size="sm" variant="ghost" className="ml-auto h-8" onClick={() => (setOpen(false), tuning.dismiss())}>Dismiss</Button>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
