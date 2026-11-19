import { useSyncExternalStore } from "react";

/*
 * The signed-in user, remembered per browser so a reload doesn't flash the login page.
 * The session itself is the backend's httpOnly cookie; every other piece of state lives on the server.
 */

interface State {
  user: { email: string; name: string } | null;
}

let key = "yieldpilot:session";
let state: State = { user: null };
const listeners = new Set<() => void>();

function set(next: State) {
  state = next;
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* storage blocked: stay in memory */
  }
  listeners.forEach((l) => l());
}

export function initStore(appKey: string) {
  key = `${appKey}:session`;
  try {
    state = { user: JSON.parse(localStorage.getItem(key) ?? "{}").user ?? null };
  } catch {
    state = { user: null };
  }
}

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => select(state),
    () => select({ user: null }),
  );
}

export const store = {
  get: () => state,
  signIn(email: string, name?: string) {
    set({ user: { email, name: name || email.split("@")[0] } });
  },
  signOut() {
    set({ user: null });
  },
};
