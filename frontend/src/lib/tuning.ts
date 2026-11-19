import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { API, type MlSettings } from "./api";
import type { Step } from "./query";

/** A settings test runs on the server until it finishes or someone presses Stop. This follows it from any page (progress, then
 * the results), so leaving the ML workspace never stops it; it picks the test up again after a reload too. */
export interface LiveTest {
  projectId: string;
  name: string;
  status: "running" | "stopping" | "done" | "failed" | "cancelled";
  step?: Step;
  view?: MlSettings;
  error?: string;
  /** the ML workspace has shown the outcome */
  seen: boolean;
}

const KEY = "yp-live-test";
let live: LiveTest | null = null;
let watching: string | null = null;
const listeners = new Set<() => void>();
const set = (x: LiveTest | null) => {
  live = x;
  try {
    if (x && (x.status === "running" || x.status === "stopping")) localStorage.setItem(KEY, JSON.stringify({ projectId: x.projectId, name: x.name }));
    else localStorage.removeItem(KEY);
  } catch {
    /* private window: following still works until a reload */
  }
  listeners.forEach((l) => l());
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function follow(projectId: string) {
  let fails = 0;
  while (watching === projectId) {
    try {
      const out = await API.mlWatch(projectId, (step) => {
        if (live?.projectId === projectId) set({ ...live, step, status: step.label === "Stopping the test" ? "stopping" : live.status });
      });
      fails = 0;
      if ("again" in out) continue; // a long test outlives one watch: watch again
      const t = out.test;
      const status = t && t.status !== "running" && t.status !== "stopping" ? t.status : "done";
      set({ projectId, name: out.project.name, status, view: out, error: t?.error ?? undefined, seen: false });
      if (status === "done") toast.success(`Settings test on ${out.project.name} finished`, { description: "The best settings are highlighted in the ML workspace." });
      else if (status === "failed") toast.error(`Settings test on ${out.project.name} couldn't finish`, { description: t?.error ?? undefined });
      break;
    } catch (e) {
      if ((e as { status?: number }).status === 403 || (e as { status?: number }).status === 404 || ++fails > 6) {
        set(null);
        break;
      }
      await pause(1500 * fails); // a dropped connection: the test keeps going on the server, so just watch again
    }
  }
  if (watching === projectId) watching = null;
}

export const tuning = {
  get: () => live,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  /** Follow this prediction's running test (nothing happens if it's already followed). */
  follow(projectId: string, name: string, step?: Step) {
    if (watching === projectId) return;
    watching = projectId;
    set({ projectId, name, status: "running", step, seen: false });
    void follow(projectId);
  },
  stopping(projectId: string) {
    if (live?.projectId === projectId) set({ ...live, status: "stopping", step: live.step && { ...live.step, label: "Stopping the test" } });
  },
  seen(projectId: string) {
    if (live?.projectId === projectId && live.status !== "running" && live.status !== "stopping") set({ ...live, seen: true });
  },
  dismiss() {
    if (live && live.status !== "running" && live.status !== "stopping") set(null);
  },
  /** After a reload: pick up a test that was running. */
  resume() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as { projectId: string; name: string } | null;
      if (saved?.projectId) tuning.follow(saved.projectId, saved.name);
    } catch {
      /* nothing to resume */
    }
  },
};

export const useTuning = () => useSyncExternalStore(tuning.subscribe, tuning.get, tuning.get);
