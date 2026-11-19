"""Read-only connectors to the systems admissions data lives in.

Each connector pulls a table, query or file once; the result is cleaned, pseudonymized and stored as a dataset
version like an upload, so forecasts never depend on the source staying online. Credentials are Fernet-encrypted.
"""

import datetime as dt
import decimal
import io
import json
import os
import re
import threading
import tempfile
import time

import httpx
import pandas as pd
from cryptography.fernet import Fernet

from ..config import settings

MAX_ROWS = 2_000_000
TABLE = re.compile(r'^[A-Za-z0-9_$`"\[\] -]+(\.[A-Za-z0-9_$`"\[\] -]+){0,2}$')
SELECT = re.compile(r"^\s*(select|with)\b", re.I)


# ------------------------------------------------------------------------------------------- catalog

def _f(key, label, placeholder="", secret=False, optional=False, kind="text", hint=""):
    """A field. Required unless `optional`; optional fields are tucked under "More options" in the form."""
    return {"key": key, "label": label, "placeholder": placeholder, "secret": secret, "optional": optional, "type": kind, "hint": hint}


def _m(key, label, fields, hint=""):
    """One way to sign in to a system (an access token, a service principal, a password, a key): its fields are all required."""
    return {"key": key, "label": label, "hint": hint, "fields": fields}


PORT = _f("port", "Port", "Default port", optional=True)
USER, PASSWORD = _f("user", "Username", "yieldpilot_reader"), _f("password", "Password", secret=True)

CATALOG = [
    {"kind": "databricks", "name": "Databricks", "group": "Data warehouse", "mono": "DB", "color": "#ff3621", "source": "sql",
     "blurb": "SQL warehouse via the Statement Execution API.",
     "help": "Use the workspace address from your browser and one way to sign in. YieldPilot lists only the tables that sign-in can read, "
             "and finds a SQL warehouse automatically.",
     "fields": [_f("host", "Workspace URL", "adb-1234567890.12.azuredatabricks.net"),
                _f("http_path", "SQL warehouse HTTP path", "/sql/1.0/warehouses/…", optional=True,
                   hint="Only to pin one warehouse. Otherwise a running one is used, or a serverless one is started.")],
     "auth": [_m("pat", "Personal access token", [_f("token", "Personal access token", "dapi…", secret=True)],
                 "Settings → Developer → Access tokens. The token reads what its user can read."),
              _m("sp", "Service principal (OAuth)", [_f("client_id", "Client ID", "00000000-0000-0000-0000-000000000000"),
                                                     _f("client_secret", "Client secret", secret=True)],
                 "Recommended for a shared connection: grant it USE CATALOG, USE SCHEMA and SELECT on the admissions tables only.")]},
    {"kind": "snowflake", "name": "Snowflake", "group": "Data warehouse", "mono": "SF", "color": "#29b5e8", "source": "sql",
     "blurb": "Any Snowflake account and warehouse.",
     "fields": [_f("account", "Account identifier", "orgname-accountname"), USER, _f("warehouse", "Warehouse", "COMPUTE_WH"),
                _f("database", "Database", "ADMISSIONS"), _f("schema", "Schema", "PUBLIC", optional=True), _f("role", "Role", "YIELDPILOT_READER", optional=True)],
     "auth": [_m("password", "Password", [_f("password", "Password", secret=True)]),
              _m("keypair", "Key pair", [_f("private_key", "Private key (PEM)", secret=True, kind="textarea")], "The user's RSA key, unencrypted PEM.")]},
    {"kind": "bigquery", "name": "Google BigQuery", "group": "Data warehouse", "mono": "BQ", "color": "#4285f4", "source": "sql",
     "blurb": "Query BigQuery with a read-only service account.",
     "fields": [_f("project", "Billing project ID", "my-project"), _f("credentials", "Service account key (JSON)", secret=True, kind="textarea"),
                _f("location", "Location", "US", optional=True)]},
    {"kind": "sqlserver", "name": "Microsoft SQL Server", "group": "Database", "mono": "MS", "color": "#cc2927", "source": "sql",
     "blurb": "SQL Server or Azure SQL (Colleague, PeopleSoft and reporting databases).",
     "fields": [_f("host", "Server", "sql.university.edu"), _f("database", "Database", "ODS"), USER, PASSWORD, PORT]},
    {"kind": "oracle", "name": "Oracle", "group": "Database", "mono": "OR", "color": "#c74634", "source": "sql",
     "blurb": "Oracle databases behind Banner and PeopleSoft.",
     "fields": [_f("host", "Host", "oracle.university.edu"), _f("service", "Service name", "PROD"), USER, PASSWORD, PORT]},
    {"kind": "postgres", "name": "PostgreSQL", "group": "Database", "mono": "PG", "color": "#336791", "source": "sql",
     "blurb": "PostgreSQL, including Cloud SQL, RDS and Azure.",
     "fields": [_f("host", "Host", "db.university.edu"), _f("database", "Database", "admissions"), USER, PASSWORD, PORT]},
    {"kind": "mysql", "name": "MySQL", "group": "Database", "mono": "MY", "color": "#00758f", "source": "sql",
     "blurb": "MySQL and MariaDB.", "fields": [_f("host", "Host", "db.university.edu"), _f("database", "Database", "admissions"), USER, PASSWORD, PORT]},
    {"kind": "slate", "name": "Slate", "group": "Admissions CRM", "mono": "SL", "color": "#0b6e4f", "source": "none",
     "blurb": "A Slate query published as a web service (JSON or CSV).",
     "fields": [_f("url", "Web service URL", "https://apply.university.edu/manage/query/run?id=…&cmd=service&output=json")],
     "auth": [_m("basic", "Service account", [_f("user", "Username"), _f("password", "Password", secret=True)],
                 "The Slate user the web service runs as."),
              _m("url", "Key in the URL", [], "The web service URL already carries its access key.")]},
    {"kind": "salesforce", "name": "Salesforce", "group": "Admissions CRM", "mono": "SF", "color": "#00a1e0", "source": "soql",
     "blurb": "Education Cloud, TargetX and other Salesforce orgs via SOQL.",
     "fields": [_f("user", "Username", "integration@university.edu"), PASSWORD, _f("token", "Security token", secret=True),
                _f("domain", "Domain", "login (or test for a sandbox)", optional=True)]},
    {"kind": "sftp", "name": "SFTP", "group": "File transfer", "mono": "FT", "color": "#475569", "source": "file",
     "blurb": "Pick up CSV or Excel extracts from an SFTP server.",
     "fields": [_f("host", "Host", "sftp.university.edu"), USER, PORT],
     "auth": [_m("password", "Password", [_f("password", "Password", secret=True)]),
              _m("key", "Private key", [_f("private_key", "Private key (PEM)", secret=True, kind="textarea")])]},
]
BY_KIND = {c["kind"]: c for c in CATALOG}


def split(kind: str, values: dict) -> tuple[dict, dict]:
    """Separate the settings from the credentials. Every required field of the connector and of the chosen way to sign in must
    be filled; the other ways' fields are ignored, so only one set of credentials is ever stored."""
    spec = BY_KIND.get(kind)
    if spec is None:
        raise ValueError("Unknown connector.")
    methods = spec.get("auth") or []
    method = next((m for m in methods if m["key"] == values.get("__auth")), methods[0] if methods else None)
    config, secrets, missing = {}, {}, []
    for f in spec["fields"] + (method["fields"] if method else []):
        v = str(values.get(f["key"]) or "").strip()
        if not v and not f["optional"]:
            missing.append(f["label"])
        if v:
            (secrets if f["secret"] else config)[f["key"]] = v
    if missing:
        raise ValueError(f"Fill in {', '.join(missing)}.")
    if method:
        config["auth"] = method["key"]
    return config, secrets


# ------------------------------------------------------------------------------------------- crypto

def _fernet() -> Fernet:
    if not settings().connection_key:
        raise RuntimeError("CONNECTION_KEY is not configured.")
    return Fernet(settings().connection_key.encode())


def encrypt(data: dict) -> bytes:
    return _fernet().encrypt(json.dumps(data).encode())


def decrypt(blob: bytes) -> dict:
    return json.loads(_fernet().decrypt(blob).decode())


# ------------------------------------------------------------------------------------------- helpers

def _cell(v) -> str:
    if v is None:
        return ""
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return format(v.normalize(), "f")
    if isinstance(v, float):
        return "" if v != v else f"{v:g}"
    if isinstance(v, bytes):
        return ""
    return str(v)


def _frame(rows: list, cols: list[str]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=cols).map(_cell)


def sql_for(source: dict) -> str:
    if source.get("query"):
        q = source["query"].strip().rstrip(";")
        if not SELECT.match(q) or ";" in q:
            raise ValueError("Use a single SELECT query.")
        return q
    t = (source.get("table") or "").strip()
    if not TABLE.match(t):
        raise ValueError("Enter a table or view name, like schema.admits.")
    return f"SELECT * FROM {t}"


_reading = threading.local()  # the import's row counter, for live progress (set by fetch, in the worker thread)


def _dbapi(conn, sql: str) -> pd.DataFrame:
    try:
        cur = conn.cursor()
        _db_status("The database is running the query", "")
        cur.execute(sql)
        cols = [str(d[0]) for d in cur.description]
        rows: list = []
        while chunk := cur.fetchmany(10_000):
            if _stopped():
                raise ValueError("Import cancelled.")
            rows.extend(chunk)
            if on_rows := getattr(_reading, "on_rows", None):
                on_rows(len(rows))
            if len(rows) > MAX_ROWS:
                raise ValueError(f"The result has more than {MAX_ROWS:,} rows. Narrow it with a query.")
        return _frame(rows, cols)
    finally:
        conn.close()


def _port(cfg: dict, default: int) -> int:
    return int(cfg.get("port") or default)


# ------------------------------------------------------------------------------------------- connectors

def _db_host(raw: str) -> str:
    """Accept a hostname or any link copied from the workspace (https://adb-….azuredatabricks.net/…?o=…)."""
    from urllib.parse import urlparse

    raw = raw.strip()
    netloc = urlparse(raw if "://" in raw else "https://" + raw).netloc
    if not netloc or "." not in netloc:
        raise ValueError("Enter the workspace address, for example adb-1234567890123456.7.azuredatabricks.net.")
    return "https://" + netloc


WAREHOUSE_ID = re.compile(r"^[0-9a-f]{16}$")


def _db_warehouse(c: httpx.Client, host: str, http_path: str | None) -> str:
    """The SQL warehouse to run on: from the HTTP path (or a warehouse link), or the workspace's running warehouse."""
    raw = (http_path or "").strip()
    if raw:
        m = re.search(r"/warehouses/([0-9a-f]{16})", raw)
        if m:
            return m.group(1)
        if WAREHOUSE_ID.match(raw):
            return raw
        if re.search(r"/protocolv1/|/clusters/", raw):
            raise ValueError("That HTTP path is for a cluster. YieldPilot needs a SQL warehouse: in Databricks open SQL Warehouses, pick one, and copy "
                             "its HTTP path from Connection details (it looks like /sql/1.0/warehouses/abc123def4567890). Or leave the field blank.")
        table = re.search(r"/explore/data/([^/?#]+)/([^/?#]+)/([^/?#]+)", raw)
        hint = f" After connecting, pick {'.'.join(table.groups())} from the table list." if table else ""
        raise ValueError("That looks like a link to a table, not a SQL warehouse. Leave the HTTP path blank (we'll find your warehouse) or copy it from "
                         f"SQL Warehouses → your warehouse → Connection details.{hint}")
    r = c.get(f"{host}/api/2.0/sql/warehouses")
    if r.status_code == 403:
        raise ValueError("This token can't see SQL warehouses. Ask your Databricks admin for 'Can use' on a SQL warehouse, or paste its HTTP path.")
    if r.status_code != 200:
        raise ValueError(f"Databricks: {r.json().get('message', r.status_code)}")
    ws = r.json().get("warehouses") or []
    if not ws:
        raise ValueError("No SQL warehouse is available in this workspace. Ask your Databricks admin to create one (serverless is fine).")
    ws.sort(key=lambda w: (w.get("state") != "RUNNING", w.get("name", "")))
    return ws[0]["id"]


def _db_auth(cfg: dict, sec: dict) -> tuple[str, str]:
    """Workspace address and a bearer token (personal access token, or a service principal's OAuth token)."""
    host = _db_host(cfg["host"])
    if sec.get("token"):
        return host, sec["token"]
    if sec.get("client_secret") and cfg.get("client_id"):
        r = httpx.post(f"{host}/oidc/v1/token", data={"grant_type": "client_credentials", "scope": "all-apis"},
                       auth=(cfg["client_id"], sec["client_secret"]), timeout=30)
        if r.status_code != 200:
            raise ValueError("Databricks rejected the service principal credentials.")
        return host, r.json()["access_token"]
    raise ValueError("Add a personal access token or a service principal.")


def _db_status(text: str, detail: str = "") -> None:
    if on_status := getattr(_reading, "on_status", None):
        on_status(text, detail)


def _stopped() -> bool:
    return bool((stop := getattr(_reading, "stop", None)) and stop())


def _db_pick(c: httpx.Client, host: str, cfg: dict) -> dict:
    """The SQL warehouse to use right now. A warehouse the user named (HTTP path) is always used. Otherwise: one that is
    running, else a serverless one (starts in seconds), else a classic one (takes minutes). A stopped one is started."""
    if (cfg.get("http_path") or "").strip():
        wid = _db_warehouse(c, host, cfg.get("http_path"))
        w = c.get(f"{host}/api/2.0/sql/warehouses/{wid}").json()
    else:
        r = c.get(f"{host}/api/2.0/sql/warehouses")
        if r.status_code == 403:
            raise ValueError("This token can't see SQL warehouses. Ask your Databricks admin for 'Can use' on a SQL warehouse, or paste its HTTP path.")
        if r.status_code != 200:
            raise ValueError(f"Databricks: {r.json().get('message', r.status_code)}")
        ws = [w for w in r.json().get("warehouses") or [] if w.get("state") != "DELETED"]
        if not ws:
            raise ValueError("No SQL warehouse is available in this workspace. Ask your Databricks admin to create one (serverless is fine).")
        rank = {"RUNNING": 0, "STARTING": 1}
        ws.sort(key=lambda w: (rank.get(w.get("state"), 2), not w.get("enable_serverless_compute"), w.get("name", "").lower()))
        w = ws[0]
    if w.get("state") in ("STOPPED", "STOPPING"):
        c.post(f"{host}/api/2.0/sql/warehouses/{w['id']}/start")
    return {"id": w["id"], "name": w.get("name", "SQL warehouse"), "serverless": bool(w.get("enable_serverless_compute")), "state": w.get("state", "UNKNOWN")}


def warm(kind: str, cfg: dict, sec: dict) -> dict | None:
    """Wake whatever has to be awake for an import (Databricks: the SQL warehouse) while people choose a table."""
    if kind != "databricks":
        return None
    host, token = _db_auth(cfg, sec)
    with httpx.Client(timeout=20, headers={"Authorization": f"Bearer {token}"}) as c:
        return _db_pick(c, host, cfg)


def _db_wait_text(w: dict) -> tuple[str, str]:
    kind = "serverless, usually under 15 seconds" if w["serverless"] else "classic warehouses take 3–5 minutes to start; a serverless one starts in seconds"
    return f"Starting the {w['name']} SQL warehouse", kind


def _db_check(cfg: dict, sec: dict) -> dict:
    """Prove the credentials work and find the SQL warehouse, through the REST API: no query, so no waiting for a
    stopped warehouse. A stopped warehouse is woken up in the background (it takes 1-3 minutes) while people pick a table."""
    host, token = _db_auth(cfg, sec)
    with httpx.Client(timeout=30, headers={"Authorization": f"Bearer {token}"}) as c:
        if c.get(f"{host}/api/2.0/preview/scim/v2/Me").status_code == 401:
            raise ValueError("Databricks rejected the access token. Create a new personal access token under Settings → Developer.")
        w = _db_pick(c, host, cfg)
    return {"warehouse_state": w["state"], "warehouse_name": w["name"], "warehouse_serverless": w["serverless"]}


DB_HIDDEN_CATALOGS = {"system", "samples", "__databricks_internal"}  # Databricks' own: system tables and the demo datasets


def _db_tables(cfg: dict, sec: dict) -> list[dict] | None:
    """Exactly the tables and views this sign-in (token or service principal) is allowed to read, through Unity Catalog's
    REST API, which answers in a second or two with no SQL warehouse. Unity Catalog only returns what the caller holds
    privileges on; tables it may only browse (see the name of, not read) are left out, and so are Databricks' built-in
    system and sample catalogs. None when the workspace has no Unity Catalog."""
    from concurrent.futures import ThreadPoolExecutor

    host, token = _db_auth(cfg, sec)
    with httpx.Client(timeout=30, headers={"Authorization": f"Bearer {token}"}) as c:
        r = c.get(f"{host}/api/2.1/unity-catalog/catalogs")
        if r.status_code != 200:
            return None
        cats = [x["name"] for x in r.json().get("catalogs", [])
                if x.get("name") not in DB_HIDDEN_CATALOGS and x.get("catalog_type") not in ("SYSTEM_CATALOG", "INTERNAL_CATALOG")]

        def schemas(cat):
            j = c.get(f"{host}/api/2.1/unity-catalog/schemas", params={"catalog_name": cat, "include_browse": "false"}).json()
            return [(cat, x["name"]) for x in j.get("schemas", []) if x.get("name") != "information_schema"]

        def tables_in(pair):
            cat, sch = pair
            j = c.get(f"{host}/api/2.1/unity-catalog/tables", params={"catalog_name": cat, "schema_name": sch, "max_results": 500,
                                                                         "omit_columns": "true", "include_browse": "false"}).json()
            return [{"name": f"{cat}.{sch}.{t['name']}", "type": "VIEW" if "VIEW" in str(t.get("table_type", "")).upper() else "TABLE"}
                    for t in j.get("tables", [])]

        with ThreadPoolExecutor(16) as pool:
            pairs = [x for group in pool.map(schemas, cats) for x in group][:400]
            found = [t for group in pool.map(tables_in, pairs) for t in group]
    return sorted(found, key=lambda t: t["name"])[:2000]


def table_version(kind: str, cfg: dict, sec: dict, table: str | None) -> str | None:
    """When a table last changed (Databricks Unity Catalog), so importing an unchanged table again can reuse the copy."""
    if kind != "databricks" or not table:
        return None
    try:
        host, token = _db_auth(cfg, sec)
        r = httpx.get(f"{host}/api/2.1/unity-catalog/tables/{table}", headers={"Authorization": f"Bearer {token}"}, timeout=15)
        return str(r.json().get("updated_at")) if r.status_code == 200 and r.json().get("updated_at") else None
    except Exception:
        return None


def _db_statement(c: httpx.Client, host: str, cfg: dict, sql: str, inline: bool, max_wait: int = 900) -> dict:
    """Run one statement and wait for it, saying what Databricks is doing (a cold warehouse is the usual wait)."""
    w = _db_pick(c, host, cfg)
    if w["state"] != "RUNNING":
        _db_status(*_db_wait_text(w))
    body = {"statement": sql, "warehouse_id": w["id"], "wait_timeout": "5s", "on_wait_timeout": "CONTINUE",
            **({"disposition": "INLINE", "format": "JSON_ARRAY"} if inline else {"disposition": "EXTERNAL_LINKS", "format": "CSV"})}
    r = c.post(f"{host}/api/2.0/sql/statements", json=body)
    if r.status_code != 200:
        raise ValueError(f"Databricks: {r.json().get('message', r.status_code)}")
    st, started = r.json(), time.time()
    while st["status"]["state"] in ("PENDING", "RUNNING"):
        waited = int(time.time() - started)
        if _stopped():
            c.post(f"{host}/api/2.0/sql/statements/{st['statement_id']}/cancel")
            raise ValueError("Import cancelled.")
        if waited > max_wait:
            c.post(f"{host}/api/2.0/sql/statements/{st['statement_id']}/cancel")
            raise ValueError(f"Databricks didn't finish within {max_wait // 60} minutes. Check that the {w['name']} SQL warehouse can start.")
        if st["status"]["state"] == "PENDING":
            state = c.get(f"{host}/api/2.0/sql/warehouses/{w['id']}").json().get("state", "STARTING") if waited % 5 == 0 else None
            if state and state != "RUNNING":
                text, hint = _db_wait_text(w)
                _db_status(text, f"{state.lower()} for {waited} s · {hint}")
        else:
            _db_status("Databricks is running the query", f"{waited} s")
        time.sleep(1)
        st = c.get(f"{host}/api/2.0/sql/statements/{st['statement_id']}").json()
    if st["status"]["state"] != "SUCCEEDED":
        raise ValueError(f"Databricks: {st['status'].get('error', {}).get('message', st['status']['state'])}")
    return st


def _db_preview(cfg: dict, sec: dict, source: dict, n: int) -> pd.DataFrame:
    """A few rows straight back in the response (no result files to download)."""
    host, token = _db_auth(cfg, sec)
    with httpx.Client(timeout=60, headers={"Authorization": f"Bearer {token}"}) as c:
        st = _db_statement(c, host, cfg, f"SELECT * FROM ({sql_for(source)}) AS q LIMIT {n}", inline=True)
        cols = [col["name"] for col in st["manifest"]["schema"]["columns"]]
        rows = (st.get("result") or {}).get("data_array") or []
    return pd.DataFrame(rows, columns=cols).fillna("").astype(str)


def _databricks(cfg, sec, source, max_wait=600):
    """Run one statement on the SQL warehouse; results come back as CSV chunks, downloaded in parallel."""
    from concurrent.futures import ThreadPoolExecutor

    host, token = _db_auth(cfg, sec)
    with httpx.Client(timeout=60, headers={"Authorization": f"Bearer {token}"}) as c:
        st = _db_statement(c, host, cfg, sql_for(source), inline=False, max_wait=max_wait)
        _db_status("Downloading from Databricks", "")
        cols = [col["name"] for col in st["manifest"]["schema"]["columns"]]
        sid, total = st["statement_id"], int(st["manifest"].get("total_chunk_count") or 0)
        first = {lk["chunk_index"]: lk["external_link"] for lk in ((st.get("result") or {}).get("external_links") or [])}

        def link(i):
            if i in first:
                return first[i]
            return c.get(f"{host}/api/2.0/sql/statements/{sid}/result/chunks/{i}").json()["external_links"][0]["external_link"]

        def part(i):
            body = httpx.get(link(i), timeout=300).content  # pre-signed URL: no auth header
            if not body.strip():
                return None
            df = pd.read_csv(io.BytesIO(body), header=None, dtype=str, keep_default_na=False)
            return df.iloc[1:] if list(df.iloc[0]) == cols else df

        done, lock = [0], threading.Lock()
        on_rows = getattr(_reading, "on_rows", None)  # read here: the download threads don't see this thread's settings

        def counted(i):
            out = part(i)
            with lock:
                done[0] += len(out) if out is not None else 0
                n = done[0]
            if on_rows:
                on_rows(n)
            return out

        with ThreadPoolExecutor(8) as pool:  # every chunk at once, kept in order
            frames = [f for f in pool.map(counted, range(total)) if f is not None]
    df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=cols)
    df.columns = cols
    return df.fillna("").astype(str)


def _snowflake(cfg, sec, source):
    import snowflake.connector

    auth = {"password": sec["password"]} if sec.get("password") else {}
    if sec.get("private_key"):
        from cryptography.hazmat.primitives import serialization

        key = serialization.load_pem_private_key(sec["private_key"].encode(), password=None)
        auth = {"private_key": key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())}
    if not auth:
        raise ValueError("Add a password or a private key.")
    conn = snowflake.connector.connect(account=cfg["account"], user=cfg["user"], warehouse=cfg["warehouse"], database=cfg["database"],
                                       schema=cfg.get("schema") or None, role=cfg.get("role") or None, login_timeout=30,
                                       application="YieldPilot", **auth)
    return _dbapi(conn, sql_for(source))


def _bigquery(cfg, sec, source):
    from google.cloud import bigquery
    from google.oauth2 import service_account

    try:
        info = json.loads(sec["credentials"])
    except json.JSONDecodeError:
        raise ValueError("The service account key must be the JSON file's contents.")
    creds = service_account.Credentials.from_service_account_info(info, scopes=["https://www.googleapis.com/auth/bigquery.readonly",
                                                                                 "https://www.googleapis.com/auth/cloud-platform.read-only"])
    client = bigquery.Client(project=cfg["project"], credentials=creds, location=cfg.get("location") or None)
    res = client.query(sql_for(source)).result(timeout=600)
    if (res.total_rows or 0) > MAX_ROWS:
        raise ValueError(f"The result has more than {MAX_ROWS:,} rows. Narrow it with a query.")
    return res.to_arrow(create_bqstorage_client=False).to_pandas().map(_cell)


def _sqlserver(cfg, sec, source):
    import certifi
    import pytds

    conn = pytds.connect(server=cfg["host"], port=_port(cfg, 1433), database=cfg["database"], user=cfg["user"], password=sec["password"],
                         login_timeout=30, cafile=certifi.where(), validate_host=False, autocommit=True)
    return _dbapi(conn, sql_for(source))


def _oracle(cfg, sec, source):
    import oracledb

    conn = oracledb.connect(user=cfg["user"], password=sec["password"], dsn=f"{cfg['host']}:{_port(cfg, 1521)}/{cfg['service']}", tcp_connect_timeout=30)
    return _dbapi(conn, sql_for(source))


def _postgres(cfg, sec, source):
    import psycopg

    conn = psycopg.connect(host=cfg["host"], port=_port(cfg, 5432), dbname=cfg["database"], user=cfg["user"], password=sec["password"],
                           connect_timeout=30, sslmode="prefer", application_name="YieldPilot")
    conn.read_only = True
    return _dbapi(conn, sql_for(source))


def _mysql(cfg, sec, source):
    import pymysql

    conn = pymysql.connect(host=cfg["host"], port=_port(cfg, 3306), database=cfg["database"], user=cfg["user"], password=sec["password"],
                           connect_timeout=30, read_timeout=600)
    return _dbapi(conn, sql_for(source))


def _slate(cfg, sec, source):
    auth = (cfg["user"], sec.get("password", "")) if cfg.get("user") else None
    r = httpx.get(cfg["url"], auth=auth, timeout=300, follow_redirects=True)
    if r.status_code != 200:
        raise ValueError(f"Slate returned HTTP {r.status_code}. Check the URL and service account.")
    text = r.text.lstrip()
    if text.startswith(("{", "[")):
        body = r.json()
        rows = body if isinstance(body, list) else next((v for v in body.values() if isinstance(v, list)), [])
        if not rows:
            raise ValueError("The Slate query returned no rows.")
        return pd.DataFrame(rows).map(_cell)
    return pd.read_csv(io.StringIO(text), dtype=str, keep_default_na=False)


def _salesforce(cfg, sec, source):
    from simple_salesforce import Salesforce

    q = (source.get("query") or "").strip()
    if not re.match(r"^\s*select\b", q, re.I):
        raise ValueError("Enter a SOQL query, like SELECT Id, Status__c FROM Application__c.")
    sf = Salesforce(username=cfg["user"], password=sec["password"], security_token=sec["token"], domain=(cfg.get("domain") or "login").split()[0])
    recs = sf.query_all(q)["records"]
    rows = [{k: v for k, v in r.items() if k != "attributes" and not isinstance(v, dict)} for r in recs]
    return pd.DataFrame(rows).map(_cell)


def _sftp_open(cfg, sec):
    import paramiko

    t = paramiko.Transport((cfg["host"], _port(cfg, 22)))
    t.banner_timeout = 30
    key = paramiko.RSAKey.from_private_key(io.StringIO(sec["private_key"])) if sec.get("private_key") else None
    t.connect(username=cfg["user"], password=sec.get("password"), pkey=key)
    seen = t.get_remote_server_key().get_base64()
    if cfg.get("host_key") and cfg["host_key"] != seen:
        t.close()
        raise ValueError("The SFTP server's host key changed. Re-create the connection if this is expected.")
    return t, paramiko.SFTPClient.from_transport(t), seen


def _sftp(cfg, sec, source):
    from ..ingest import read_any, sniff_kind

    path = (source.get("path") or "").strip()
    if not path:
        raise ValueError("Enter the file path, like /exports/admits.csv.")
    t, sftp, _ = _sftp_open(cfg, sec)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            local = os.path.join(tmp, "source")
            sftp.get(path, local)
            return read_any(local, sniff_kind(local, os.path.basename(path)))
    finally:
        t.close()


FETCH = {"databricks": _databricks, "snowflake": _snowflake, "bigquery": _bigquery, "sqlserver": _sqlserver, "oracle": _oracle,
         "postgres": _postgres, "mysql": _mysql, "slate": _slate, "salesforce": _salesforce, "sftp": _sftp}


def fetch(kind: str, cfg: dict, sec: dict, source: dict, on_rows=None, on_status=None, stop=None) -> pd.DataFrame:
    """Every row of a table, query or file. on_rows(n) and on_status(text, detail) report progress; stop() cancels."""
    _reading.on_rows, _reading.on_status, _reading.stop = on_rows, on_status, stop
    try:
        df = FETCH[kind](cfg, sec, source)
    except ValueError:
        raise
    except Exception as e:  # driver errors become readable messages
        raise ValueError(friendly_error(kind, e)) from e
    finally:
        _reading.on_rows = _reading.on_status = _reading.stop = None
    if df.empty:
        raise ValueError("The source returned no rows.")
    df.columns = [str(c).strip() for c in df.columns]
    return df


def test(kind: str, cfg: dict, sec: dict) -> dict:
    """Connect once to prove the credentials work. Returns settings learned on the way (the SFTP host key)."""
    try:
        if kind == "sftp":
            t, _, seen = _sftp_open(cfg, sec)
            t.close()
            return {"host_key": seen}
        if kind == "databricks":
            return _db_check(cfg, sec)
        if kind == "slate":
            _slate(cfg, sec, {})
        elif kind == "salesforce":
            _salesforce(cfg, sec, {"query": "SELECT Id FROM User LIMIT 1"})
        else:
            FETCH[kind](cfg, sec, {"query": "SELECT 1 AS ok FROM DUAL" if kind == "oracle" else "SELECT 1 AS ok"})
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(friendly_error(kind, e)) from e
    return {}


# ------------------------------------------------------------------------------------------- browse and preview

_SYS = "('pg_catalog','information_schema','mysql','sys','performance_schema','INFORMATION_SCHEMA')"
LIST_SQL = {
    "postgres": f"SELECT table_schema || '.' || table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema NOT IN {_SYS} ORDER BY 1",
    "mysql": f"SELECT CONCAT(table_schema, '.', table_name) AS name, table_type AS type FROM information_schema.tables WHERE table_schema NOT IN {_SYS} ORDER BY 1",
    "sqlserver": "SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS name, TABLE_TYPE AS type FROM INFORMATION_SCHEMA.TABLES ORDER BY 1",
    "snowflake": "SELECT table_schema || '.' || table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema <> 'INFORMATION_SCHEMA' ORDER BY 1",
    "databricks": ("SELECT table_catalog || '.' || table_schema || '.' || table_name AS name, table_type AS type FROM system.information_schema.tables "
                   "WHERE table_schema <> 'information_schema' AND table_catalog NOT IN ('system', 'samples', '__databricks_internal') "
                   "ORDER BY 1 LIMIT 1000"),
    "oracle": ("SELECT owner || '.' || table_name AS name, 'TABLE' AS type FROM all_tables WHERE owner NOT IN ('SYS','SYSTEM','XDB','MDSYS','CTXSYS',"
               "'OUTLN','DBSNMP','APPQOSSYS','WMSYS','ORDSYS','OLAPSYS','LBACSYS','DVSYS','AUDSYS','GSMADMIN_INTERNAL','OJVMSYS','DBSFWUSER') "
               "UNION ALL SELECT owner || '.' || view_name, 'VIEW' FROM all_views WHERE owner NOT IN ('SYS','SYSTEM','XDB','MDSYS','CTXSYS','OUTLN',"
               "'DBSNMP','APPQOSSYS','WMSYS','ORDSYS','OLAPSYS','LBACSYS','DVSYS','AUDSYS','GSMADMIN_INTERNAL','OJVMSYS','DBSFWUSER')"),
}


def tables(kind: str, cfg: dict, sec: dict) -> list[dict]:
    """The tables and views this connection can read, so people pick instead of typing names."""
    try:
        if kind == "bigquery":
            from google.cloud import bigquery
            from google.oauth2 import service_account

            creds = service_account.Credentials.from_service_account_info(json.loads(sec["credentials"]))
            client = bigquery.Client(project=cfg["project"], credentials=creds)
            out = []
            for ds in client.list_datasets(max_results=100):
                for t in client.list_tables(ds.dataset_id, max_results=200):
                    out.append({"name": f"{ds.dataset_id}.{t.table_id}", "type": "VIEW" if t.table_type == "VIEW" else "TABLE"})
            return out[:1000]
        if kind == "databricks" and (found := _db_tables(cfg, sec)) is not None:
            return found
        if kind not in LIST_SQL:
            return []
        df = FETCH[kind](cfg, sec, {"query": LIST_SQL[kind]})
    except Exception as e:
        raise ValueError(friendly_error(kind, e)) from e
    df.columns = [c.lower() for c in df.columns]
    return [{"name": r["name"], "type": "VIEW" if "VIEW" in str(r["type"]).upper() else "TABLE"} for _, r in df.head(1000).iterrows()]


def _limited(kind: str, sql: str, n: int) -> str:
    if kind == "sqlserver":
        return f"SELECT TOP {n} * FROM ({sql}) AS q"
    if kind == "oracle":
        return f"SELECT * FROM ({sql}) WHERE ROWNUM <= {n}"
    return f"SELECT * FROM ({sql}) AS q LIMIT {n}"


def preview(kind: str, cfg: dict, sec: dict, source: dict, n: int = 20, on_status=None, stop=None) -> pd.DataFrame:
    """The first rows of a table or query, to check before importing."""
    if kind == "databricks":
        _reading.on_status, _reading.stop = on_status, stop
        try:
            return _db_preview(cfg, sec, source, n)
        except ValueError:
            raise
        except Exception as e:
            raise ValueError(friendly_error(kind, e)) from e
        finally:
            _reading.on_status = _reading.stop = None
    if BY_KIND[kind]["source"] == "sql":
        return fetch(kind, cfg, sec, {"query": _limited(kind, sql_for(source), n)}).head(n)
    if kind == "salesforce" and source.get("query") and " limit " not in source["query"].lower():
        source = {**source, "query": f"{source['query'].rstrip()} LIMIT {n}"}
    return fetch(kind, cfg, sec, source).head(n)


def friendly_error(kind: str, e: Exception) -> str:
    """Turn driver errors into something an analyst can act on."""
    msg = str(e).splitlines()[0][:300]
    low = msg.lower()
    name = BY_KIND[kind]["name"]
    if any(k in low for k in ("does not exist", "doesn't exist", "invalid object name", "ora-00942", "not found: table", "table or view not found")):
        if "column" in low:
            return f"{name}: a column in the query doesn't exist ({msg}). Column names must match the table exactly; pick the table from the list to see them."
        return f"{name}: that table or view wasn't found ({msg}). Pick one from the list, or include its schema, for example ir.admit_history."
    if "permission denied" in low or "insufficient privileges" in low or "access denied" in low or "not authorized" in low:
        return f"{name}: the database user can't read that ({msg}). Ask your database administrator to grant SELECT on it."
    if "syntax error" in low or "ora-00933" in low or "incorrect syntax" in low:
        return f"{name}: the query has a syntax error ({msg})."
    if "timeout" in low or "timed out" in low or "could not connect" in low or "connection refused" in low:
        return f"{name}: couldn't reach the server ({msg}). Check the host and port, and that it accepts connections from the internet."
    if "password authentication failed" in low or "login failed" in low or "invalid username/password" in low:
        return f"{name}: the username or password was rejected."
    return f"{name}: {msg}"
