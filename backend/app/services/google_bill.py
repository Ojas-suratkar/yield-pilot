"""What Google actually charged and measured.

- The bill: read straight from the Cloud Billing export in BigQuery (costs by service, by server or database, by SKU and by day,
  after credits). Nothing is typed in or uploaded by hand.
- Each run's actual cost: the Detailed export charges the forecast server hour by hour, so a run's cost is its share of what
  Google charged for the server's busy time in the hours it ran (services/costs.py).
- The meters: Cloud Monitoring's own count of each Cloud Run service's billed instance time and requests."""

import logging
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone

from google.api_core import exceptions as gexc
from google.cloud import bigquery

from ..config import settings

log = logging.getLogger(__name__)
DATASET = "billing_export"
PREFIX = "gcp_billing_export_v1_"  # Standard usage cost
DETAILED = "gcp_billing_export_resource_v1_"  # Detailed usage cost: the same charges, each with the server, database or bucket it was for
KEEP = 1800  # the export itself only updates a few times a day
MONITORING = "https://monitoring.googleapis.com/v3/projects/{}/timeSeries"
BACKEND = os.environ.get("K_SERVICE", "yp-backend")  # the Cloud Run service that runs forecasts
LAG_HOURS = 2  # the newest hours in the export can still be filling in
# what each of the project's resources is, in plain words
RESOURCES = [
    (re.compile(r"yp-backend"), "API and forecasts", "Cloud Run service yp-backend"),
    (re.compile(r"yp-frontend"), "Website", "Cloud Run service yp-frontend"),
    (re.compile(r"yieldpilot-db"), "Database", "Cloud SQL yieldpilot-db"),
    (re.compile(r"yp-demo-source"), "Demo source database", "Cloud SQL yp-demo-source"),
    (re.compile(r"yp-gitlab-runner"), "Update server", "Compute Engine yp-gitlab-runner"),
    (re.compile(r"yp-bench"), "Speed tests", "Cloud Run job yp-bench"),
    (re.compile(r"yieldpilot-csulb-data"), "Stored files", "Cloud Storage yieldpilot-csulb-data"),
    (re.compile(r"backup"), "Database backups", "Cloud SQL backups"),
    (re.compile(r"-rule-|forwardingRules"), "Database connection", "Cloud SQL private connection"),
]
NET = "SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0))"
_cache: dict[tuple[str, int], tuple[float, dict]] = {}
_lock = threading.Lock()


def _cached(kind: str, days: int, read) -> dict:
    with _lock:
        hit = _cache.get((kind, days))
        if hit and time.monotonic() - hit[0] < KEEP:
            return hit[1]
    out = read(days)
    with _lock:
        _cache[(kind, days)] = (time.monotonic(), out)
    return out


def _top(d: dict[str, float]) -> list[dict]:
    return [{"name": k, "cost": round(v, 4)} for k, v in sorted(d.items(), key=lambda x: -x[1]) if round(v, 4)]


def _what(service: str, name: str | None, global_name: str | None) -> tuple[str, str]:
    """A resource's plain name and its technical one."""
    text = f"{name or ''} {global_name or ''}"
    for pattern, label, tech in RESOURCES:
        if pattern.search(text):
            return label, tech
    if service == "Vertex AI":
        return "AI (Gemini)", "Vertex AI"
    return service, service + (f" {name}" if name else "")


def _table(client: bigquery.Client, project: str) -> tuple[str | None, str | None]:
    """(the table to read, or None, and the reason it can't be read)."""
    try:
        names = [t.table_id for t in client.list_tables(f"{project}.{DATASET}")]
    except gexc.NotFound:
        return None, "setup"
    except gexc.Forbidden:
        return None, "access"
    best = [n for n in names if n.startswith(DETAILED)] or [n for n in names if n.startswith(PREFIX)]
    return (f"{project}.{DATASET}.{best[0]}", None) if best else (None, "export_off")


def _params(project: str, since: datetime) -> bigquery.QueryJobConfig:
    return bigquery.QueryJobConfig(query_parameters=[bigquery.ScalarQueryParameter("project", "STRING", project),
                                                     bigquery.ScalarQueryParameter("since", "TIMESTAMP", since)])


def _bill(days: int) -> dict:
    project = settings().gcp_project
    client = bigquery.Client(project=project)
    table, reason = _table(client, project)
    if table is None:
        return {"connected": False, "reason": reason}
    detailed = DETAILED in table
    since = datetime.now(timezone.utc) - timedelta(days=days)
    resource = "resource.name, resource.global_name" if detailed else "CAST(NULL AS STRING) AS name, CAST(NULL AS STRING) AS global_name"
    sql = f"""
        SELECT FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time)) AS day, service.description AS service, sku.description AS sku, {resource},
               ANY_VALUE(currency) AS currency, SUM(cost) AS gross, {NET} AS net, MAX(export_time) AS latest, MIN(usage_start_time) AS first
        FROM `{table}`
        WHERE project.id = @project AND usage_start_time >= @since
        GROUP BY day, service, sku, name, global_name"""
    rows = list(client.query(sql, job_config=_params(project, since)).result(timeout=60))
    services: dict[str, float] = {}
    skus: dict[str, float] = {}
    per_day: dict[str, float] = {}
    things: dict[str, dict] = {}
    for r in rows:
        net = float(r["net"])
        services[r["service"]] = services.get(r["service"], 0.0) + net
        skus[f"{r['service']} · {r['sku']}"] = skus.get(f"{r['service']} · {r['sku']}", 0.0) + net
        per_day[r["day"]] = per_day.get(r["day"], 0.0) + net
        label, tech = _what(r["service"], r["name"], r["global_name"])
        t = things.setdefault(label, {"name": label, "detail": tech, "cost": 0.0, "kept_ready": 0.0})
        t["cost"] += net
        if "Min Instance" in r["sku"]:  # Cloud Run keeping a server ready, whether or not anyone is using it
            t["kept_ready"] += net
    gross = sum(float(r["gross"]) for r in rows)
    total = sum(services.values())
    return {
        "connected": True, "source": "export", "detailed": detailed, "total": round(total, 2), "gross": round(gross, 2),
        "credits": round(total - gross, 2), "currency": rows[0]["currency"] if rows else "USD",
        "as_of": max(r["latest"] for r in rows).isoformat() if rows else None,
        "first_day": min(r["first"] for r in rows).date().isoformat() if rows else None,
        "by_service": _top(services), "by_sku": _top(skus)[:15],
        "by_resource": sorted(({**t, "cost": round(t["cost"], 4), "kept_ready": round(t["kept_ready"], 4)} for t in things.values() if round(t["cost"], 4)),
                              key=lambda x: -x["cost"]),
        "by_day": [{"day": k, "cost": round(v, 4)} for k, v in sorted(per_day.items())],
    }


def actual(days: int) -> dict:
    """Google's bill for the last `days` days, from the billing export, or {"connected": False, "reason": ...} saying which setup
    step is missing."""
    def read(d: int) -> dict:
        try:
            return _bill(d)
        except Exception as e:  # BigQuery unavailable: the dashboard says so and keeps its own figures
            log.warning("Couldn't read the billing export: %s", type(e).__name__)
            return {"connected": False, "reason": "error"}
    return _cached("bill", days, read)


def _hours(days: int) -> dict:
    """What Google charged for the forecast server while it was busy, hour by hour: a run's actual cost is its share of the hour
    it ran in. (Keeping a server ready is charged separately and isn't any one run's.)"""
    project = settings().gcp_project
    client = bigquery.Client(project=project)
    table, reason = _table(client, project)
    if table is None or DETAILED not in table:
        return {"connected": False, "reason": reason or "standard_only"}
    sql = f"""
        SELECT TIMESTAMP_TRUNC(usage_start_time, HOUR) AS hour, sku.description AS sku, {NET} AS net, SUM(usage.amount) AS amount
        FROM `{table}`
        WHERE project.id = @project AND usage_start_time >= @since AND resource.name = @service
        GROUP BY hour, sku"""
    since = datetime.now(timezone.utc) - timedelta(days=days + 1)
    config = _params(project, since)
    config.query_parameters = [*config.query_parameters, bigquery.ScalarQueryParameter("service", "STRING", BACKEND)]
    busy: dict[str, list[float]] = {}  # hour -> [net cost, busy vCPU-seconds]
    latest = None
    for r in client.query(sql, job_config=config).result(timeout=60):
        latest = max(latest or r["hour"], r["hour"])
        sku = r["sku"]
        if "Min Instance" in sku or not ("CPU" in sku or "Memory" in sku):
            continue
        h = busy.setdefault(r["hour"].isoformat(), [0.0, 0.0])
        h[0] += float(r["net"])
        if "CPU" in sku:
            h[1] += float(r["amount"] or 0)
    until = (latest - timedelta(hours=LAG_HOURS)) if latest else None
    return {"connected": True, "until": until.isoformat() if until else None,
            "hours": {k: {"cost": v[0], "vcpu_seconds": v[1]} for k, v in busy.items()}}


def hours(days: int) -> dict:
    def read(d: int) -> dict:
        try:
            return _hours(d)
        except Exception as e:
            log.warning("Couldn't read the hourly bill: %s", type(e).__name__)
            return {"connected": False, "reason": "error"}
    return _cached("hours", days, read)


def _meters(days: int) -> dict:
    import google.auth
    from google.auth.transport.requests import AuthorizedSession

    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/monitoring.read"])
    http, project = AuthorizedSession(creds), settings().gcp_project
    end = datetime.now(timezone.utc)
    stamp = lambda t: t.strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731

    def per_service(metric: str) -> dict[str, float]:
        out: dict[str, float] = {}
        token = None
        while True:
            params = {"filter": f'metric.type="{metric}" AND resource.type="cloud_run_revision"',
                      "interval.startTime": stamp(end - timedelta(days=days)), "interval.endTime": stamp(end),
                      "aggregation.alignmentPeriod": "86400s", "aggregation.perSeriesAligner": "ALIGN_SUM",
                      "aggregation.crossSeriesReducer": "REDUCE_SUM", "aggregation.groupByFields": "resource.label.service_name"}
            if token:
                params["pageToken"] = token
            r = http.get(MONITORING.format(project), params=params, timeout=20)
            if r.status_code == 403:
                raise PermissionError
            r.raise_for_status()
            body = r.json()
            for ts in body.get("timeSeries", []):
                name = ts["resource"]["labels"].get("service_name", "unknown")
                out[name] = out.get(name, 0.0) + sum(float(p["value"].get("doubleValue") or p["value"].get("int64Value") or 0)
                                                     for p in ts.get("points", []))
            token = body.get("nextPageToken")
            if not token:
                return out

    billed = per_service("run.googleapis.com/container/billable_instance_time")
    requests = per_service("run.googleapis.com/request_count")
    return {"available": True, "services": [{"service": s, "billed_hours": round(billed.get(s, 0.0) / 3600, 2), "requests": int(requests.get(s, 0))}
                                            for s in sorted(set(billed) | set(requests))]}


def meters(days: int) -> dict:
    """Google's own meters for each Cloud Run service over the last `days` days."""
    def read(d: int) -> dict:
        try:
            return _meters(d)
        except PermissionError:
            return {"available": False, "reason": "access"}
        except Exception as e:
            log.warning("Couldn't read Cloud Monitoring: %s", type(e).__name__)
            return {"available": False, "reason": "error"}
    return _cached("meters", days, read)
