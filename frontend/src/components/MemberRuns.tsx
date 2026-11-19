import { useEffect, useState } from "react";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { cn, fmtDate } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Loading } from "./ui";
import type { MemberRunsView } from "../lib/api";

const n = (v: number | null) => (v == null ? "No limit" : v.toLocaleString());

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl bg-muted/50 px-3.5 py-3">
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-[18px] font-semibold tabular-nums tracking-[-0.02em]">{value}</div>
      {note && <div className="text-[11.5px] text-muted-foreground">{note}</div>}
    </div>
  );
}

/**
 * Everyone's forecast runs this month, their allowance and what's left. The institution's owner (and operators) can give one
 * person more or fewer runs; everyone's together stays within the institution's monthly total. Read fresh on every visit.
 */
export function MemberRuns({ id, load, save, flat }: {
  id: string; load: () => Promise<MemberRunsView>; save: (userId: string, runs: number | null) => Promise<MemberRunsView>; flat?: boolean;
}) {
  const [v, setV] = useState<MemberRunsView | null>(null);
  const [edit, setEdit] = useState<{ id: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setV(null);
    load().then(setV, (e) => toast.error((e as Error).message));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const apply = async (userId: string, runs: number | null) => {
    setBusy(true);
    try {
      setV(await save(userId, runs));
      setEdit(null);
      toast.success(runs == null ? "Back to the plan's number" : "Runs updated");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!v) return <Loading text="Loading runs…" />;
  const total = v.total;
  const bad = edit != null && (edit.value.trim() === "" || !Number.isInteger(Number(edit.value)) || Number(edit.value) < 0);

  return (
    <div className={cn(!flat && "surface p-5")}>
      {!flat && (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[16px] font-semibold">Runs this month, person by person</h2>
          <span className="text-[12px] text-muted-foreground">Since {new Date(v.period_start).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}. Runs reset on the 1st.</span>
        </div>
      )}
      <div className={cn("grid gap-3 sm:grid-cols-3", !flat && "mt-3")}>
        <Stat label="Used by the institution" value={total == null ? v.used.toLocaleString() : `${v.used.toLocaleString()} of ${total.toLocaleString()}`}
          note={total == null ? "No monthly limit" : `${v.left} left this month`} />
        <Stat label="Allotted to people" value={total == null ? v.allotted.toLocaleString() : `${v.allotted.toLocaleString()} of ${total.toLocaleString()}`}
          note={v.unallotted == null ? undefined : v.unallotted >= 0 ? `${v.unallotted} not allotted yet` : `${-v.unallotted} over the monthly total`} />
        <Stat label="Plan's runs per person" value={n(v.per_user_default)} note={v.can_edit ? "Change anyone's below" : "Only the owner can change these"} />
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[700px] text-[13px]">
          <thead className="whitespace-nowrap border-b text-left text-[11.5px] font-semibold text-muted-foreground">
            <tr>
              <th className="py-2 pr-3">Person</th>
              <th className="py-2 text-right">Used</th>
              <th className="py-2 pl-3 text-right">Allowance</th>
              <th className="py-2 pl-4">Left</th>
              <th className="py-2 text-right">AI questions</th>
              <th className="py-2 pl-4">Last run</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {v.members.map((m) => {
              const pct = m.limit ? Math.min(100, (m.used / m.limit) * 100) : m.limit === 0 ? 100 : 0;
              const editing = edit?.id === m.id;
              return (
                <tr key={m.id} className={cn(!m.can_run && "text-muted-foreground")}>
                  <td className="max-w-[240px] py-2 pr-3">
                    <div className="truncate font-medium">{m.name || m.email}</div>
                    <div className="truncate text-[11.5px] text-muted-foreground">{m.email} · {m.role.replace("_", " ")}{m.active ? "" : " · disabled"}</div>
                  </td>
                  <td className="py-2 text-right tabular-nums">{m.used}</td>
                  <td className="whitespace-nowrap py-2 pl-3 text-right">
                    {editing ? (
                      <input autoFocus inputMode="numeric" aria-label={`Runs for ${m.name || m.email}`} value={edit.value}
                        className="h-8 w-20 rounded-md border border-input bg-card px-2 text-right tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onChange={(e) => setEdit({ id: m.id, value: e.target.value })}
                        onKeyDown={(e) => e.key === "Enter" && !bad && void apply(m.id, Number(edit.value))} />
                    ) : m.can_run ? (
                      <span className="tabular-nums">
                        {n(m.limit)}
                        {m.custom && <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-primary">set by owner</span>}
                      </span>
                    ) : (
                      "Can't run"
                    )}
                  </td>
                  <td className="py-2 pl-4">
                    {m.can_run && (m.limit == null ? (
                      <span className="text-muted-foreground">No limit</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                          <div className={cn("h-full rounded-full", pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-amber-500" : "bg-primary")} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="tabular-nums">{m.left}</span>
                      </div>
                    ))}
                  </td>
                  <td className="py-2 text-right tabular-nums">{m.ai_questions}</td>
                  <td className="whitespace-nowrap py-2 pl-4 text-[12px] text-muted-foreground">{m.last_run_at ? fmtDate(m.last_run_at) : "–"}</td>
                  <td className="whitespace-nowrap py-2 pl-2 text-right">
                    {v.can_edit && m.can_run && (editing ? (
                      <div className="flex justify-end gap-1">
                        <Button size="sm" className="h-8" disabled={busy || bad} onClick={() => void apply(m.id, Number(edit.value))}>
                          {busy ? <Loader2 className="animate-spin" /> : "Save"}
                        </Button>
                        {m.custom && <Button size="sm" variant="ghost" className="h-8" disabled={busy} onClick={() => void apply(m.id, null)}>Plan's number</Button>}
                        <Button size="sm" variant="ghost" className="h-8" disabled={busy} onClick={() => setEdit(null)}>Cancel</Button>
                      </div>
                    ) : (
                      <Button size="sm" variant="outline" className="h-8" onClick={() => setEdit({ id: m.id, value: m.limit == null ? "" : String(m.limit) })}>
                        <Pencil className="h-3.5 w-3.5" /> Change
                      </Button>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!v.enforced && <p className="mt-2 text-[12px] text-muted-foreground">Plan limits are off, so nobody is stopped yet.</p>}
    </div>
  );
}
