import { useEffect, useSyncExternalStore } from "react";
import { store } from "@yield/core";
import { API, DEV_AUTH, type Me } from "./api";
import { dropQueries } from "./query";

/*
 * The session is the backend's httpOnly cookie; this mirrors who it belongs to. Every app load asks the
 * server (/me) instead of trusting the browser, so an expired or revoked session lands on the login page.
 */

export const ROLES = ["viewer", "analyst", "data_manager", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

type Session = { status: "loading" | "in" | "out"; me: Me | null };
const ME = "yieldpilot:me";
function cachedMe(): Me | null {
  try {
    return typeof window === "undefined" ? null : (JSON.parse(localStorage.getItem(ME) ?? "null") as Me | null);
  } catch {
    return null;
  }
}
const remember = (me: Me | null) => {
  try {
    if (me) localStorage.setItem(ME, JSON.stringify(me));
    else localStorage.removeItem(ME);
  } catch {
    /* storage blocked */
  }
};
// Paint at once as the last signed-in user; the server check below confirms or signs out within one request.
let session: Session = cachedMe() ? { status: "in", me: cachedMe() } : { status: "loading", me: null };
let checked = false;
const listeners = new Set<() => void>();
const set = (s: Session) => {
  session = s;
  listeners.forEach((l) => l());
};

export async function refreshSession(): Promise<Me | null> {
  try {
    const me = await API.me();
    store.signIn(me.email, me.name ?? undefined);
    remember(me);
    set({ status: "in", me });
    return me;
  } catch {
    store.signOut();
    remember(null);
    set({ status: "out", me: null });
    return null;
  }
}

export function useSession(): Session {
  const s = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => session,
    () => session,
  );
  useEffect(() => {
    if (!checked) {
      checked = true;
      void refreshSession();
    }
  }, []);
  return s;
}

export const setMe = (me: Me) => (remember(me), set({ status: "in", me }));
export const can = (me: Me | null, role: Role) => !!me && ROLES.indexOf(me.role as Role) >= ROLES.indexOf(role);

export async function signOut() {
  if (!DEV_AUTH) await fetch("/api/auth/logout", { method: "POST", redirect: "manual" }).catch(() => undefined);
  store.signOut();
  remember(null);
  dropQueries("");
  set({ status: "out", me: null });
}

/** The page someone was headed to when asked to sign in; they land there afterwards. Same-site paths only. */
const NEXT = "yp:next";
export function rememberPage(path: string) {
  try {
    if (path.startsWith("/") && !path.startsWith("//") && path !== "/") sessionStorage.setItem(NEXT, path);
  } catch {
    /* storage blocked: they land on Home */
  }
}
export function pendingPage(): string | null {
  try {
    const p = sessionStorage.getItem(NEXT);
    return p && p.startsWith("/") && !p.startsWith("//") ? p : null;
  } catch {
    return null;
  }
}
export function forgetPage() {
  try {
    sessionStorage.removeItem(NEXT);
  } catch {
    /* storage blocked */
  }
}
