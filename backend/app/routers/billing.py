"""Billing and usage for an institution's owners (it shows everyone's usage and what is paid), and the Stripe webhook."""

import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import Principal, audit, current
from ..config import settings
from ..db import get_session
from ..models import Payment, Plan, Subscription, User
from ..services import payments, plans

router = APIRouter(prefix="/billing", tags=["billing"])
log = logging.getLogger("yieldpilot.billing")


def _ts(v) -> datetime | None:
    return datetime.fromtimestamp(v, timezone.utc) if v else None


@router.get("/quota")
async def quota(who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """What's used and left this month, for the Run button. Every member sees this; the full breakdown is the owner's."""
    lim = await plans.limits(session, await plans.subscription(session, who.institution.id))
    use = await plans.usage(session, who.institution.id, storage=False)
    await session.commit()
    return {"enforced": settings().enforce_plans, "runs_used_me": use["runs_by_user"].get(who.user.id, 0), "runs_limit_me": (await plans.allowances(session, who.institution.id)).get(who.user.id, lim["runs_per_user"]),
            "runs_used": use["runs_month"], "runs_limit": lim["runs_per_institution"], "rows_limit": lim["rows_per_dataset"]}


@router.get("/members")
async def member_runs(who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Everyone's runs this month and what they have left. Admins can see it; the owner changes it."""
    who.require("admin")
    out = await plans.member_runs(session, who.institution.id)
    await session.commit()
    return {**out, "can_edit": who.at_least("owner")}


class AllowanceIn(BaseModel):
    runs: int | None = Field(None, ge=0, le=100_000)


@router.put("/members/{user_id}/runs")
async def set_member_runs(user_id: str, body: AllowanceIn, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("owner")
    await plans.set_allowance(session, who.institution.id, user_id, body.runs, who.user.id)
    await audit(session, who, "runs.allowance_set", user_id, runs=body.runs)
    await session.commit()
    return {**(await plans.member_runs(session, who.institution.id)), "can_edit": True}


@router.get("")
async def billing(who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("owner")
    sub = await plans.subscription(session, who.institution.id)
    use = await plans.usage(session, who.institution.id)
    people = (await session.execute(select(User.id, User.name, User.email).where(User.id.in_(list(use["runs_by_user"]) or [""])))).all()
    names = {u: (n or e) for u, n, e in people}
    invoices = (await session.scalars(select(Payment).where(Payment.institution_id == who.institution.id).order_by(Payment.created_at.desc()).limit(24))).all()
    catalog = (await session.scalars(select(Plan).order_by(Plan.sort))).all()
    await session.commit()
    mode = await run_in_threadpool(payments.mode)
    return {
        "plan": sub.plan_key, "status": sub.status, "interval": sub.interval, "seats": sub.seats,
        "current_period_end": sub.current_period_end.isoformat() if sub.current_period_end else None,
        "limits": await plans.limits(session, sub), "enforced": settings().enforce_plans,
        "usage": {**use, "runs_by_user": [{"name": names.get(u, "Former member"), "runs": n} for u, n in sorted(use["runs_by_user"].items(), key=lambda x: -x[1])]},
        "plans": [plans.plan_out(p) for p in catalog],
        "invoices": [{"id": i.id, "amount": i.amount_cents, "currency": i.currency, "status": i.status, "description": i.description,
                      "url": i.hosted_url, "pdf": i.pdf_url, "created_at": i.created_at.isoformat(), "test_mode": i.test_mode} for i in invoices],
        "payments_ready": bool(mode), "test_mode": mode == "test", "has_customer": bool(sub.stripe_customer_id),
        "cancel_at_period_end": sub.cancel_at_period_end,
    }


class CheckoutIn(BaseModel):
    plan: str
    interval: str = "year"


@router.post("/checkout")
async def checkout(body: CheckoutIn, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """The card is entered on Stripe's page and Stripe's webhook then switches the plan; changing a plan is confirmed on Stripe's page too."""
    who.require("owner")
    if body.interval not in ("month", "year"):
        raise HTTPException(422, "Choose monthly or yearly billing.")
    plan = await session.get(Plan, body.plan)
    if plan is None:
        raise HTTPException(404, "That plan doesn't exist.")
    if plan.key == payments.QUOTED:
        raise HTTPException(422, f"{plan.name} is arranged with YieldPilot directly. Contact us for a quote.")
    sub = await plans.subscription(session, who.institution.id)
    catalog = (await session.scalars(select(Plan))).all()
    back = f"{settings().frontend_origin.rstrip('/')}/settings/billing"
    url, customer, price = await run_in_threadpool(payments.start_checkout, plan, body.interval, sub.stripe_customer_id, who.user.email, who.institution.name,
                                                   who.institution.id, catalog, back)
    setattr(plan, "stripe_price_month" if body.interval == "month" else "stripe_price_year", price)
    sub.stripe_customer_id = customer
    await audit(session, who, "billing.checkout_started", who.institution.id, plan=plan.key, interval=body.interval)
    await session.commit()
    return {"url": url}


@router.post("/portal")
async def portal(who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Stripe's Customer Portal: change card, download invoices, change or cancel the plan."""
    who.require("owner")
    sub = await plans.subscription(session, who.institution.id)
    if not await run_in_threadpool(payments.customer_exists, sub.stripe_customer_id):
        raise HTTPException(409, "There's no billing account yet. Choose a plan first.")
    catalog = (await session.scalars(select(Plan))).all()
    config = await run_in_threadpool(payments.portal_configuration, catalog)
    s = await run_in_threadpool(payments.call, "POST", "billing_portal/sessions", {
        "customer": sub.stripe_customer_id, "configuration": config, "return_url": f"{settings().frontend_origin.rstrip('/')}/settings/billing"})
    return {"url": s["url"]}


# ------------------------------------------------------------------------------------------ webhook

async def _sync_subscription(session: AsyncSession, s: dict) -> None:
    # Stripe doesn't promise events in order: what counts is the subscription as it is now, not as it was when the event was sent
    s = await run_in_threadpool(payments.call, "GET", f"subscriptions/{s['id']}", None, None, True) or s
    if "status" not in s:
        return
    sub = await session.scalar(select(Subscription).where(Subscription.stripe_subscription_id == s["id"]))
    if sub is None:
        inst = (s.get("metadata") or {}).get("institution_id")
        sub = await session.get(Subscription, inst) if inst else None
        if sub is None:
            sub = await session.scalar(select(Subscription).where(Subscription.stripe_customer_id == s.get("customer")))
    if sub is None:
        log.warning("stripe subscription %s matches no institution", s.get("id"))
        return
    if sub.stripe_subscription_id and sub.stripe_subscription_id != s["id"] and s.get("status") not in payments.RUNNING:
        return  # an old subscription ending, after a newer one took over
    item = ((s.get("items") or {}).get("data") or [{}])[0]
    price = item.get("price") or {}
    plan_key = (price.get("metadata") or {}).get("plan") or (s.get("metadata") or {}).get("plan")
    status = {"active": "active", "trialing": "trialing", "past_due": "past_due", "unpaid": "past_due", "incomplete": "past_due",
              "canceled": "canceled", "incomplete_expired": "canceled", "paused": "past_due"}.get(s.get("status"), "past_due")
    sub.stripe_subscription_id, sub.stripe_customer_id = s["id"], s.get("customer") or sub.stripe_customer_id
    sub.status = status
    if plan_key and await session.get(Plan, plan_key):
        sub.plan_key = plan_key
    sub.interval = (price.get("recurring") or {}).get("interval") or sub.interval
    sub.seats = item.get("quantity") or sub.seats
    sub.current_period_end = _ts(item.get("current_period_end") or s.get("current_period_end"))
    sub.cancel_at_period_end = bool(s.get("cancel_at_period_end") or s.get("cancel_at"))
    sub.test_mode = not s.get("livemode", True)
    if status == "canceled":
        sub.plan_key, sub.status = None, "full_access" if not settings().enforce_plans else "canceled"
        sub.stripe_subscription_id, sub.interval, sub.current_period_end, sub.cancel_at_period_end = None, None, None, False


async def _sync_invoice(session: AsyncSession, inv: dict, failed: bool = False) -> None:
    sub = await session.scalar(select(Subscription).where(Subscription.stripe_customer_id == inv.get("customer")))
    if sub is None:
        return
    pay = await session.scalar(select(Payment).where(Payment.stripe_invoice_id == inv["id"]))
    if pay is None:
        pay = Payment(institution_id=sub.institution_id, stripe_invoice_id=inv["id"], amount_cents=0, currency="usd", status="open",
                      created_at=_ts(inv.get("created")) or datetime.now(timezone.utc))
        session.add(pay)
    pay.amount_cents = inv.get("amount_paid") or inv.get("amount_due") or 0
    pay.currency = inv.get("currency") or "usd"
    status = "failed" if failed else {"paid": "paid", "void": "void", "uncollectible": "failed"}.get(inv.get("status"), "open")
    if pay.status != "paid" or status == "void":  # a late "finalized" or "failed" event never un-pays an invoice
        pay.status = status
    pay.test_mode = not inv.get("livemode", True)
    lines = ((inv.get("lines") or {}).get("data") or [])
    pay.description = (lines[0].get("description") if lines else None) or inv.get("description")
    pay.hosted_url, pay.pdf_url = inv.get("hosted_invoice_url"), inv.get("invoice_pdf")
    if failed:
        sub.status = "past_due"


@router.post("/webhook", include_in_schema=False)
async def webhook(request: Request, session: AsyncSession = Depends(get_session)):
    """Stripe's events, accepted only with a valid signature; each is safe to receive twice."""
    payload = await request.body()
    if not await run_in_threadpool(payments.verify, payload, request.headers.get("stripe-signature", "")):
        raise HTTPException(400, "invalid signature")
    event = json.loads(payload)
    kind, obj = event.get("type", ""), (event.get("data") or {}).get("object") or {}
    if kind == "checkout.session.completed" and obj.get("subscription"):
        inst = obj.get("client_reference_id")
        sub = await session.get(Subscription, inst) if inst else None
        if sub is not None:
            sub.stripe_customer_id = obj.get("customer") or sub.stripe_customer_id
            sub.stripe_subscription_id = obj["subscription"]
            await session.flush()
            await _sync_subscription(session, {"id": obj["subscription"]})
    elif kind.startswith("customer.subscription."):
        await _sync_subscription(session, obj)
    elif kind in ("invoice.paid", "invoice.finalized", "invoice.voided", "invoice.marked_uncollectible"):
        await _sync_invoice(session, obj)
    elif kind == "invoice.payment_failed":
        await _sync_invoice(session, obj, failed=True)
    await session.commit()
    return {"received": True}
