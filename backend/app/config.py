import re
from functools import lru_cache
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: Literal["local", "staging", "prod"] = "local"
    # Always the production Cloud SQL database and Cloud Storage bucket, also when the API runs on a laptop
    # (through the Cloud SQL proxy on 127.0.0.1:5433: scripts/dev.sh starts it).
    database_url: str = ""
    gcs_bucket: str = ""
    gcp_project: str = ""

    # "dev" trusts an X-Dev-User header and is refused outside local.
    auth_mode: Literal["dev", "microsoft"] = "dev"
    frontend_origin: str = "http://localhost:5174"
    jwt_secret: str = "local-dev-only"
    session_hours: int = 8
    microsoft_client_id: str = ""
    microsoft_client_secret: str = ""
    microsoft_tenant_id: str = "organizations"  # work and school accounts of any organization
    # personal Microsoft accounts (Outlook, Hotmail, Live): only once the app registration's supported account types include
    # them; until then those addresses sign in with the email link
    microsoft_personal_accounts: bool = False
    # the Microsoft directories (tenant IDs, comma-separated) the app registration accepts; empty = any organization. Until the
    # registration is multi-tenant, people from other organizations sign in with an email code instead of hitting Microsoft's error
    microsoft_tenants: str = ""

    def microsoft_tenant_ok(self, tenant: str | None) -> bool:
        allowed = {t.strip().lower() for t in self.microsoft_tenants.split(",") if t.strip()}
        return not allowed or (tenant or "").lower() in allowed
    google_client_id: str = ""
    google_client_secret: str = ""
    allowed_domains: str = "*"  # comma-separated, or * for any institution
    pseudonym_key: str = "local-dev-only"
    max_upload_mb: int = 500
    connection_key: str = ""  # Fernet key for warehouse credentials
    identity_api_key: str = ""  # optional: Identity Platform web key for email links; without it the service account is used
    operator_emails: str = ""  # main operators, separated by ";" or ","; listed in this order
    enforce_plans: bool = True  # plan limits apply; only a workspace an operator set to full access has none
    run_vcpu: int = 8  # the API's machine size on Cloud Run, for working out what its work costs
    run_memory_gib: int = 8
    stripe_secret_key: str = ""  # read from Secret Manager (yp-stripe-secret-key) when not set here
    stripe_webhook_secret: str = ""  # yp-stripe-webhook-secret
    gemini_model: str = "gemini-3.7-flash"
    gemini_fallbacks: str = "gemini-3.6-flash,gemini-3.5-flash"  # tried in order if a model is retired or slow
    gemini_fast_model: str = "gemini-3.5-flash-lite"  # quick structured tasks (column matching); the models above back it up
    gemini_location: str = "global"  # current Gemini models are served from the global endpoint
    vertex_location: str = "us-central1"  # Model Registry

    @property
    def microsoft_redirect_uri(self) -> str:
        return f"{self.frontend_origin.rstrip('/')}/api/auth/microsoft/callback"

    @property
    def google_redirect_uri(self) -> str:
        return f"{self.frontend_origin.rstrip('/')}/api/auth/google/callback"

    def operators(self) -> list[str]:
        return [e.lower() for e in re.split(r"[,;\s]+", self.operator_emails) if e]

    def is_operator(self, email: str) -> bool:
        return email.strip().lower() in self.operators()

    def domain_allowed(self, domain: str) -> bool:
        allowed = {d.strip().lower() for d in self.allowed_domains.split(",") if d.strip()}
        return "*" in allowed or domain.lower() in allowed

    @model_validator(mode="after")
    def production_guards(self):
        if not self.database_url.startswith("postgresql"):
            raise ValueError("DATABASE_URL must point at Cloud SQL (run scripts/use_cloud.sh, then scripts/dev.sh)")
        if not self.gcs_bucket:
            raise ValueError("GCS_BUCKET must name the Cloud Storage bucket")
        if self.env != "local":
            if self.auth_mode != "microsoft":
                raise ValueError("AUTH_MODE must be microsoft outside local")
            if len(self.jwt_secret) < 32:
                raise ValueError("JWT_SECRET must be a strong secret outside local")
            if self.pseudonym_key == "local-dev-only" or len(self.pseudonym_key) < 32:
                raise ValueError("PSEUDONYM_KEY must be a strong secret outside local")
        return self


@lru_cache
def settings() -> Settings:
    return Settings()
