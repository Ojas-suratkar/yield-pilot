import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, Download, FileSpreadsheet, FileText, Loader2, MessageCircle, Printer, SendHorizontal, Share2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Input, Textarea } from "@yield/core/ui/input";
import { Label } from "@yield/core/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@yield/core/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@yield/core/ui/dropdown-menu";
import { API, download } from "../lib/api";
import { Answer } from "./Answer";
import { termName } from "../lib/labels";
import { groupLabel, type Project } from "../lib/project";
import { can, useSession } from "../lib/auth";

export const groupName = groupLabel;
const isEmail = (x: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x);
const QUESTIONS = ["How reliable is this forecast?", "What drives yield this term?", "How does this compare to last year?", "Which admits should counselors prioritize?"];
const DATA_QUESTIONS = ["Summarize this dataset for me", "How has yield changed across terms?", "Which columns have the most missing data?", "Does campus visit count relate to enrolling?"];

/* --------------------------------------------------------------- download */

export function DownloadMenu({ p }: { p: Project }) {
  const f = p.forecast;
  if (!f) return null;
  const get = (format: "csv" | "txt") => download(API.exportUrl(f.id, format)).catch((e) => toast.error((e as Error).message));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 rounded-full px-4">
          <Download /> Download <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuItem onSelect={() => window.open(`/print?project=${p.id}`, "_blank")}>
          <Printer /> Yield report (PDF)
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void get("csv")}>
          <FileSpreadsheet /> Admit-level predictions (CSV)
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void get("txt")}>
          <FileText /> Yields file (TXT)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ------------------------------------------------------------------ share */

const ATTACH = [
  { key: "pdf", label: "Yield report (PDF)", hint: "Forecast, charts and executive summary" },
  { key: "csv", label: "Admit-level predictions (CSV)", hint: "Each admit's likelihood to enroll" },
  { key: "txt", label: "Yields file (TXT)", hint: "For loading into your CRM" },
];

export function ShareButton({ p }: { p: Project }) {
  const [open, setOpen] = useState(false);
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<string[]>(["pdf"]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const f = p.forecast;
  const { me } = useSession();
  const domain = me?.institution?.domain ?? "";
  const outside = emails.filter((e) => domain && !e.endsWith(`@${domain}`));
  if (!f || !can(me, "analyst")) return null;

  const add = () => {
    const parts = draft.split(/[,\s;]+/).filter(Boolean);
    const bad = parts.filter((x) => !isEmail(x));
    setEmails((e) => [...new Set([...e, ...parts.filter(isEmail)])]);
    setDraft(bad.join(", "));
    setErr(bad.length ? `"${bad[0]}" isn't a valid email address.` : "");
  };
  const send = async () => {
    const all = [...new Set([...emails, ...draft.split(/[,\s;]+/).filter(isEmail)])];
    if (!all.length) return setErr("Add at least one recipient.");
    setBusy(true);
    try {
      const r = await API.share(f.id, { recipients: all, files, message: note || undefined });
      toast.success(`Shared with ${all.length === 1 ? all[0] : `${all.length} people`}`, {
        description: r.invited.length ? `${r.invited.join(", ")} will join your workspace as ${r.invited.length === 1 ? "a viewer" : "viewers"} when they sign in.` : undefined,
      });
      setOpen(false);
      setEmails([]);
      setDraft("");
      setNote("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size="sm" className="h-9 rounded-full px-4" onClick={() => setOpen(true)}>
        <Share2 /> Share
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Share yield report</DialogTitle>
            <DialogDescription>
              {termName(f.summary.target_term)} {groupName(p)}. Colleagues at your institution see it in their YieldPilot notifications.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="sh-to">Recipients</Label>
            <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-[var(--radius-input)] border px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring">
              {emails.map((e) => (
                <span key={e} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                  {e}
                  <button onClick={() => setEmails((x) => x.filter((y) => y !== e))} aria-label={`Remove ${e}`}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <input
                id="sh-to"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={add}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "," || e.key === " ") {
                    e.preventDefault();
                    add();
                  } else if (e.key === "Backspace" && !draft) setEmails((x) => x.slice(0, -1));
                }}
                placeholder={emails.length ? "" : "dean@csulb.edu"}
                className="min-w-[160px] flex-1 bg-transparent px-1 text-sm outline-none"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Attachments</Label>
            <div className="space-y-1.5">
              {ATTACH.map((a) => {
                const on = files.includes(a.key);
                return (
                  <button
                    key={a.key}
                    type="button"
                    onClick={() => setFiles((f) => (on ? f.filter((x) => x !== a.key) : [...f, a.key]))}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                      on ? "border-primary/40 bg-primary/[0.05]" : "hover:bg-muted/60",
                    )}
                  >
                    <span className={cn("grid h-4 w-4 place-items-center rounded border", on ? "border-primary bg-primary text-white" : "border-input")}>
                      {on && <Check className="h-3 w-3" strokeWidth={3} />}
                    </span>
                    <span className="flex-1 text-sm">
                      <span className="font-medium">{a.label}</span>
                      <span className="block text-xs text-muted-foreground">{a.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sh-note">Message (optional)</Label>
            <Textarea
              id="sh-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Attached is the yield forecast for review ahead of Monday's enrollment meeting."
              className="min-h-[70px]"
            />
          </div>
          {outside.length > 0 && !err && (
            <p className="rounded-lg bg-muted px-3 py-2 text-[12.5px] text-muted-foreground">
              {outside.join(", ")} {outside.length === 1 ? "is" : "are"} outside @{domain}. They'll be invited to your workspace as{" "}
              {outside.length === 1 ? "a viewer" : "viewers"} and can see shared reports, not student IDs. Only admins and owners can invite.
            </p>
          )}
          {err && <p className="text-sm text-destructive">{err}</p>}
          <DialogFooter className="items-center sm:justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(`${location.origin}/reports/summary?project=${p.id}`);
                toast.success("Link copied");
              }}
            >
              <Copy /> Copy link
            </Button>
            <Button onClick={send} disabled={busy || !files.length} className="rounded-full px-5">
              {busy ? <Loader2 className="animate-spin" /> : <SendHorizontal />} Share report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------- chat */

export function YieldChat({
  p,
  onUse,
  className,
  questions,
  ask: trigger,
  onClose,
  title = "Ask YieldPilot",
}: {
  p: Project;
  onUse?: (text: string) => void;
  className?: string;
  questions?: string[];
  /** Ask a question from outside, e.g. a chart's Explain button. */
  ask?: { q: string; n: number };
  onClose?: () => void;
  title?: string;
}) {
  const [msgs, setMsgs] = useState<{ role: "you" | "ai"; text: string }[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);
  const send = async (text: string) => {
    if (!text.trim() || !p.dataset) return;
    const history = msgs.map((m) => ({ role: m.role === "you" ? "user" : "assistant", text: m.text }));
    setMsgs((m) => [...m, { role: "you", text }]);
    setQ("");
    setBusy(true);
    try {
      const { answer } = await API.chat(p.id, text, history);
      setMsgs((m) => [...m, { role: "ai", text: answer }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "ai", text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (trigger) void send(trigger.q);
  }, [trigger?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden surface", className)}>
      <div className="flex items-center gap-2.5 border-b px-4 py-2.5">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-secondary text-primary">
          <MessageCircle className="h-4 w-4" />
        </span>
        <div className="flex-1">
          <div className="text-[13px] font-semibold">{title}</div>
          <div className="text-[11px] text-muted-foreground">Answers from your data and forecast</div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close assistant"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div ref={box} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3.5">
        {msgs.map((m, i) => (
          <div key={i} className={cn("animate-in fade-in-0 slide-in-from-bottom-1 duration-200", m.role === "you" ? "flex justify-end" : "")}>
            <div
              className={cn(
                "max-w-[94%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed",
                m.role === "you" ? "whitespace-pre-line bg-primary text-primary-foreground" : "w-full bg-muted",
              )}
            >
              {m.role === "ai" ? <Answer text={m.text} /> : m.text}
              {m.role === "ai" && onUse && (
                <button onClick={() => onUse(m.text)} className="mt-1.5 block text-xs font-semibold text-primary hover:underline">
                  Add to summary
                </button>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex gap-1 px-1 py-2" aria-label="Thinking">
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60" style={{ animationDelay: `${i * 120}ms` }} />
            ))}
          </div>
        )}
        <div className={cn("space-y-1.5", msgs.length && "pt-1")}>
          {!msgs.length && <div className="px-0.5 pb-0.5 text-[11.5px] font-medium text-muted-foreground">Suggested questions</div>}
          {(questions ?? (p.forecast ? QUESTIONS : DATA_QUESTIONS))
            .filter((x) => !msgs.some((m) => m.text === x))
            .slice(0, msgs.length ? 3 : 6)
            .map((x) => (
              <button
                key={x}
                onClick={() => send(x)}
                disabled={busy}
                className="block w-full rounded-lg border px-3 py-1.5 text-left text-[12.5px] transition-colors hover:border-primary/40 hover:bg-primary/[0.04] disabled:opacity-50"
              >
                {x}
              </button>
            ))}
        </div>
      </div>
      <form
        className="flex gap-2 border-t p-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) send(q);
        }}
      >
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about yield, admits or a chart…" className="h-9" />
        <Button type="submit" size="icon" className="h-9 w-9 shrink-0" disabled={!q.trim() || busy} aria-label="Send">
          <SendHorizontal />
        </Button>
      </form>
    </div>
  );
}
