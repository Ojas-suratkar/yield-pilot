import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Loader2, Mail, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { store } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Input } from "@yield/core/ui/input";
import { Label } from "@yield/core/ui/label";
import { Logo } from "../components/Logo";
import { API, DEV_AUTH, type SignInMethod } from "../lib/api";
import { refreshSession, useSession } from "../lib/auth";

const ERRORS: Record<string, string> = {
  sso_not_configured: "That sign-in option isn't enabled yet. Use the email link instead.",
  email_not_verified: "Verify your email address with Google first, or use the email link.",
  token_exchange_failed: "The sign-in couldn't be completed. Please try again.",
  profile_failed: "Microsoft didn't share your profile. Please try again.",
  session: "Your session couldn't be started. Please try again.",
  domain_not_allowed: "Your institution isn't set up on YieldPilot yet.",
  invite_only: "Your institution's YieldPilot is invite only. Ask your administrator for an invitation.",
  account_disabled: "Your account is disabled. Ask an owner of your workspace.",
  account_linked: "This email is already linked to a different Microsoft account. Sign in with that account or use the email link.",
  guest_account: "Sign in with your own organization's account rather than a guest account.",
  invalid_state: "That sign-in took too long or was opened in another browser. Please try again.",
  access_denied: "Sign-in was cancelled.",
  microsoft_personal: "Personal Outlook, Hotmail and Live accounts sign in with an email link. Enter your address below.",
  microsoft_failed: "Microsoft couldn't sign you in to YieldPilot. Your organization may need to approve the app first. Use the email code for now.",
  microsoft_unavailable: "Your organization's Microsoft sign-in isn't connected to YieldPilot yet. Enter your email and we'll send you a sign-in link.",
};

const GoogleMark = () => (
  <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden>
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" />
    <path fill="#FBBC05" d="M10.6 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l8-6.1z" />
    <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.8l-8 6.1C6.6 42.6 14.6 48 24 48z" />
  </svg>
);

const MicrosoftMark = () => (
  <svg viewBox="0 0 21 21" className="h-4 w-4" aria-hidden>
    <path fill="#f25022" d="M1 1h9v9H1z" />
    <path fill="#7fba00" d="M11 1h9v9h-9z" />
    <path fill="#00a4ef" d="M1 11h9v9H1z" />
    <path fill="#ffb900" d="M11 11h9v9h-9z" />
  </svg>
);

/** Finishes a Google or Microsoft sign-in: the backend has set the session cookie, so load the profile. */
export function SsoCallbackPage() {
  const nav = useNavigate();
  useEffect(() => {
    void refreshSession().then((me) => nav(me ? "/" : "/login?error=session", { replace: true }));
  }, [nav]);
  return (
    <div className="flex min-h-screen items-center justify-center gap-3 text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" /> Signing you in…
    </div>
  );
}

type Provider = "microsoft" | "google";
const NAMES: Record<Provider, string> = { microsoft: "Microsoft", google: "Google" };
// recognized at once while typing; anything else is looked up (organizations) or gets an email link
const KNOWN: Record<string, SignInMethod> = {
  "gmail.com": "google", "googlemail.com": "google",
  "yahoo.com": "email", "ymail.com": "email", "icloud.com": "email", "me.com": "email", "aol.com": "email", "proton.me": "email",
  "protonmail.com": "email", "rediffmail.com": "email", "zoho.com": "email", "gmx.com": "email", "mail.com": "email",
};
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const go = (provider: Provider, email?: string) =>
  window.location.assign(`/api/auth/${provider}/login${email ? `?login_hint=${encodeURIComponent(email)}` : ""}`);

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background px-5 py-12">
      <Link to="/" className="absolute left-6 top-6 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Home
      </Link>
      <div className="w-full max-w-[400px]">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="space-y-5 rounded-2xl border bg-card p-8 shadow-[var(--shadow-card)]">{children}</div>
        <p className="mt-6 text-center text-[12px] text-muted-foreground">Student-level data stays in your institution's private workspace</p>
        <p className="mt-1 text-center text-[12px] text-muted-foreground">
          <Link to="/privacy" className="hover:text-foreground hover:underline">
            Privacy
          </Link>{" "}
          ·{" "}
          <Link to="/terms" className="hover:text-foreground hover:underline">
            Terms
          </Link>
        </p>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { status } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(() => params.get("email") ?? ""); // invitation emails link here with the address
  const [found, setFound] = useState<{ email: string; method?: SignInMethod; note?: string | null; error?: string } | null>(null);
  const [enabled, setEnabled] = useState<{ microsoft: boolean; google: boolean; microsoft_any?: boolean } | null>(null);
  const [askMs, setAskMs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [withCode, setWithCode] = useState(false);
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  // a failed sign-in is reported once; the address is cleaned so a refresh starts fresh
  const [failed] = useState(() => params.get("error"));
  useEffect(() => {
    if (params.get("error")) window.history.replaceState(null, "", "/login");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    API.providers().then(setEnabled, () => setEnabled({ microsoft: true, google: true }));
  }, []);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  // Recognize the address as it's typed: common providers at once, organizations by where their mail is hosted.
  useEffect(() => {
    const addr = email.trim().toLowerCase();
    if (!EMAIL.test(addr)) return setFound(null);
    const known = KNOWN[addr.split("@")[1]];
    if (known) return setFound({ email: addr, method: known });
    const t = setTimeout(
      () => API.discover(addr).then((r) => setFound({ email: addr, method: r.method, note: r.note }), (e: Error) => setFound({ email: addr, error: e.message })),
      350,
    );
    return () => clearTimeout(t);
  }, [email]);
  if (status === "in") return <Navigate to="/" replace />;

  const addr = email.trim().toLowerCase();
  const detected = found?.email === addr ? found : null;
  const method: SignInMethod | undefined = detected?.method;

  const sendLink = async (to: string) => {
    setBusy(true);
    try {
      const r = await API.emailStart(to);
      setSent(to);
      setWithCode(!!r.code);
      setCode("");
      setCooldown(30);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!EMAIL.test(addr)) return toast.error("Enter a valid email address.");
    if (DEV_AUTH) {
      setBusy(true);
      store.signIn(addr);
      if (await refreshSession()) nav("/");
      else toast.error("No YieldPilot account uses that email. Sign in once on the live site first.");
      return setBusy(false);
    }
    try {
      const m = method ?? (await API.discover(addr)).method;
      if (m === "email") return void sendLink(addr);
      setBusy(true);
      go(m, addr);
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  };
  const Mark = ({ p }: { p: Provider }) => (p === "google" ? <GoogleMark /> : <MicrosoftMark />);
  const verify = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const digits = code.replace(/\D/g, "");
    if (digits.length !== 6) return toast.error("Enter the 6-digit code from the email.");
    setBusy(true);
    try {
      await API.emailFinish({ code: digits, email: sent ?? undefined });
      if (await refreshSession()) nav("/", { replace: true });
      else throw new Error("Your session couldn't be started. Please try again.");
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  };

  if (sent)
    return (
      <Shell>
        <div className="text-center">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary">
            <Mail className="h-5 w-5" />
          </span>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Check your inbox</h1>
          <p className="mt-2 text-[13.5px] text-muted-foreground">
            {withCode ? (
              <>
                We sent a 6-digit code to <b className="font-medium text-foreground">{sent}</b>. Enter it below, or use the button in the email.
              </>
            ) : (
              <>
                We sent a sign-in link to <b className="font-medium text-foreground">{sent}</b>. Open it on this device to sign in. The link works once.
              </>
            )}
          </p>
        </div>
        {withCode && (
          <form onSubmit={verify} className="space-y-3">
            <Input
              aria-label="Sign-in code"
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d ]/g, "");
                setCode(v);
                if (v.replace(/\D/g, "").length === 6 && !busy) setTimeout(() => document.getElementById("verify-code")?.click(), 0);
              }}
              placeholder="123 456"
              className="h-12 rounded-xl text-center text-[22px] font-semibold tracking-[0.3em] tabular-nums"
            />
            <Button id="verify-code" type="submit" disabled={busy || code.replace(/\D/g, "").length !== 6} className="h-11 w-full rounded-xl">
              {busy ? <Loader2 className="animate-spin" /> : null} Sign in
            </Button>
          </form>
        )}
        <div className="rounded-xl bg-muted/60 px-4 py-3 text-[12.5px] text-muted-foreground">
          Not there? Check spam or junk, and make sure the address is right. It can take a minute to arrive. The {withCode ? "code expires in 15 minutes" : "link works once"}.
        </div>
        <div className="grid gap-2">
          <Button variant="outline" className="h-11 rounded-xl" disabled={busy || cooldown > 0} onClick={() => sendLink(sent)}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {cooldown > 0 ? `Send again in ${cooldown}s` : "Send the link again"}
          </Button>
          <Button variant="ghost" className="h-10 rounded-xl text-[13px]" onClick={() => setSent(null)}>
            Use a different email
          </Button>
        </div>
      </Shell>
    );

  return (
    <Shell>
      <div className="text-center">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Sign in to YieldPilot</h1>
        <p className="mt-1 text-[13.5px] text-muted-foreground">Use your work, school or personal email. New here? This creates your account.</p>
      </div>
      {failed && (
        <div role="alert" className="rounded-lg border border-destructive/25 bg-destructive/[0.06] px-3.5 py-2.5 text-[13px] text-destructive">
          {ERRORS[failed] ?? "Sign-in didn't complete. Please try again."}
        </div>
      )}
      {!DEV_AUTH && (
        <div className="grid gap-2.5">
          {(["google", "microsoft"] as Provider[]).map((pv) => (
            <Button
              key={pv}
              type="button"
              variant="outline"
              className="h-11 justify-center gap-2.5 rounded-xl text-[14px] font-medium"
              onClick={() => {
                if (enabled && !enabled[pv]) return toast.info(`${NAMES[pv]} sign-in isn't available right now. Use your email instead.`);
                // Microsoft works for some organizations only (until the app accepts every directory): find out which from the email
                if (pv === "microsoft" && enabled?.microsoft_any === false) {
                  setAskMs(true);
                  return document.getElementById("email")?.focus();
                }
                go(pv);
              }}
            >
              <Mark p={pv} /> Continue with {NAMES[pv]}
            </Button>
          ))}
        </div>
      )}
      {!DEV_AUTH && (
        <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
          <span className="h-px flex-1 bg-border" /> or continue with email <span className="h-px flex-1 bg-border" />
        </div>
      )}
      <form onSubmit={submit} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="username email"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="h-11 rounded-xl"
          />
          <p className="min-h-[18px] text-[12px] text-muted-foreground">
            {DEV_AUTH
              ? "Local development: signs in an existing account on the production database."
              : method === "email" && detected?.note === "microsoft_unavailable"
                ? `${addr.split("@")[1]} can't use Microsoft sign-in with YieldPilot yet, so we'll email you a secure sign-in link instead.`
                : method === "email"
                ? "We'll email you a secure one-time sign-in link."
                : askMs && !addr
                ? "Enter your work or school email to continue with Microsoft."
                : method
                  ? `We'll take you to ${NAMES[method]} to sign in as ${addr}.`
                  : (detected?.error ?? "")}
          </p>
        </div>
        <Button type="submit" disabled={busy || !!detected?.error} className="h-11 w-full gap-2 rounded-xl text-[14px]">
          {busy ? (
            <Loader2 className="animate-spin" />
          ) : method && method !== "email" && !DEV_AUTH ? (
            <span className="grid h-5 w-5 place-items-center rounded bg-white">
              <Mark p={method} />
            </span>
          ) : null}
          {DEV_AUTH ? "Continue" : method === "email" ? "Email me a sign-in link" : method ? `Continue with ${NAMES[method]}` : "Continue"}
          {!busy && <ArrowRight />}
        </Button>
        {!DEV_AUTH && method && method !== "email" && (
          <button type="button" onClick={() => sendLink(addr)} className="w-full text-center text-[12.5px] text-muted-foreground hover:text-foreground hover:underline">
            Email me a sign-in link instead
          </button>
        )}
      </form>
      <p className="flex items-center justify-center gap-1.5 text-[11.5px] text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" /> No passwords to remember. Links work once and are tied to your address.
      </p>
    </Shell>
  );
}

/** Where the emailed link lands: checks it with the server, then signs in. Opened on another device, it asks for the address once. */
export function EmailLinkPage() {
  const nav = useNavigate();
  const [state, setState] = useState<"checking" | "ask" | "error">("checking");
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const code = useRef<string | null>(null);
  const token = useRef<string | null>(null);
  const hint = useRef<string | null>(null);
  if (code.current === null && typeof window !== "undefined") {
    const q = new URLSearchParams(window.location.search);
    token.current = q.get("token");
    // the link's signed note of the address it was sent to, at the top level or inside the link Google's page passed on
    hint.current = q.get("h");
    for (const k of ["continueUrl", "link", "deep_link_id"]) {
      if (hint.current) break;
      try {
        hint.current = new URL(q.get(k) ?? "").searchParams.get("h");
      } catch {
        /* not a URL */
      }
    }
    let oob = q.get("oobCode");
    for (const k of ["link", "deep_link_id", "continueUrl"]) {
      if (oob) break;
      try {
        oob = new URL(q.get(k) ?? "").searchParams.get("oobCode");
      } catch {
        /* not a URL */
      }
    }
    code.current = oob ?? "";
  }
  const finish = async (addr?: string) => {
    setBusy(true);
    try {
      await API.emailFinish(token.current ? { token: token.current } : { oob_code: code.current ?? "", hint: hint.current ?? undefined, email: addr });
      if (await refreshSession()) nav("/", { replace: true });
      else throw new Error("Your session couldn't be started. Please try again.");
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 409) setState("ask");
      else {
        setError(e.message);
        setState("error");
      }
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    window.history.replaceState(null, "", "/login/email"); // the one-time code never stays in the address bar or history
    if (!code.current && !token.current) {
      setError("This sign-in link is incomplete. Request a new one.");
      setState("error");
    } else void finish();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (state === "checking")
    return (
      <div className="flex min-h-screen items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" /> Signing you in…
      </div>
    );
  return (
    <Shell>
      {state === "ask" ? (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (EMAIL.test(email.trim())) void finish(email.trim().toLowerCase());
          }}
        >
          <div className="text-center">
            <h1 className="text-[20px] font-semibold tracking-[-0.02em]">Confirm your email</h1>
            <p className="mt-1 text-[13.5px] text-muted-foreground">You opened the link on a different device or browser. Enter the address it was sent to.</p>
          </div>
          <Input type="email" autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="h-11 rounded-xl" />
          <Button type="submit" disabled={busy || !EMAIL.test(email.trim())} className="h-11 w-full rounded-xl">
            {busy ? <Loader2 className="animate-spin" /> : null} Sign in
          </Button>
        </form>
      ) : (
        <div className="space-y-4 text-center">
          <h1 className="text-[20px] font-semibold tracking-[-0.02em]">That link didn't work</h1>
          <p className="text-[13.5px] text-muted-foreground">{error}</p>
          <Button className="h-11 w-full rounded-xl" onClick={() => nav("/login", { replace: true })}>
            Back to sign in
          </Button>
        </div>
      )}
    </Shell>
  );
}
