# YieldPilot — CSULB Pilot Build Plan (2 weeks, 40 hours, solo)

| | |
|---|---|
| Builder | 1 developer + Claude Code writing most of the code |
| Budget | 40 working hours over 10 working days (≈ 4 h/day) |
| Pilot | CSULB (First-Time Freshman + Transfer) |
| Sign-in | Microsoft (CSULB Entra ID) + email/password for non-CSULB testers |
| Data sources | Databricks (read-only) and CSV/Excel upload |
| Cloud | GCP, Docker on Cloud Run, GitLab CI/CD |
| Full target design | [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md). This pilot is a deliberate subset that grows into it without rewrites. |

## 1. What exists at the end of week 2

- **Sign in:** email-first. `@csulb.edu` goes to "Continue with Microsoft"; anyone else uses email + password.
- **Institution and roles:** CSULB institution with Owner, Admin, Analyst and Viewer.
  - Admins invite users; people with a `@csulb.edu` email can request to join.
  - In-app notifications for invites, join requests and approvals.
- **Data:**
  - Connect Databricks (CSULB's `admission_yields` tables, through a read-only service principal).
  - Or upload CSV/Excel.
  - Each load becomes a versioned snapshot.
- **Column mapping:** automatic. Rules plus value checks, with an optional Gemini assist for unclear columns.
- **Forecast in seconds:**
  - The lab recipe: XGBoost with v3 settings, isotonic calibration, cycle shrinkage, last-2-comparable-terms default, a backtest on the last closed term, and SHAP top factors.
  - Results: Applications, Admits, Enrolled (range), Yield %, by college, and an admit-level list.
- **Versioned models:** each forecast is a model version stored in Cloud Storage, with a "production" flag.
- **Exports and audit:** CSV, the yields file (`EMPLID|F|prob`) and the PDF report, with an audit log of every export.
- **Delivery:** deployed on Cloud Run (staging + production) by a GitLab pipeline with tests and security scans.
- **Compliance defaults:** race/ethnicity and FAFSA fields excluded from models; IDs pseudonymized; no names stored.

## 2. Pilot architecture (3 services + 1 job; same boundaries as the full design)

| Unit | Contains (modules that later split into services) | Cloud Run |
|---|---|---|
| `web` | Next.js app (App Router), the existing YieldPilot UI ported over; no database access, all data via `api` | 1 vCPU, min 0 |
| `api` | identity (Identity Platform tokens, institutions, roles, invites, join requests), notifications, datasets (CSV + Databricks pull, validation, PII block, profiling), mapping, forecasts, exports, audit | 2 vCPU, min 1 |
| `engine` | `yield-engine` package: train, backtest, score, explain | 8 vCPU / 16 GiB, concurrency 1, min 1 |
| `sync` job | Scheduled Databricks refresh | Cloud Run Job |

**Platform:**
- Cloud SQL Postgres (smallest production tier, backups + point-in-time recovery on)
- Cloud Storage (snapshots as Parquet, models, exports)
- Secret Manager (Databricks credentials)
- Identity Platform (Microsoft provider + email/password)
- Artifact Registry
- Vertex AI Gemini (optional mapping assist)

**Kept from the full design:**
- tenant id on every row, plus Postgres row-level security
- role check on every endpoint
- pseudonymized student IDs
- an append-only audit table
- service accounts per service
- GitLab authenticates to GCP without keys (Workload Identity Federation)

**Deferred to after the pilot:** BigQuery, Pub/Sub, OpenFGA, Firestore.

## 3. Hour-by-hour plan

| Day | Hours | Build | Done when |
|---|---|---|---|
| 1 | 1–4 | Terraform: `yp-staging` + `yp-prod` projects, APIs, Artifact Registry, Cloud SQL, bucket, Secret Manager, service accounts, Workload Identity Federation for GitLab. GitLab repo created. | `terraform apply` succeeds in staging |
| 2 | 5–8 | Monorepo scaffold (`apps/web` as a Next.js app, `services/api`, `services/engine`, `libs/yield-engine`), Dockerfiles, `.gitlab-ci.yml` (lint → test → SAST/secret scan → build → push → deploy staging) | Hello-world for all 3 services is deployed by CI |
| 3 | 9–12 | `yield-engine`: port the lab recipe (FYS + TRN configs), protected/FAFSA guards, unit tests, timing benchmark on the sample data | Train + score in ≤ 20 s; tests green |
| 4 | 13–16 | `yield-engine`: backtest on the last closed term, cycle shrinkage, range, SHAP factors; `engine` API (`/train`, `/score`, `/whatif`); models saved to GCS | Backtest reproduces the lab's Fall 2026 numbers on CSULB-shaped data |
| 5 | 17–20 | `api` identity: Identity Platform token check, Microsoft for `csulb.edu`, institutions, memberships, roles, invites, join requests, notifications, audit table, Alembic migrations, row-level security | Invite → accept → role-gated endpoint works in tests |
| 6 | 21–24 | `api` data: CSV/Excel upload (size/type checks, PII column block, ID pseudonymization) → Parquet snapshot + profile; Databricks connector (OAuth M2M, SQL Statement Execution API, read-only) → snapshot; `sync` job | Both sources produce the same snapshot format |
| 7 | 25–28 | Mapping (rules + value validators); forecast endpoints (create, status, results, admit list, what-if, versions, promote); exports (CSV, yields file) | End-to-end forecast via API in staging |
| 8 | 29–32 | Frontend: port the existing pages into Next.js routes (client components, mostly copy-over), email-first login → Microsoft / password, route protection, institution + users admin page, notification bell, generated API client | Login with a CSULB Microsoft account works in staging |
| 9 | 33–36 | Frontend: wire Steps 1–7 and Reports to the API (replace in-browser engine; keep it only as an instant preview); remove FAFSA lever and race from the UI | Full walk-through passes Playwright tests against staging |
| 10 | 37–40 | Hardening: security headers, rate limits, error pages, alerts, backups verified, runbook, privacy notice; deploy prod; CSULB smoke test | Production URL live with CSULB users |

**Buffer:** none. The Next.js port adds about 3–4 hours, absorbed by moving the Gemini mapping assist out of the pilot. If something else slips, cut in this order: what-if on the server → the `sync` schedule (manual refresh instead) → PDF export (keep CSV and yields file).

## 4. Not in the 2-week pilot (planned next)

Gemini chat with RAG; auto-generated KPIs and charts; file sharing with per-file permissions; email notifications; SCIM; deep tuning with Optuna jobs; full multi-term backtests; data tiers C/D; drift monitoring; nightly in-cycle status sync; post-waitlist model; other connectors; BigQuery; Cloud Armor + load balancer; per-tenant encryption keys; VPC Service Controls; SOC 2, HECVAT, pen test.

## 5. Start these now (they take calendar time, not build hours)

1. **Written CSULB approval** for this pilot: data-use agreement/DPA and an IT security review. Lab access was granted for research; a commercial product needs its own authorization.
2. **Microsoft sign-in:** register a multi-tenant app in Microsoft Entra. CSULB's Entra admin must grant consent (or add it as an enterprise app). Publisher verification may be required.
3. **Databricks:** a new read-only service principal for YieldPilot, with SELECT only on the needed tables. Don't reuse the lab's credentials.
4. **Accounts:** GCP billing account (+ organization if possible), GitLab group, and a domain for the app.
5. **Counsel:** a short review of the race/ethnicity and FAFSA decisions and the pilot terms.
