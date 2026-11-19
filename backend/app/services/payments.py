"""Stripe, through its REST API: Checkout to subscribe, the Customer Portal to manage cards and invoices, and a signed
webhook that keeps plans and payments in sync. Card details never reach YieldPilot.

Keys: STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET, or the Secret Manager secrets yp-stripe-secret-key / yp-stripe-webhook-secret
(scripts/set_stripe.sh stores them). Until a key exists, billing pages say payments aren't set up yet.
"""

import hashlib
import hmac
import logging
import time

import httpx
from fastapi import HTTPException

from ..config import settings
from . import secrets

log = logging.getLogger("yieldpilot.payments")
API = "https://api.stripe.com/v1"
QUOTED = "enterprise"  # arranged directly, never sold through Checkout
RUNNING = ("active", "trialing", "past_due", "unpaid")
_portal: dict[str, tuple[float, str]] = {}


def secret_key() -> str:
    return secrets.get("yp-stripe-secret-key", settings().stripe_secret_key)


def webhook_secret() -> str:
    return secrets.get("yp-stripe-webhook-secret", settings().stripe_webhook_secret)


def ready() -> bool:
    return bool(secret_key())


def mode() -> str | None:
    """"test" or "live" from the key in use; None until Stripe is connected."""
    key = secret_key()
    return None if not key else "test" if "_test_" in key else "live"


def _form(data: dict, prefix: str = "") -> list[tuple[str, str]]:
    """Stripe's nested form encoding: {"a": {"b": 1}, "c": [x]} -> a[b]=1, c[0]=x."""
    out: list[tuple[str, str]] = []
    for k, v in data.items():
        key = f"{prefix}[{k}]" if prefix else str(k)
        if isinstance(v, dict):
            out += _form(v, key)
        elif isinstance(v, list):
            for i, item in enumerate(v):
                out += _form(item, f"{key}[{i}]") if isinstance(item, dict) else [(f"{key}[{i}]", str(item))]
        elif v is not None:
            out.append((key, "true" if v is True else "false" if v is False else str(v)))
    return out


def call(method: str, path: str, data: dict | None = None, idempotency: str | None = None, missing_ok: bool = False) -> dict | None:
    key = secret_key()
    if not key:
        raise HTTPException(409, "Payments aren't set up yet.")
    headers = {"Idempotency-Key": idempotency} if idempotency else {}
    r = httpx.request(method, f"{API}/{path}", auth=(key, ""), headers=headers, timeout=20,
                      **({"params": _form(data or {})} if method == "GET" else {"data": dict(_form(data or {}))}))
    if r.status_code == 404 and missing_ok:
        return None
    body = r.json()
    if r.status_code >= 400:
        log.warning("stripe %s %s: %s", method, path, (body.get("error") or {}).get("message"))
        raise HTTPException(502, "The payment provider couldn't complete that. Please try again.")
    return body


def verify(payload: bytes, header: str, tolerance: int = 300) -> bool:
    """Stripe-Signature: t=<time>,v1=<HMAC-SHA256 of "t.payload">; rejects forged and replayed webhooks."""
    secret = webhook_secret()
    if not secret or not header:
        return False
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    sigs = [p.split("=", 1)[1] for p in header.split(",") if p.startswith("v1=")]
    try:
        t = int(parts.get("t", "0"))
    except ValueError:
        return False
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + payload, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, s) for s in sigs)


def _price(plan, interval: str) -> dict:
    """The plan's Stripe price, created the first time it is needed (found again by its lookup key)."""
    cents = plan.price_month_cents if interval == "month" else plan.price_year_cents
    if not cents:
        raise HTTPException(422, f"{plan.name} isn't sold {'monthly' if interval == 'month' else 'yearly'} online. Contact us for a quote.")
    lookup = f"yp_{plan.key}_{interval}_{cents}"
    found = call("GET", "prices", {"lookup_keys": [lookup], "active": True, "limit": 1}).get("data") or []
    if found:
        return found[0]
    products = call("GET", "products/search", {"query": f"metadata['plan']:'{plan.key}'", "limit": 1}).get("data") or []
    product = products[0]["id"] if products else call("POST", "products", {"name": f"YieldPilot {plan.name}", "metadata": {"plan": plan.key}},
                                                       idempotency=f"product-{plan.key}")["id"]
    return call("POST", "prices", {"product": product, "currency": "usd", "unit_amount": cents, "lookup_key": lookup,
                                   "recurring": {"interval": interval}, "metadata": {"plan": plan.key}}, idempotency=f"price-{lookup}")


def price_for(plan, interval: str) -> str:
    return _price(plan, interval)["id"]


def ensure_customer(customer_id: str | None, email: str, name: str, institution_id: str) -> str:
    """The institution's Stripe customer. One remembered from test mode doesn't exist under live keys: then a new one is made."""
    if customer_id:
        found = call("GET", f"customers/{customer_id}", missing_ok=True)
        if found and not found.get("deleted"):
            return customer_id
    # the key only guards against a double click: Stripe would otherwise keep handing back a customer that has since been deleted
    return call("POST", "customers", {"email": email, "name": name, "metadata": {"institution_id": institution_id}}, f"customer-{institution_id}-{int(time.time()) // 600}")["id"]


def customer_exists(customer_id: str | None) -> bool:
    found = call("GET", f"customers/{customer_id}", missing_ok=True) if customer_id else None
    return bool(found) and not found.get("deleted")


def running_subscription(customer: str) -> dict | None:
    """What this customer is paying for now, asked of Stripe rather than remembered, so no one can end up paying twice."""
    subs = call("GET", "subscriptions", {"customer": customer, "status": "all", "limit": 10}).get("data") or []
    return next((s for s in subs if s.get("status") in RUNNING), None)


def portal_configuration(catalog: list) -> str:
    """Stripe's hosted billing page: cards, invoices, cancelling at the end of the period, and moving between the plans sold online.
    Made by this code, so test and live are set up the same way and new prices are offered as soon as they exist."""
    current = mode()
    hit = _portal.get(current)
    if hit and time.monotonic() - hit[0] < 600:
        return hit[1]
    products: dict[str, list[str]] = {}
    for plan in catalog:
        if plan.key == QUOTED:
            continue
        for interval, cents in (("month", plan.price_month_cents), ("year", plan.price_year_cents)):
            if cents:
                price = _price(plan, interval)
                products.setdefault(price["product"], []).append(price["id"])
    site = settings().frontend_origin.rstrip("/")
    body = {
        "metadata": {"app": "yieldpilot"},
        "business_profile": {"headline": "YieldPilot billing", "privacy_policy_url": f"{site}/privacy", "terms_of_service_url": f"{site}/terms"},
        "features": {
            "customer_update": {"enabled": True, "allowed_updates": ["email", "name", "address", "tax_id"]},
            "invoice_history": {"enabled": True},
            "payment_method_update": {"enabled": True},
            "subscription_cancel": {"enabled": True, "mode": "at_period_end"},
            "subscription_update": {"enabled": True, "default_allowed_updates": ["price"], "proration_behavior": "always_invoice",  # the difference is charged at the change, not added to next year's bill
                                    "products": [{"product": k, "prices": v} for k, v in products.items()]},
        },
    }
    made = next((c for c in call("GET", "billing_portal/configurations", {"active": True, "limit": 100}).get("data") or []
                 if (c.get("metadata") or {}).get("app") == "yieldpilot"), None)
    config = call("POST", f"billing_portal/configurations/{made['id']}" if made else "billing_portal/configurations", body)["id"]
    _portal[current] = (time.monotonic(), config)
    return config


def start_checkout(plan, interval: str, customer_id: str | None, email: str, institution: str, institution_id: str, catalog: list, back: str) -> tuple[str, str, str]:
    """Where to send the buyer: Stripe Checkout for a first plan. Someone already paying goes to Stripe's page to confirm the change,
    which shows the price difference; a second subscription is never made. Returns (url, customer, price)."""
    price = price_for(plan, interval)
    customer = ensure_customer(customer_id, email, institution, institution_id)
    running = running_subscription(customer)
    if running:
        item = running["items"]["data"][0]
        if item["price"]["id"] == price:
            raise HTTPException(409, "You're already on this plan.")
        s = call("POST", "billing_portal/sessions", {
            "customer": customer, "configuration": portal_configuration(catalog), "return_url": back,
            "flow_data": {"type": "subscription_update_confirm",
                          "subscription_update_confirm": {"subscription": running["id"], "items": [{"id": item["id"], "price": price, "quantity": item.get("quantity") or 1}]},
                          "after_completion": {"type": "redirect", "redirect": {"return_url": f"{back}?checkout=done"}}}})
        return s["url"], customer, price
    for old in call("GET", "checkout/sessions", {"customer": customer, "status": "open", "limit": 20}).get("data") or []:
        call("POST", f"checkout/sessions/{old['id']}/expire")  # only the newest checkout can be paid
    s = call("POST", "checkout/sessions", {
        "mode": "subscription", "customer": customer, "client_reference_id": institution_id,
        "line_items": [{"price": price, "quantity": 1}], "allow_promotion_codes": True, "billing_address_collection": "auto",
        "subscription_data": {"metadata": {"institution_id": institution_id, "plan": plan.key}},
        "success_url": f"{back}?checkout=done", "cancel_url": f"{back}?checkout=cancelled"})
    return s["url"], customer, price
