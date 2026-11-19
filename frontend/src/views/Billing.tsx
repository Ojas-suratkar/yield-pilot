import { useEffect, useState } from "react";
import { Check, CreditCard, ExternalLink, FlaskConical, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { cn, fmtDate } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Failed, Loading, Page, Soft } from "../components/ui";
import { API, type Billing, type Limits, type PlanInfo } from "../lib/api";
import { can, useSession } from "../lib/auth";
import { useQuery } from "../lib/query";
import { CONTACT } from "./Legal";
import { MemberRuns } from "../components/MemberRuns";

export const money = (cents: number | null | undefined, currency = "usd") =>
  cents == null ? "–" : (cents / 100).toLocaleString(undefined, { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: cents % 100 ? 2 : 0 });

const LIMIT_LABELS: [keyof Limits, string, (n: number) => string][] = [
  ["seats", "People", (n) => `${n} seats`],
  ["runs_per_user", "Runs per person", (n) => `${n} a month`],
  ["runs_per_institution", "Runs for the institution", (n) => `${n} a month`],
  ["rows_per_dataset", "Rows per dataset", (n) => n.toLocaleString()],
  ["storage_gb", "Storage", (n) => `${n} GB`],
  ["ai_questions", "AI questions", (n) => `${n.toLocaleString()} a month`],
  ["scenarios_per_study", "What-if scenarios per prediction", (n) => `${n}`],
  ["history_months", "Forecast history", (n) => (n % 12 ? `${n} months` : `${n / 12} year${n > 12 ? "s" : ""}`)],
];
const STATUS: Record<string, string> = {
  full_access: "Full access", free: "Free allowance", trialing: "Trial", active: "Active", past_due: "Payment due", canceled: "Cancelled",
};

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {used.toLocaleString()} {limit == null ? "· no limit" : `of ${limit.toLocaleString()}`}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-amber-500" : "bg-primary")} style={{ width: `${limit == null ? 0 : pct}%` }} />
      </div>
    </div>
  );
}

function PlanCard({ p, b, interval, owner, onChoose, busy }: { p: PlanInfo; b: Billing; interval: "month" | "year"; owner: boolean; onChoose: () => void; busy: boolean }) {
  const price = interval === "month" ? p.price_month : p.price_year;
  const current = b.plan === p.key && b.status !== "full_access" && (!b.interval || b.interval === interval);
  const paying = !!b.plan && ["active", "trialing", "past_due"].includes(b.status);
  const action = current ? "Your plan" : !paying ? `Choose ${p.name}` : b.plan === p.key ? `Switch to ${interval === "month" ? "monthly" : "yearly"}` : `Switch to ${p.name}`;
  const quoted = p.key === "enterprise";
  return (
    <Soft className={cn("flex flex-col p-5", current && "ring-2 ring-primary")}>
      <div className="flex items-center justify-between">
        <h3 className="text-[16px] font-semibold">{p.name}</h3>
        {current && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">Current plan</span>}
      </div>
      <div className="mt-2">
        {price ? (
          <>
            <span className="text-[26px] font-semibold tracking-[-0.03em]">{quoted ? "From " : ""}{money(price)}</span>
            <span className="ml-1 text-[13px] text-muted-foreground">/ {interval === "month" ? "month" : "year"}</span>
          </>
        ) : (
          <span className="text-[15px] font-medium text-muted-foreground">{quoted ? "Yearly, quoted" : "Yearly only"}</span>
        )}
      </div>
      <ul className="mt-4 space-y-1.5 text-[13px]">
        {LIMIT_LABELS.map(([k, label, fmt]) => (
          <li key={k} className="flex justify-between gap-3">
            <span className="text-muted-foreground">{label}</span>
            <span className="text-right font-medium tabular-nums">{p.limits[k] == null ? "Unlimited" : fmt(p.limits[k] as number)}</span>
          </li>
        ))}
      </ul>
      <ul className="mt-4 space-y-1 border-t pt-3 text-[12.5px]">
        {p.features.map((f) => (
          <li key={f} className="flex gap-1.5">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /> {f}
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-5">
        {quoted ? (
          <p className="rounded-lg bg-muted/60 px-3 py-2 text-center text-[12.5px] text-muted-foreground"><a className="font-medium text-primary hover:underline" href={`mailto:${CONTACT}?subject=YieldPilot%20Enterprise`}>Contact us</a> for a quote and invoice billing.</p>
        ) : (
          <Button className="w-full" disabled={!owner || !b.payments_ready || current || busy || !price} onClick={onChoose}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {action}
          </Button>
        )}
      </div>
    </Soft>
  );
}

export function BillingPage() {
  const { me } = useSession();
  const owner = can(me, "owner");
  const q = useQuery(can(me, "owner") ? "billing" : null, API.billing, 15_000);
  const [interval, setPeriod] = useState<"month" | "year">("year");
  const [busy, setBusy] = useState<string | null>(null);
  const [returned] = useState(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("checkout")));
  useEffect(() => {
    if (returned === "done") toast.success("Thanks! Your plan is updating; it shows here within a minute.", { id: "checkout" });
    if (returned === "cancelled") toast.info("Checkout cancelled. Nothing was charged.", { id: "checkout" });
    if (returned) window.history.replaceState(null, "", "/settings/billing");
    if (returned !== "done") return;
    let left = 20; // Stripe tells the server a moment after the buyer returns
    const t = setInterval(() => {
      void q.reload();
      if (--left <= 0) clearInterval(t);
    }, 3000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!owner) return <Page title="Billing" description="Only the workspace owner can see plans, payments and everyone's usage.">{null}</Page>;
  if (q.error) return <Failed error={q.error} retry={q.reload} />;
  if (!q.data) return <Loading text="Loading billing…" />;
  const b = q.data;

  const open = async (key: string, fn: () => Promise<{ url: string }>) => {
    setBusy(key);
    try {
      window.location.assign((await fn()).url);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(null);
    }
  };
  const planName = b.plans.find((p) => p.key === b.plan)?.name;

  return (
    <Page title="Billing" description={`Plan, usage and invoices for ${me?.institution?.name}.`} width="wide" mode="top">
      {b.test_mode && (
        <div className="mb-4 flex gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 text-[13.5px]">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div>
            <b className="font-semibold">Stripe test mode.</b> No real money moves. Pay with card 4242 4242 4242 4242, any future date and any security code.
          </div>
        </div>
      )}
      {b.status === "full_access" && (
        <div className="mb-4 flex gap-3 rounded-2xl border border-primary/25 bg-primary/[0.06] px-4 py-3 text-[13.5px]">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <b className="font-semibold">Full access during the pilot.</b> Every feature, no limits.
          </div>
        </div>
      )}
      {b.status !== "full_access" && !b.plan && (
        <div className="mb-4 flex gap-3 rounded-2xl border border-primary/25 bg-primary/[0.06] px-4 py-3 text-[13.5px]">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <b className="font-semibold">You're on the free allowance.</b> Choose a plan below for more people, more forecasts and bigger files.
          </div>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Soft className="p-5">
          <div className="text-[12.5px] font-semibold text-muted-foreground">Current plan</div>
          <div className="mt-1 text-[22px] font-semibold tracking-[-0.02em]">{b.status === "full_access" ? "Full access" : (planName ?? "Free")}</div>
          <div className="mt-1 text-[13px] text-muted-foreground">
            {b.status === "full_access" ? "Every feature, no limits" : (STATUS[b.status] ?? b.status)}
            {b.interval ? ` · billed ${b.interval === "month" ? "monthly" : "yearly"}` : ""}
            {b.current_period_end ? ` · ${b.cancel_at_period_end ? "ends" : "renews"} ${fmtDate(b.current_period_end)}` : ""}
          </div>
          {b.status === "past_due" && (
            <p className="mt-3 rounded-lg bg-destructive/[0.07] px-3 py-2 text-[12.5px] text-destructive">The last payment didn't go through. Update the card in Manage billing.</p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {b.has_customer && owner && (
              <Button variant="outline" disabled={!!busy} onClick={() => open("portal", API.billingPortal)}>
                {busy === "portal" ? <Loader2 className="animate-spin" /> : <CreditCard className="h-4 w-4" />} Manage billing
              </Button>
            )}
          </div>
          {!b.payments_ready && <p className="mt-3 text-[12.5px] text-muted-foreground">Online payment is being set up. Plans can be chosen soon.</p>}
        </Soft>
        <Soft className="space-y-4 p-5">
          <div className="flex items-baseline justify-between">
            <div className="text-[12.5px] font-semibold text-muted-foreground">This month</div>
            <div className="text-[12px] text-muted-foreground">since {new Date(b.usage.period_start).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}</div>
          </div>
          <Meter label="People" used={b.usage.seats + b.usage.pending_invites} limit={b.limits.seats} />
          <Meter label="Runs" used={b.usage.runs_month} limit={b.limits.runs_per_institution} />
          <Meter label="AI questions" used={b.usage.ai_questions} limit={b.limits.ai_questions} />
          <Meter label="Storage (GB)" used={b.usage.storage_gb} limit={b.limits.storage_gb} />
        </Soft>
      </div>

      <div className="mt-6">
        <MemberRuns id="workspace" load={API.memberRuns} save={API.setMemberRuns} />
      </div>

      <div className="mb-3 mt-8 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[16px] font-semibold">Plans</h2>
        <div className="inline-flex rounded-full border bg-card p-0.5 text-[12.5px]" role="tablist" aria-label="Billing period">
          {(["month", "year"] as const).map((i) => (
            <button key={i} role="tab" aria-selected={interval === i} onClick={() => setPeriod(i)}
              className={cn("rounded-full px-3 py-1 font-medium", interval === i ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
              {i === "month" ? "Monthly" : "Yearly"}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {b.plans.map((p) => (
          <PlanCard key={p.key} p={p} b={b} interval={interval} owner={owner} busy={busy === p.key}
            onChoose={() => open(p.key, () => API.checkout(p.key, interval))} />
        ))}
      </div>

      <h2 className="mb-3 mt-8 text-[16px] font-semibold">Invoices</h2>
      <Soft className="overflow-x-auto">
        {b.invoices.length ? (
          <table className="w-full text-[13px]">
            <thead className="border-b text-left text-[11.5px] text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-semibold">Date</th>
                <th className="px-4 py-2 font-semibold">Description</th>
                <th className="px-4 py-2 text-right font-semibold">Amount</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {b.invoices.map((i) => (
                <tr key={i.id}>
                  <td className="px-4 py-2">{fmtDate(i.created_at)}</td>
                  <td className="px-4 py-2">{i.description ?? "YieldPilot"}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(i.amount, i.currency)}</td>
                  <td className="px-4 py-2 capitalize">{i.status}{i.test_mode ? " (test)" : ""}</td>
                  <td className="px-4 py-2 text-right">
                    {i.url && (
                      <a href={i.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                        View <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No invoices yet.</p>
        )}
      </Soft>
    </Page>
  );
}
