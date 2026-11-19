import React from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { initStore } from "@yield/core";
import { Link } from "react-router-dom";
import { Button } from "@yield/core/ui/button";
import { Loading } from "./components/ui";
import { Logo } from "./components/Logo";
import { forgetPage, pendingPage, rememberPage, useSession } from "./lib/auth";
import { SECTIONS } from "./lib/project";
import { TooltipProvider } from "@yield/core/ui/tooltip";
import { Shell } from "./components/Shell";
import { LandingPage } from "./views/Landing";
import { EmailLinkPage, LoginPage, SsoCallbackPage } from "./views/Login";
import { PrivacyPage, TermsPage } from "./views/Legal";
import { TeamPage } from "./views/Team";
import { BillingPage } from "./views/Billing";
import { AdminPage } from "./views/Admin";
import { UsagePage } from "./views/Usage";
import { InstitutionPage } from "./views/Institution";
import { JoinPage, WelcomePage } from "./views/Welcome";
import { HomePage } from "./views/Home";
import { FieldsPage, SourcePage, UploadPage } from "./views/steps/Data";
import { FixesPage, ReadinessPage } from "./views/steps/Audit";
import { GroupPage, TermPage, TrainingPage } from "./views/steps/Setup";
import { MorePage, StarterPage } from "./views/steps/Features";
import { ReviewPage, RunPage } from "./views/steps/Train";
import { ForecastPage, StudentsPage } from "./views/steps/Results";
import { ActionsPage, AdjustPage } from "./views/steps/Scenarios";
import { HistoryPage, PrintPage, SharedReportPage, SummaryPage } from "./views/steps/Reports";
import { ModelPage } from "./views/steps/Model";
import { MlWorkspacePage } from "./views/MlWorkspace";

initStore("yieldpilot");

const NAMED: Record<string, string> = {
  "/login": "Sign in", "/welcome": "Welcome", "/privacy": "Privacy Policy", "/terms": "Terms of Service", "/settings/team": "Team", "/settings/billing": "Billing",
  "/settings/institution": "Institution", "/usage": "Usage and costs", "/admin": "Operator dashboard", "/ml": "ML workspace",
};

/** Every page opens at its top and names itself in the browser tab. */
function PageBasics() {
  const { pathname } = useLocation();
  React.useEffect(() => {
    window.scrollTo(0, 0);
    const name = NAMED[pathname] ?? SECTIONS.flatMap((s) => s.subs).find((x) => x.path === pathname && pathname !== "/")?.label;
    document.title = name ? `${name} | YieldPilot` : "YieldPilot";
  }, [pathname]);
  return null;
}

function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center bg-background px-6 text-center">
      <div className="max-w-md">
        <div className="flex justify-center"><Logo /></div>
        <h1 className="mt-8 text-[26px] font-semibold tracking-[-0.03em]">We can't find that page</h1>
        <p className="mt-2 text-[14.5px] text-muted-foreground">The link may be old or mistyped.</p>
        <Button asChild className="mt-6 h-10 rounded-full px-5"><Link to="/">Go to YieldPilot</Link></Button>
      </div>
    </div>
  );
}

const GUEST_PAGES = ["/reports/history", "/shared/"];

/** Pages that need a signed-in member: the server confirms the session before anything renders. Someone who hasn't
 * created or joined an institution yet goes to the welcome screen; a guest sees only the reports shared with them. */
function App({ children }: { children: React.ReactNode }) {
  const { status, me } = useSession();
  const { pathname, search } = useLocation();
  React.useEffect(() => {
    if (status === "in") forgetPage();
  }, [status]);
  if (status === "loading") return <Loading text="Signing you in…" />;
  if (status !== "in") {
    rememberPage(pathname + search);
    return <Navigate to="/login" replace />;
  }
  const operatorPage = !!me?.operator && pathname.startsWith("/admin"); // an operator needs no workspace of their own for this
  if (!me?.institution && !operatorPage) return <Navigate to="/welcome" replace />;
  if (me?.role === "guest" && !operatorPage && !GUEST_PAGES.some((g) => pathname.startsWith(g))) return <Navigate to="/reports/history" replace />;
  return <Shell>{children}</Shell>;
}

function Home() {
  const { status, me } = useSession();
  if (status === "loading") return <Loading text="One moment…" />;
  if (status === "in" && !me?.institution) return <Navigate to="/welcome" replace />;
  const headed = status === "in" ? pendingPage() : null; // where they were going before signing in
  if (headed) return <Navigate to={headed} replace />;
  if (status === "in" && me?.role === "guest") return <Navigate to="/reports/history" replace />;
  return status === "in" ? (
    <Shell>
      <HomePage />
    </Shell>
  ) : (
    <LandingPage />
  );
}

const pages: [string, React.ComponentType][] = [
  ["/data/source", SourcePage],
  ["/data/upload", UploadPage],
  ["/data/fields", FieldsPage],
  ["/audit/readiness", ReadinessPage],
  ["/audit/fixes", FixesPage],
  ["/setup/term", TermPage],
  ["/setup/group", GroupPage],
  ["/setup/training", TrainingPage],
  ["/features/starter", StarterPage],
  ["/features/more", MorePage],
  ["/train/review", ReviewPage],
  ["/train/run", RunPage],
  ["/results/forecast", ForecastPage],
  ["/results/students", StudentsPage],
  ["/results/model", ModelPage],
  ["/scenarios/adjust", AdjustPage],
  ["/scenarios/actions", ActionsPage],
  ["/reports/summary", SummaryPage],
  ["/reports/history", HistoryPage],
  ["/reports", () => <Navigate to="/reports/summary" replace />],
  ["/settings/team", TeamPage],
  ["/settings/billing", BillingPage],
  ["/settings/institution", InstitutionPage],
  ["/admin", AdminPage],
  ["/usage", UsagePage],
  ["/ml", MlWorkspacePage],
  ["/shared/:fid", SharedReportPage],
];

export default function YieldPilotApp() {
  return (
  <React.StrictMode>
    <TooltipProvider delayDuration={150}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <PageBasics />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/login/email" element={<EmailLinkPage />} />
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/join/:code" element={<JoinPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/sso/callback" element={<SsoCallbackPage />} />
          <Route path="/print" element={<PrintPage />} />
          {pages.map(([path, C]) => (
            <Route
              key={path}
              path={path}
              element={
                <App>
                  <C />
                </App>
              }
            />
          ))}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
      <Toaster position="bottom-right" closeButton toastOptions={{ duration: 4000 }} />
    </TooltipProvider>
  </React.StrictMode>
  );
}
