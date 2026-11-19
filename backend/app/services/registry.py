"""Vertex AI Model Registry: every official forecast's model is registered as a new version.

One registry model per institution and population (for example yp-1a2b3c4d5e6f-ftf); each official forecast adds a
version that points at its artifact in Cloud Storage and carries its term, data version and accuracy as labels.
Serving stays in yp-backend, which keeps what-if scenarios and explanations instant.
"""

import google.auth
import google.auth.transport.requests
import httpx

from ..config import settings

IMAGE = "us-docker.pkg.dev/vertex-ai/prediction/sklearn-cpu.1-5:latest"  # describes the artifact; nothing is deployed


def _token() -> str:
    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def _label(v) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in str(v).lower())[:63]


def register(*, institution_id: str, institution: str, group: str | None, forecast_id: str, model_key: str, summary: dict,
             data_version: str) -> dict:
    s = settings()
    base = f"https://{s.vertex_location}-aiplatform.googleapis.com/v1/projects/{s.gcp_project}/locations/{s.vertex_location}"
    model_id = f"yp-{institution_id[:12]}-{(group or 'all').lower()}"
    bt = summary.get("backtest") or {}
    body = {
        "model": {
            "displayName": f"YieldPilot · {institution} · {group or 'All admits'}",
            "description": f"Admit-to-enroll yield model (recipe {summary.get('recipe')}), {summary.get('model')}.",
            "versionDescription": (f"{summary['target_term']} forecast {forecast_id}: {summary['expected']:.0f} projected enrolled of "
                                   f"{summary['admits']} admits; backtest error {bt.get('error_pct', 'n/a')}%, AUC {bt.get('auc', 'n/a')}."),
            "artifactUri": f"gs://{s.gcs_bucket}/{model_key.rsplit('/', 1)[0]}",
            "containerSpec": {"imageUri": IMAGE},
            "labels": {"app": "yieldpilot", "institution": _label(institution_id[:12]), "population": _label(group or "all"),
                       "term": _label(summary["target_term"]), "forecast": _label(forecast_id), "data-version": _label(data_version),
                       "recipe": _label(summary.get("recipe", ""))},
        },
    }
    with httpx.Client(timeout=60, headers={"Authorization": f"Bearer {_token()}"}) as c:
        exists = c.get(f"{base}/models/{model_id}").status_code == 200
        body.update({"parentModel": f"projects/{s.gcp_project}/locations/{s.vertex_location}/models/{model_id}"} if exists else {"modelId": model_id})
        r = c.post(f"{base}/models:upload", json=body)
        if r.status_code != 200:
            raise RuntimeError(r.json().get("error", {}).get("message", r.text)[:300])
        op = r.json()
    name = f"projects/{s.gcp_project}/locations/{s.vertex_location}/models/{model_id}"
    console = f"https://console.cloud.google.com/vertex-ai/models/locations/{s.vertex_location}/models/{model_id}?project={s.gcp_project}"
    return {"model": name, "operation": op["name"], "version": None, "pending": True, "console": console}


def unregister(entry: dict) -> None:
    """Remove a deleted report's model version from Vertex AI (the whole model if it was the only version). Best effort."""
    s = settings()
    name, version = entry.get("model"), entry.get("version")
    if not name:
        return
    base = f"https://{s.vertex_location}-aiplatform.googleapis.com/v1/{name}"
    with httpx.Client(timeout=60, headers={"Authorization": f"Bearer {_token()}"}) as c:
        if version and c.delete(f"{base}@{version}").status_code == 200:
            return
        c.delete(base)  # the only (default) version: delete the model itself


def refresh(entry: dict) -> dict:
    """Vertex AI takes a few minutes to register a model; check the upload and record the version once it lands."""
    if not entry.get("pending") or not entry.get("operation"):
        return entry
    s = settings()
    op = httpx.get(f"https://{s.vertex_location}-aiplatform.googleapis.com/v1/{entry['operation']}",
                   headers={"Authorization": f"Bearer {_token()}"}, timeout=30).json()
    if not op.get("done"):
        return entry
    if op.get("error"):
        return {**entry, "pending": False, "error": op["error"].get("message", "Registration failed.")}
    version = op.get("response", {}).get("modelVersionId")
    return {**entry, "pending": False, "version": version, "console": entry["console"].replace("?project", f"/versions/{version}?project") if version else entry["console"]}
