import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def _id() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Institution(Base):
    """A customer's shared workspace. Its profile (name, logo, website, location) is filled in from its website when created."""

    __tablename__ = "institutions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    name: Mapped[str] = mapped_column(String(200))
    # the verified email domain: set only from the email a creator or admin signed in with (never typed), so it can't be claimed
    domain: Mapped[str | None] = mapped_column(String(200), index=True)  # several workspaces may share one (e.g. departments)
    # how colleagues found by that domain or the website get in: domain (join at once) | request (an admin approves) | invite (only invited)
    join_policy: Mapped[str] = mapped_column(String(20), default="request", server_default="request")
    suspended: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # the workspace's own default model settings (changes from the lab's), set from the ML workspace; every prediction without its
    # own changes runs with them
    model_defaults: Mapped[dict | None] = mapped_column(JSON)
    model_defaults_by: Mapped[str | None] = mapped_column(String(32))
    model_defaults_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    website: Mapped[str | None] = mapped_column(String(300))
    logo: Mapped[str | None] = mapped_column(Text)  # a small PNG as a data: URL
    description: Mapped[str | None] = mapped_column(String(600))
    kind: Mapped[str | None] = mapped_column(String(40))  # university | college | school | organization
    country: Mapped[str | None] = mapped_column(String(80))
    region: Mapped[str | None] = mapped_column(String(120))
    join_code: Mapped[str | None] = mapped_column(String(32), unique=True, index=True)  # the invite link's code; rotatable
    join_code_enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    default_role: Mapped[str] = mapped_column(String(20), default="viewer", server_default="viewer")  # for people joining by link or request
    discoverable: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")  # findable by its website to request to join
    created_by: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    microsoft_oid: Mapped[str | None] = mapped_column(String(64), unique=True)
    name: Mapped[str | None] = mapped_column(String(200))
    title: Mapped[str | None] = mapped_column(String(200))
    department: Mapped[str | None] = mapped_column(String(200))
    photo: Mapped[str | None] = mapped_column(Text)  # small data: URL (Microsoft) or picture URL (Google)
    photo_custom: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")  # chosen by the person: sign-in doesn't replace it
    institution_id: Mapped[str | None] = mapped_column(ForeignKey("institutions.id"), index=True)  # None until they create or join one
    role: Mapped[str] = mapped_column(String(20))  # owner | admin | data_manager | analyst | viewer | guest
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # the account was deleted: its identity is gone and the row only keeps past runs attributed to a "Former member"
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Upload(Base):
    __tablename__ = "uploads"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    institution_id: Mapped[str] = mapped_column(ForeignKey("institutions.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    dataset_id: Mapped[str | None] = mapped_column(String(32))
    filename: Mapped[str] = mapped_column(String(300))
    object_key: Mapped[str] = mapped_column(String(600))
    size: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | processed | failed
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Dataset(Base):
    __tablename__ = "datasets"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    institution_id: Mapped[str] = mapped_column(ForeignKey("institutions.id"), index=True)
    name: Mapped[str] = mapped_column(String(300))
    latest_version: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class DatasetVersion(Base):
    __tablename__ = "dataset_versions"
    __table_args__ = (UniqueConstraint("dataset_id", "version"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    institution_id: Mapped[str] = mapped_column(ForeignKey("institutions.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    source_filename: Mapped[str] = mapped_column(String(300))
    data_key: Mapped[str] = mapped_column(String(600))  # pseudonymized Parquet
    idmap_key: Mapped[str | None] = mapped_column(String(600))  # token -> original ID, restricted
    id_column: Mapped[str | None] = mapped_column(String(300))
    rows: Mapped[int] = mapped_column(Integer)
    columns: Mapped[list] = mapped_column(JSON)
    dropped: Mapped[list] = mapped_column(JSON)
    profile: Mapped[list] = mapped_column(JSON)
    warnings: Mapped[list] = mapped_column(JSON)
    checksum: Mapped[str] = mapped_column(String(64))
    parent_version: Mapped[int | None] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(String(200))
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Project(Base):
    """One forecast workspace: the data, the choices made in each step, and the current forecast."""

    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    institution_id: Mapped[str] = mapped_column(ForeignKey("institutions.id"), index=True)
    name: Mapped[str] = mapped_column(String(200), default="New yield prediction")
    dataset_id: Mapped[str | None] = mapped_column(ForeignKey("datasets.id"))
    dataset_version: Mapped[int | None] = mapped_column(Integer)
    source: Mapped[dict] = mapped_column(JSON, default=dict)
    mapping: Mapped[dict] = mapped_column(JSON, default=dict)
    mapping_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    audit_score: Mapped[int | None] = mapped_column(Integer)
    audit_status: Mapped[str | None] = mapped_column(String(40))
    audit_reviewed: Mapped[bool] = mapped_column(Boolean, default=False)
    fixes_applied: Mapped[list] = mapped_column(JSON, default=list)
    setup: Mapped[dict] = mapped_column(JSON, default=dict)  # term, group, train_terms, custom_terms
    features: Mapped[dict] = mapped_column(JSON, default=dict)  # selected, ai, confirmed
    forecast_id: Mapped[str | None] = mapped_column(String(32))
    stale: Mapped[bool] = mapped_column(Boolean, default=False)
    results_seen: Mapped[bool] = mapped_column(Boolean, default=False)
    scenarios_seen: Mapped[bool] = mapped_column(Boolean, default=False)
    summary: Mapped[str | None] = mapped_column(Text)
    model_params: Mapped[dict | None] = mapped_column(JSON)  # the ML workspace's hyperparameter changes (None: the recipe's own)
    model_params_by: Mapped[str | None] = mapped_column(String(32))
    model_params_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    audit_plan: Mapped[dict | None] = mapped_column(JSON)  # the AI review of the current data version: issues and proposed fixes
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    updated_by: Mapped[str | None] = mapped_column(String(32))  # the last person who changed it (studies are shared by the institution)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class Forecast(Base):
    __tablename__ = "forecasts"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    institution_id: Mapped[str] = mapped_column(ForeignKey("institutions.id"), index=True)
    dataset_version_id: Mapped[str] = mapped_column(ForeignKey("dataset_versions.id"))
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id"), index=True)
    spec: Mapped[dict] = mapped_column(JSON)
    spec_hash: Mapped[str] = mapped_column(String(64), index=True)
    summary: Mapped[dict] = mapped_column(JSON)
    model_key: Mapped[str] = mapped_column(String(600))
    predictions_key: Mapped[str] = mapped_column(String(600))
    is_production: Mapped[bool] = mapped_column(Boolean, default=False)
    registry: Mapped[dict | None] = mapped_column(JSON)  # Vertex AI Model Registry entry, once official
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    institution_id: Mapped[str | None] = mapped_column(String(32), index=True)  # None: an operator acted on someone with no institution
    user_id: Mapped[str] = mapped_column(String(32))
    action: Mapped[str] = mapped_column(String(80))
    target: Mapped[str] = mapped_column(String(200))
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Share(Base):
    __tablename__ = "shares"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    institution_id: Mapped[str] = mapped_column(ForeignKey("institutions.id"), index=True)
    forecast_id: Mapped[str] = mapped_column(ForeignKey("forecasts.id"), index=True)
    sender_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    recipients: Mapped[list] = mapped_column(JSON)
    files: Mapped[list] = mapped_column(JSON)
    message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Notification(Base):
    """In-app notifications, addressed by email so people get them even before their first sign-in."""

    __tablename__ = "notifications"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    institution_id: Mapped[str] = mapped_column(ForeignKey("institutions.id"), index=True)
    recipient_email: Mapped[str] = mapped_column(String(320), index=True)
    kind: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str | None] = mapped_column(Text)
    link: Mapped[str | None] = mapped_column(String(300))
    read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Invitation(Base):
    """Someone outside the institution's email domain, invited in (as a viewer by default) when a report is shared with them."""

    __tablename__ = "invitations"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    institution_id: Mapped[str] = mapped_column(ForeignKey("institutions.id"), index=True)
    email: Mapped[str] = mapped_column(String(320), index=True)
    role: Mapped[str] = mapped_column(String(20), default="viewer")
    invited_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Connection(Base):
    """A read-only connection to an institution's warehouse. Credentials are encrypted at rest."""

    __tablename__ = "connections"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    institution_id: Mapped[str] = mapped_column(ForeignKey("institutions.id"), index=True)
    kind: Mapped[str] = mapped_column(String(40))  # see services/connectors.CATALOG
    name: Mapped[str] = mapped_column(String(200))
    config: Mapped[dict] = mapped_column(JSON)  # non-secret settings (host, warehouse)
    secret: Mapped[bytes] = mapped_column(LargeBinary)  # Fernet-encrypted credentials
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class LoginSession(Base):
    """One signed-in browser. The session cookie names it, so signing out (or being removed) ends it on the server too."""

    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    method: Mapped[str] = mapped_column(String(20))  # google | microsoft | email | sso | dev
    ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(300))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Plan(Base):
    """Basic, Premium, Enterprise: prices and limits live here, so they change without a release."""

    __tablename__ = "plans"
    key: Mapped[str] = mapped_column(String(20), primary_key=True)
    name: Mapped[str] = mapped_column(String(60))
    sort: Mapped[int] = mapped_column(Integer, default=0)
    price_month_cents: Mapped[int | None] = mapped_column(Integer)  # None: quoted (Enterprise)
    price_year_cents: Mapped[int | None] = mapped_column(Integer)
    limits: Mapped[dict] = mapped_column(JSON, default=dict)  # seats, runs_per_user, runs_per_institution, ... (None = unlimited)
    features: Mapped[list] = mapped_column(JSON, default=list)
    stripe_price_month: Mapped[str | None] = mapped_column(String(100))
    stripe_price_year: Mapped[str | None] = mapped_column(String(100))


class Subscription(Base):
    __tablename__ = "subscriptions"
    institution_id: Mapped[str] = mapped_column(ForeignKey("institutions.id"), primary_key=True)
    plan_key: Mapped[str | None] = mapped_column(ForeignKey("plans.key"))
    status: Mapped[str] = mapped_column(String(20), default="full_access")  # full_access | trialing | active | past_due | canceled
    interval: Mapped[str | None] = mapped_column(String(10))  # month | year
    seats: Mapped[int | None] = mapped_column(Integer)
    current_period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    custom_limits: Mapped[dict] = mapped_column(JSON, default=dict)
    stripe_customer_id: Mapped[str | None] = mapped_column(String(100), index=True)
    stripe_subscription_id: Mapped[str | None] = mapped_column(String(100), index=True)
    cancel_at_period_end: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")  # still paid for, not renewing
    test_mode: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")  # bought with Stripe's test keys: no real money
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class Payment(Base):
    """An invoice, mirrored from Stripe by its webhook."""

    __tablename__ = "payments"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    institution_id: Mapped[str] = mapped_column(ForeignKey("institutions.id"), index=True)
    stripe_invoice_id: Mapped[str] = mapped_column(String(100), unique=True)
    amount_cents: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(20))  # paid | open | failed | void
    description: Mapped[str | None] = mapped_column(String(300))
    hosted_url: Mapped[str | None] = mapped_column(String(600))
    pdf_url: Mapped[str | None] = mapped_column(String(600))
    test_mode: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")  # never counted as revenue
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class RunLog(Base):
    """Every press of Run and how it ended: counts runs against plans and feeds the dashboards."""

    __tablename__ = "run_log"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    institution_id: Mapped[str] = mapped_column(ForeignKey("institutions.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    project_id: Mapped[str | None] = mapped_column(String(32))
    forecast_id: Mapped[str | None] = mapped_column(String(32))
    outcome: Mapped[str] = mapped_column(String(20))  # done | cancelled | failed
    seconds: Mapped[float | None] = mapped_column()
    vcpu: Mapped[int] = mapped_column(Integer, default=8, server_default="8")  # the machine it ran on, for its cost
    memory_gib: Mapped[int] = mapped_column(Integer, default=8, server_default="8")
    error: Mapped[str | None] = mapped_column(String(300))  # why a failed run failed
    kind: Mapped[str] = mapped_column(String(20), default="forecast", server_default="forecast")  # forecast | tuning (a settings test)
    cpu_seconds: Mapped[float | None] = mapped_column()  # CPU time the training really used (all cores), measured in the trainer
    peak_memory_mb: Mapped[float | None] = mapped_column()  # the trainer's highest memory during the run
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)


class LoginCode(Base):
    """A one-time sign-in email: a 6-digit code and a link token, both stored only as keyed hashes, 15 minutes, used once."""

    __tablename__ = "login_codes"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    email: Mapped[str] = mapped_column(String(320), index=True)
    code_hash: Mapped[str] = mapped_column(String(64))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    ip: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class JoinRequest(Base):
    """Someone asking to join an institution they found by its website or their email domain; an admin approves or declines."""

    __tablename__ = "join_requests"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    institution_id: Mapped[str] = mapped_column(ForeignKey("institutions.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    message: Mapped[str | None] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | approved | declined | cancelled
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    decided_by: Mapped[str | None] = mapped_column(String(32))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class UsageEvent(Base):
    """Metered work other than forecast runs: each AI call (with its tokens) and each data import (with its processing time)."""

    __tablename__ = "usage_events"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    institution_id: Mapped[str] = mapped_column(String(32), index=True)
    user_id: Mapped[str] = mapped_column(String(32), index=True)
    kind: Mapped[str] = mapped_column(String(20))  # ai | import
    purpose: Mapped[str] = mapped_column(String(40))  # what it was for: question, column_matching, file_upload, ...
    model: Mapped[str | None] = mapped_column(String(60))
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    seconds: Mapped[float | None] = mapped_column()
    rows: Mapped[int | None] = mapped_column(Integer)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)


class MlAccess(Base):
    """Someone an admin or owner let into the ML workspace (admins and owners always have it). It counts only in that institution."""

    __tablename__ = "ml_access"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    institution_id: Mapped[str] = mapped_column(ForeignKey("institutions.id"), index=True)
    granted_by: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class TuningRun(Base):
    """One test of model settings in the ML workspace, or a set of AI suggestions waiting to be tested, kept with its results."""

    __tablename__ = "tuning_runs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    institution_id: Mapped[str] = mapped_column(String(32), index=True)
    project_id: Mapped[str] = mapped_column(String(32), index=True)
    user_id: Mapped[str] = mapped_column(String(32))
    mode: Mapped[str] = mapped_column(String(20))  # recommended | default | expert
    status: Mapped[str] = mapped_column(String(20))  # suggested | running | stopping | done | failed | cancelled
    progress: Mapped[dict | None] = mapped_column(JSON)  # {pct, label, detail, at}: written every few seconds while it runs, so any page can follow it
    config: Mapped[dict | None] = mapped_column(JSON)  # {objective, trials, space, rounds, base}: what the test optimized and how it searched
    candidates: Mapped[list] = mapped_column(JSON, default=list)  # [{name, why, params, source}]
    results: Mapped[list | None] = mapped_column(JSON)  # one per candidate: scores on the held-out term, ROC curve, time
    best_index: Mapped[int | None] = mapped_column(Integer)
    holdout: Mapped[dict | None] = mapped_column(JSON)  # {target, train}: the past term it was scored on, and what it learned from
    error: Mapped[str | None] = mapped_column(String(300))
    seconds: Mapped[float | None] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Membership(Base):
    """A person's place in one workspace: their role there, whether they can use it, ML workspace access and their own monthly runs.
    A person can belong to several workspaces; User.institution_id and User.role are the one they're working in now."""

    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("user_id", "institution_id"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    institution_id: Mapped[str] = mapped_column(ForeignKey("institutions.id"), index=True)
    role: Mapped[str] = mapped_column(String(20), default="viewer")
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    ml_access: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")  # given by an admin (admins and owners always have it)
    ml_granted_by: Mapped[str | None] = mapped_column(String(32))
    runs_allowance: Mapped[int | None] = mapped_column(Integer)  # monthly runs the owner set (None: the plan's per-person number)
    runs_set_by: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RunAllowance(Base):
    """A person's monthly forecast runs, set by their institution's owner in place of the plan's per-person number. Counts only there."""

    __tablename__ = "run_allowances"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    institution_id: Mapped[str] = mapped_column(ForeignKey("institutions.id"), index=True)
    runs: Mapped[int] = mapped_column(Integer)
    set_by: Mapped[str] = mapped_column(String(32))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class OperatorAccess(Base):
    """Someone a main operator (OPERATOR_EMAILS) has let into the operator dashboard. By email, so it can be given before their first sign-in."""

    __tablename__ = "operator_access"
    email: Mapped[str] = mapped_column(String(320), primary_key=True)
    added_by: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
