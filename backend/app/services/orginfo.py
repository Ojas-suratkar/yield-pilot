"""An institution's public profile from its website or email domain: official name, logo, description, location and type.

Sources, best first: the world universities list (name, country, state for 10,000+ universities and colleges by domain),
then the website's own metadata (site name, description, logo and icons). Fetching is safe for any input: only http(s) on
ports 80/443 to public internet addresses (never this server's network or cloud metadata), every redirect re-checked,
small size and time limits. The logo is stored as a 128px PNG, so nothing is loaded from other sites when the app shows it.
"""

import base64
import io
import ipaddress
import logging
import re
import socket
import threading
import time
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import httpx

from ..auth import is_free_mail

log = logging.getLogger("yieldpilot.orginfo")
UA = "Mozilla/5.0 (compatible; YieldPilot/1.0; institution profile)"
UNIVERSITIES = "https://raw.githubusercontent.com/Hipo/university-domains-list/master/world_universities_and_domains.json"
_unis: dict[str, dict] = {}
_unis_at = 0.0
_lock = threading.Lock()
EDU = re.compile(r"(\.edu|\.ac\.[a-z]{2}|\.edu\.[a-z]{2}|\.k12\.[a-z]{2}\.us)$")


def domain_of(value: str) -> str | None:
    """"https://www.csulb.edu/about" or "jane@csulb.edu" or "csulb.edu" -> "csulb.edu"."""
    v = (value or "").strip().lower()
    if not v:
        return None
    if "@" in v and "/" not in v:
        v = v.rsplit("@", 1)[1]
    host = urlparse(v if "://" in v else f"https://{v}").hostname or ""
    host = host.removeprefix("www.").strip(".")
    try:
        ipaddress.ip_address(host)
        return None  # an address, not a name: institutions are looked up by their domain
    except ValueError:
        pass
    return host if re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]+", host) and len(host) <= 200 else None


# ------------------------------------------------------------------------------------------ safe fetching

def _public(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except OSError:
        return False
    ips = {ipaddress.ip_address(i[4][0]) for i in infos}
    return bool(ips) and all(ip.is_global for ip in ips)


def _get(url: str, limit: int, accept: str = "*/*") -> tuple[str, bytes, str] | None:
    """GET a public URL: (final url, body, content type), or None. Redirects are followed by hand and each hop re-checked."""
    for _ in range(4):
        u = urlparse(url)
        if u.scheme not in ("http", "https") or not u.hostname or (u.port not in (None, 80, 443)) or not _public(u.hostname):
            return None
        try:
            with httpx.stream("GET", url, headers={"User-Agent": UA, "Accept": accept}, timeout=6, follow_redirects=False) as r:
                if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                    url = urljoin(url, r.headers["location"])
                    continue
                if r.status_code != 200:
                    return None
                body = b""
                for chunk in r.iter_bytes():
                    body += chunk
                    if len(body) > limit:
                        return None
                return url, body, r.headers.get("content-type", "").split(";")[0].strip().lower()
        except httpx.HTTPError:
            return None
    return None


class _Meta(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.meta: dict[str, str] = {}
        self.icons: list[tuple[int, str, str]] = []  # (size, rel, href)
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key and a.get("content") and key not in self.meta:
                self.meta[key] = a["content"].strip()
        elif tag == "link" and "icon" in a.get("rel", "").lower() and a.get("href"):
            sizes = re.findall(r"(\d+)x\d+", a.get("sizes", ""))
            rel = a["rel"].lower()
            size = max(map(int, sizes)) if sizes else (180 if "apple" in rel else 32)
            self.icons.append((size, rel, a["href"]))
        elif tag == "title" and not self.title:
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data


def _page(domain: str) -> tuple[str, _Meta] | None:
    for base in (f"https://{domain}", f"https://www.{domain}", f"http://{domain}"):
        got = _get(base, 1_500_000, "text/html")
        if got and "html" in got[2]:
            m = _Meta()
            try:
                m.feed(got[1].decode("utf-8", "replace"))
            except Exception:
                pass
            return got[0], m
    return None


def _png(data: bytes) -> str | None:
    from PIL import Image

    try:
        img = Image.open(io.BytesIO(data))
        if getattr(img, "n_frames", 1) > 1:
            img.seek(0)
        if max(img.size) < 32:
            return None  # a 16px favicon looks blurry; try the next source
        img = img.convert("RGBA")
        img.thumbnail((128, 128))
        out = io.BytesIO()
        img.save(out, "PNG", optimize=True)
        return "data:image/png;base64," + base64.b64encode(out.getvalue()).decode()
    except Exception:
        return None


def _logo(domain: str, page_url: str | None, meta: _Meta | None) -> str | None:
    candidates: list[str] = []
    if meta:
        for size, _rel, href in sorted(meta.icons, key=lambda x: -x[0]):
            if not href.lower().endswith(".svg"):
                candidates.append(urljoin(page_url or f"https://{domain}", href))
    candidates += [f"https://{domain}/apple-touch-icon.png", f"https://www.google.com/s2/favicons?domain={domain}&sz=128"]
    for url in candidates[:6]:
        got = _get(url, 400_000, "image/*")
        if got and (got[2].startswith("image/") or got[2] in ("application/octet-stream", "")):
            if (png := _png(got[1])) is not None:
                return png
    return None


# ------------------------------------------------------------------------------------------ universities list

def _universities() -> dict[str, dict]:
    global _unis, _unis_at
    with _lock:
        if _unis and time.monotonic() - _unis_at < 86_400:
            return _unis
    try:
        rows = httpx.get(UNIVERSITIES, timeout=10, headers={"User-Agent": UA}).json()
        by = {}
        for r in rows:
            for d in r.get("domains") or []:
                by.setdefault(d.lower().removeprefix("www."), r)
        with _lock:
            _unis, _unis_at = by, time.monotonic()
    except Exception:
        log.info("universities list unavailable")
    return _unis


def _university(domain: str) -> dict | None:
    unis = _universities()
    parts = domain.split(".")
    for i in range(len(parts) - 1):  # cs.csulb.edu -> csulb.edu
        hit = unis.get(".".join(parts[i:]))
        if hit:
            return hit
    return None


def _clean_title(t: str, domain: str) -> str | None:
    t = re.sub(r"\s+", " ", t or "").strip()
    if not t:
        return None
    parts = [p.strip() for p in re.split(r"\s[|\-–—:·\\/]\s", t) if p.strip()]
    skip = {"home", "homepage", "welcome", "official website", "home page", "official site"}
    parts = [p for p in parts if p.lower() not in skip] or parts
    return max(parts, key=len)[:200] if parts else None


def lookup(value: str) -> dict:
    """{"domain", "website", "name", "logo", "description", "kind", "country", "region", "free_mail"} for a website or email."""
    domain = domain_of(value)
    if not domain:
        return {"domain": None}
    if is_free_mail(domain):
        return {"domain": domain, "free_mail": True}
    uni = _university(domain)
    page = _page(domain)
    url, meta = page if page else (None, None)
    m = meta.meta if meta else {}
    name = (uni or {}).get("name") or m.get("og:site_name") or m.get("application-name") or _clean_title(meta.title if meta else "", domain)
    desc = m.get("og:description") or m.get("description") or m.get("twitter:description")
    kind = "university" if uni or EDU.search(domain) else "organization"
    if name and kind == "university" and re.search(r"\bcollege\b", name, re.I) and not re.search(r"\buniversity\b", name, re.I):
        kind = "college"
    return {
        "domain": domain,
        "found": bool(uni or page),
        "website": f"https://{urlparse(url).hostname}" if url else (((uni or {}).get("web_pages") or [None])[0] or f"https://{domain}"),
        "name": name or domain.split(".")[0].upper(),
        "logo": _logo(domain, url, meta),
        "description": re.sub(r"\s+", " ", desc).strip()[:600] if desc else None,
        "kind": kind,
        "country": (uni or {}).get("country"),
        "region": (uni or {}).get("state-province"),
        "free_mail": False,
    }
