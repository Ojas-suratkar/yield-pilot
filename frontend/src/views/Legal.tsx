import { Link } from "react-router-dom";
import { Logo } from "../components/Logo";

const UPDATED = "October 22, 2026";
export const CONTACT = "ira-tech@csulb.edu";

function Doc({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-6">
          <Link to="/">
            <Logo tagline={false} />
          </Link>
          <nav className="flex gap-5 text-[13px] text-muted-foreground">
            <Link to="/privacy" className="hover:text-foreground">
              Privacy
            </Link>
            <Link to="/terms" className="hover:text-foreground">
              Terms
            </Link>
          </nav>
        </div>
      </header>
      <article className="mx-auto max-w-3xl px-6 py-10 text-[14.5px] leading-relaxed text-foreground/90 [&_h2]:mt-8 [&_h2]:text-[17px] [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:mt-1 [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5">
        <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-foreground">{title}</h1>
        <p className="text-[13px] text-muted-foreground">Last updated {UPDATED}</p>
        {children}
        <h2>Contact</h2>
        <p>
          Questions or requests: <a className="text-primary underline" href={`mailto:${CONTACT}`}>{CONTACT}</a>
        </p>
      </article>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <Doc title="Privacy Policy">
      <p>
        YieldPilot helps college admissions and enrollment offices forecast how many admitted students will enroll. This policy explains what
        information YieldPilot handles and how it is protected.
      </p>
      <h2>Information we handle</h2>
      <ul>
        <li>
          <b>Your account:</b> when you sign in with Microsoft or Google we receive your name, email address and, where available, your job title,
          department and profile photo. We use them only to sign you in, show your profile and connect you to your institution's workspace.
        </li>
        <li>
          <b>Institution data:</b> admissions records that authorized staff upload or import from their own systems.
        </li>
        <li>
          <b>Activity records:</b> an audit log of actions such as uploads, data changes, forecasts, exports and sharing.
        </li>
      </ul>
      <h2>How institution data is protected</h2>
      <ul>
        <li>Names, email addresses, phone numbers and similar personal fields are removed when data arrives.</li>
        <li>Student IDs are replaced with keyed codes; the lookup that restores them is stored separately and only shown to authorized roles.</li>
        <li>Data is encrypted in transit and at rest and stored on Google Cloud in the United States.</li>
        <li>Each institution's data is visible only to that institution's signed-in members, according to their role.</li>
        <li>Connection credentials for source systems are encrypted and never shown again after they are saved.</li>
      </ul>
      <h2>AI features</h2>
      <p>
        Column mapping, data review, summaries and the question assistant use Google's Gemini models through Vertex AI. They receive column
        statistics and aggregate results only, never individual student records, and groups of fewer than 10 admits are left out of answers.
        Under Google Cloud's terms, this data is not used to train Google's models.
      </p>
      <h2>Sharing</h2>
      <p>
        We do not sell personal information or use it for advertising. Information is shared only with members of your own institution whom you
        choose, and with Google Cloud as our hosting provider.
      </p>
      <h2>Retention and deletion</h2>
      <p>
        Institution data is kept until the institution deletes it or asks us to. Contact us to delete an account or an institution's data.
      </p>
      <h2>Student records</h2>
      <p>
        Institutions remain the owners of their student records and decide how YieldPilot is used. YieldPilot is designed to support institutions'
        obligations under FERPA by limiting access, minimizing personal data and keeping an audit trail.
      </p>
    </Doc>
  );
}

export function TermsPage() {
  return (
    <Doc title="Terms of Service">
      <p>These terms apply to anyone who signs in to YieldPilot. By using the service you agree to them.</p>
      <h2>Use of the service</h2>
      <ul>
        <li>YieldPilot is for enrollment planning by colleges and universities and their authorized staff.</li>
        <li>Only upload or connect data that your institution permits you to use for this purpose.</li>
        <li>Keep your account to yourself and tell us about any unauthorized use.</li>
        <li>Don't attempt to access another institution's data, disrupt the service, or reverse engineer it.</li>
      </ul>
      <h2>Your data</h2>
      <p>
        Your institution owns the data it brings to YieldPilot and the reports it creates. We process that data only to provide the service, as
        described in the <Link className="text-primary underline" to="/privacy">Privacy Policy</Link>.
      </p>
      <h2>Forecasts</h2>
      <p>
        Forecasts, scenarios and recommendations are statistical estimates based on past data. They are not guarantees, and decisions based on them
        remain the institution's responsibility.
      </p>
      <h2>Availability and changes</h2>
      <p>
        We work to keep YieldPilot available and secure but cannot promise uninterrupted service. We may update the service and these terms; material
        changes will be noted on this page.
      </p>
    </Doc>
  );
}
