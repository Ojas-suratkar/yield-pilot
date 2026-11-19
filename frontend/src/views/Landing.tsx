import { Link } from "react-router-dom";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@yield/core/ui/button";
import { Logo } from "../components/Logo";
import { STEPS } from "../lib/project";

function Snapshot() {
  const c = Math.PI * 62;
  return (
    <div className="relative mx-auto w-full max-w-sm">
      <div className="absolute -inset-8 rounded-[40px] bg-gradient-to-br from-primary/15 via-highlight/10 to-good/10 blur-2xl" aria-hidden />
      <div className="relative space-y-4">
        <div className="rounded-3xl bg-card p-6 shadow-xl shadow-primary/10">
          <div className="text-sm font-semibold text-muted-foreground">Example forecast</div>
          <div className="relative mx-auto mt-4 h-[90px] w-[160px]">
            <svg viewBox="0 0 150 84" className="h-full w-full" aria-hidden>
              <path d="M13 76a62 62 0 0 1 124 0" stroke="hsl(var(--muted))" strokeWidth="12" fill="none" strokeLinecap="round" />
              <path
                d="M13 76a62 62 0 0 1 124 0"
                stroke="hsl(var(--good))"
                strokeWidth="12"
                fill="none"
                strokeLinecap="round"
                strokeDasharray={c}
                strokeDashoffset={c * 0.682}
              />
            </svg>
            <div className="absolute inset-x-0 bottom-0 text-center font-display text-3xl font-extrabold">31.8%</div>
          </div>
          <div className="text-center text-sm text-muted-foreground">Predicted Yield</div>
          <div className="mx-auto mt-3 w-fit rounded-full bg-good/15 px-3 py-1 text-sm font-semibold text-good">↑ +3.4% vs. Fall 2026</div>
        </div>
        <div className="ml-10 flex items-center gap-4 rounded-3xl bg-card p-5 shadow-xl shadow-primary/10">
          <div className="grid h-14 w-14 place-items-center rounded-full border-[6px] border-good font-display text-sm font-extrabold">92%</div>
          <div>
            <div className="font-semibold">Data Health</div>
            <div className="text-sm text-muted-foreground">Overall Data Quality</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-hidden bg-background">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Logo />
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" className="rounded-full">
            <Link to="/login">Sign in</Link>
          </Button>
          <Button asChild className="rounded-full">
            <Link to="/login?mode=signup">Get started</Link>
          </Button>
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl items-center gap-14 px-6 pb-20 pt-10 lg:grid-cols-[1.2fr_1fr] lg:pt-16">
        <div>
          <span className="text-xs font-bold tracking-[0.08em] text-primary">WELCOME TO YIELDPILOT</span>
          <h1 className="mt-4 text-[42px] font-extrabold leading-[1.05] tracking-[-0.03em] sm:text-[58px]">
            Turn your admissions data into <span className="text-primary">enrollment confidence.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Follow a simple 7-step workflow to predict yield, explore what-if scenarios, and make faster, smarter decisions.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-4">
            <Button asChild size="lg" className="h-13 rounded-full px-8 py-3.5 text-base shadow-lg shadow-primary/25">
              <Link to="/login?mode=signup">
                Start Step 1: Connect Data <ArrowRight />
              </Link>
            </Button>
          </div>
        </div>
        <Snapshot />
      </section>

      <section className="bg-card py-20">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-3xl font-extrabold tracking-[-0.02em]">Simple 7-Step Workflow</h2>
          <p className="mt-2 text-lg text-muted-foreground">Go from your data to real insights in seven easy steps.</p>
          <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
            {STEPS.map((s) => (
              <li key={s.key} className="rounded-2xl bg-background p-5">
                <div className="flex items-center justify-between">
                  <span className="grid h-9 w-9 place-items-center rounded-full font-bold text-white" style={{ background: `var(--step-${s.step})` }}>
                    {s.step}
                  </span>
                  <s.icon className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="mt-4 font-semibold leading-tight">{s.title}</div>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.blurb}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="flex flex-col items-start justify-between gap-8 rounded-[32px] bg-gradient-to-br from-[#4c32c4] to-[#7c5ae6] px-8 py-12 text-white sm:px-12 lg:flex-row lg:items-center">
          <div>
            <h2 className="text-3xl font-extrabold">No coding required</h2>
            <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-white/85">
              {["Guided workflow", "Built for enrollment teams", "From data to decisions"].map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <Check className="h-4 w-4" strokeWidth={3} /> {t}
                </li>
              ))}
            </ul>
          </div>
          <Button asChild size="lg" className="h-13 rounded-full bg-white px-8 py-3.5 text-base text-[#4c32c4] hover:bg-white/90">
            <Link to="/login?mode=signup">
              Get started <ArrowRight />
            </Link>
          </Button>
        </div>
      </section>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-8 text-sm text-muted-foreground">
          <Logo tagline={false} />
          <span>Admission Yield Prediction Made Simple</span>
        </div>
      </footer>
    </div>
  );
}
