"""Forecast training runs, shared by every request that needs the same one.

Runs only start from the Run button, and every Run trains the model again from scratch (same settings or not).
Starting a run stops any unfinished run of the same prediction. The run saves its model and predictions under its own
key, so recording the forecast afterwards is a single database write, and deleting the forecast deletes the files.

Training happens in a separate worker process. Inside the web server the same model trained 3-4x slower (85 s vs
22 s on the same data and CPUs, measured): the server's own threads and memory get in its way. The worker reads the
data from storage itself, so only keys and settings cross over; progress and the cancel signal come back through a pipe.
"""

import asyncio
import logging
import multiprocessing as mp
import os
import resource
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable

from .. import engine
from ..engine import recipe as _recipe, whatif  # noqa: F401  (engine.recipe used by the trainer)
from .cache import key as ckey, memo
from .store import write_artifact, write_frame

log = logging.getLogger("yieldpilot.runs")
KEEP = 3600  # a finished run stays ready for an hour


class Cancelled(Exception):
    """The settings changed: a newer run for the same prediction replaced this one."""


@dataclass
class Run:
    project: str = ""
    institution: str = ""
    kind: str = "forecast"  # forecast | tuning (a settings test from the ML workspace)
    cancelled: bool = False
    pct: float = 0.0
    label: str = "Starting"
    detail: str = ""
    result: dict | None = None
    error: str | None = None
    done: threading.Event = field(default_factory=threading.Event)
    finished: float = 0.0

    def progress(self, pct: float, label: str | None = None, detail: str = "") -> None:
        if self.cancelled:
            raise Cancelled()  # raised inside training, so a replaced run stops within a second
        self.pct = max(self.pct, pct)
        if label is not None:
            self.label = label
        self.detail = detail


_runs: dict[str, Run] = {}
_lock = threading.Lock()
# One training at a time per server: two at once share the CPUs and each takes several times longer (measured).
_slot = threading.Semaphore(1)
_waiting = [0]  # forecasts waiting for the trainer: a settings test lets them go first between its candidates


# ------------------------------------------------------------------------------------------ worker process


def _cpu_seconds() -> float:
    """CPU time this process has used so far, on every core (the trainer runs one job at a time, so a difference is one run's)."""
    r = resource.getrusage(resource.RUSAGE_SELF)
    return r.ru_utime + r.ru_stime


def _rss_mb() -> float:
    try:
        with open("/proc/self/statm") as f:
            return int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 2**20
    except Exception:  # not Linux: the process's peak so far (measuring never stops a run)
        try:
            return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (2**20 if sys.platform == "darwin" else 2**10)
        except Exception:
            return 0.0


class _Peak:
    """Samples memory four times a second while a run trains."""

    def __init__(self):
        self.peak, self._stop = _rss_mb(), threading.Event()
        threading.Thread(target=self._watch, daemon=True).start()

    def _watch(self):
        while not self._stop.wait(0.25):
            self.peak = max(self.peak, _rss_mb())

    def stop(self) -> float:
        self._stop.set()
        return round(max(self.peak, _rss_mb()), 1)


def _worker(conn, stop) -> None:
    """The training process: receives (data key, ID-map key, spec), sends progress lines and the result back."""
    import warnings

    warnings.filterwarnings("ignore")
    from .store import _read_parquet

    frames: dict[str, object] = {}
    send_lock = threading.Lock()

    def frame(key: str):
        if key not in frames:
            if len(frames) >= 4:
                frames.clear()
            frames[key] = _read_parquet(key)
        return frames[key]

    def send(*msg) -> None:
        with send_lock:  # progress arrives from several training threads
            conn.send(msg)

    print(f"trainer ready: {_cpu_report()}", flush=True)  # what this instance really gives us, for the logs

    current = [0]
    while True:
        job = conn.recv()
        if job is None:
            return
        jid, data_key, idmap_key, spec = job
        current[0] = jid
        first = spec[0] if isinstance(spec, list) else spec

        def progress(pct: float, label: str, detail: str = "", jid=jid) -> None:
            # a cancelled job's training threads stop at their next step, even after a new job has started
            if stop.is_set() or current[0] != jid:
                raise Cancelled()
            send(jid, "progress", pct, label, detail)

        try:
            progress(0.5, "Preparing your data")
            df = frame(data_key)
            order = None
            if idmap_key and first.student_id in df.columns:  # the real IDs, to order training rows like the lab
                idm = frame(idmap_key)
                order = df[first.student_id].map(dict(zip(idm["token"], idm["value"])))
            if isinstance(spec, list):  # a settings test: each candidate learns from earlier terms and is scored on a known one
                results = []
                for i, s in enumerate(spec):
                    def step(pct, label, detail="", i=i, n=len(spec)):
                        progress(100 * (i + pct / 100) / n, f"Testing settings {i + 1} of {n}", label)
                    t1 = time.time()
                    summary, _, students = engine.run(df, s, step, order)
                    results.append(engine.recipe.tune_result(summary, students, time.time() - t1))
                send(jid, "done", results)
                continue
            t0, cpu, c0, peak = time.time(), _cpu_report(), _cpu_seconds(), _Peak()
            try:
                result = engine.run(df, spec, progress, order)
            finally:
                top = peak.stop()
            result[0]["compute"] = {"cpu_seconds": round(_cpu_seconds() - c0, 1), "peak_memory_mb": top, "train_seconds": round(time.time() - t0, 1)}
            print(f"trained {len(df):,} rows in {time.time() - t0:.1f}s ({cpu})", flush=True)
            send(jid, "done", result)
        except Cancelled:
            send(jid, "cancelled")
        except ValueError as e:
            send(jid, "error", str(e))
        except Exception:
            logging.getLogger("yieldpilot.runs").exception("training failed")
            send(jid, "error", "The forecast couldn't finish. Please try again.")


def _cpu_report() -> str:
    """CPUs visible, the container's CPU quota, and single-core speed (a fixed loop, in ms)."""
    import os

    quota = "?"
    for path in ("/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/cpu/cpu.cfs_quota_us"):
        try:
            quota = open(path).read().strip()
            break
        except OSError:
            pass
    t = time.perf_counter()
    x = 0
    for i in range(3_000_000):
        x += i
    loop_ms = (time.perf_counter() - t) * 1000
    affinity = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else "?"
    return f"cpus={os.cpu_count()} affinity={affinity} quota={quota} loop={loop_ms:.0f}ms fold_threads={engine.recipe.FOLD_THREADS}"


_proc = None
_conn = None
_stop = None


def _ensure_worker():
    global _proc, _conn, _stop
    if _proc is None or not _proc.is_alive():
        ctx = mp.get_context("spawn")  # a clean interpreter: nothing inherited from the server's threads
        _conn, child = ctx.Pipe()
        _stop = ctx.Event()
        _proc = ctx.Process(target=_worker, args=(child, _stop), name="yieldpilot-trainer", daemon=True)
        _proc.start()
    return _conn, _stop


def warm() -> None:
    """Start the training process ahead of the first run (its imports take a few seconds)."""
    try:
        with _slot:
            _ensure_worker()
    except Exception:
        log.exception("couldn't start the training process")


_jobs = iter(range(1, 10**12))


def _fit(r: Run, data_key: str, idmap_key: str | None, spec: engine.Spec, shown: Callable[[float, str, str], tuple] | None = None):
    conn, stop = _ensure_worker()
    jid = next(_jobs)
    stop.clear()
    conn.send((jid, data_key, idmap_key, spec))
    while True:
        if r.cancelled:
            stop.set()
        if not conn.poll(0.2):
            if not _proc.is_alive():
                raise RuntimeError("the training process stopped")
            continue
        mid, kind, *rest = conn.recv()
        if mid != jid:  # left over from a cancelled job
            continue
        if kind == "progress":
            pct, label, detail = shown(*rest) if shown else (rest[0] * 0.95, rest[1], rest[2])
            r.pct, r.label, r.detail = max(r.pct, pct), label, detail
        elif kind == "done":
            return rest[0]
        elif kind == "cancelled":
            raise Cancelled()
        else:
            raise ValueError(rest[0])


def _train(r: Run, data_key: str, idmap_key: str | None, spec: engine.Spec, base: str) -> dict:
    if not _slot.acquire(blocking=False):
        r.progress(0, "Waiting for another forecast to finish")
        with _lock:
            _waiting[0] += 1
        try:
            while not _slot.acquire(timeout=0.5):
                r.progress(0)  # raises if this run was cancelled while it waited
        finally:
            with _lock:
                _waiting[0] -= 1
    try:
        summary, art, students = _fit(r, data_key, idmap_key, spec)
        r.progress(95, "Saving the forecast")
        model_key, predictions_key = f"{base}/model.joblib", f"{base}/predictions.parquet"
        write_frame(predictions_key, students)
        write_artifact(model_key, art)
        memo(ckey("levers", model_key), lambda: whatif.levers(art))  # instant; the what-if scores load with the Scenarios page
    finally:
        _slot.release()
    return {"summary": summary, "model_key": model_key, "predictions_key": predictions_key}


def _tune(r: Run, data_key: str, idmap_key: str | None, specs: list) -> dict:
    """A settings test: one candidate at a time, letting any forecast that's waiting go first between them (a Run never waits
    minutes behind a test)."""
    results, n = [], len(specs)
    for i, spec in enumerate(specs):
        while True:
            with _lock:
                free = _waiting[0] == 0
            if free and _slot.acquire(timeout=0.5):
                break
            r.progress(r.pct, "Letting a forecast finish first" if not free else "Waiting for another forecast to finish")
        try:
            def shown(pct, label, detail, i=i):
                return 100 * (i + pct / 100) / n * 0.98, f"Testing settings {i + 1} of {n}", detail
            results += _fit(r, data_key, idmap_key, [spec], shown)
        finally:
            _slot.release()
    return {"tuning": results}


def active(institution_id: str) -> int:
    """Runs still going for this institution, so they count toward its plan before they finish."""
    with _lock:
        return sum(1 for r in _runs.values() if r.institution == institution_id and not r.done.is_set())


def cancel(project_id: str, kind: str = "forecast") -> bool:
    """Stop this prediction's unfinished forecast (or settings test): it stops within a second. A forecast and a test never stop each other."""
    with _lock:
        hit = [r for r in _runs.values() if r.project == project_id and r.kind == kind and not r.done.is_set()]
        for r in hit:
            r.cancelled = True
    return bool(hit)


def start(institution_id: str, project_id: str, data_key: str, idmap_key: str | None, spec: engine.Spec) -> Run:
    """A new training run in a background thread. A forecast stops any other unfinished forecast of the same prediction (its
    settings changed); a settings test (a list of specs) runs until it finishes or its Stop button is pressed."""
    kind = "tuning" if isinstance(spec, list) else "forecast"
    key = f"{institution_id}/runs/{uuid.uuid4().hex}"
    with _lock:
        now = time.time()
        for k in [k for k, x in _runs.items() if x.done.is_set() and now - x.finished > KEEP]:
            del _runs[k]
        for other in _runs.values():
            if kind == "forecast" and other.kind == "forecast" and other.project == project_id and not other.done.is_set():
                other.cancelled = True
        r = _runs[key] = Run(project=project_id, institution=institution_id, kind=kind)

    def go():
        try:
            r.result = _tune(r, data_key, idmap_key, spec) if isinstance(spec, list) else _train(r, data_key, idmap_key, spec, key)
            r.progress(100, "Done")
        except Cancelled:
            r.error = "The run was stopped."
        except ValueError as e:
            r.error = str(e)
        except Exception:
            log.exception("forecast run failed")
            r.error = "The forecast couldn't finish. Please try again."
        finally:
            r.finished = time.time()
            r.done.set()

    threading.Thread(target=go, name=f"run-{key[-8:]}", daemon=True).start()
    return r


async def wait(r: Run, progress: Callable[..., None] | None = None) -> dict:
    while not r.done.is_set():
        if progress:
            progress(r.pct, r.label, r.detail)
        await asyncio.sleep(0.1)
    if r.error:
        raise ValueError(r.error)
    return r.result
