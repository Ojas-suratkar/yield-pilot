"""In-memory memo for analyses that are pure functions of a data version (or model) and its mapping.

Data versions are immutable, so a cached result never goes stale; it only ages out of the LRU.
"""

import json
import threading
from collections import OrderedDict
from typing import Any, Callable

_store: "OrderedDict[str, Any]" = OrderedDict()
_lock = threading.Lock()
MAX = 256


def key(*parts) -> str:
    return json.dumps(parts, sort_keys=True, default=str)


def memo(k: str, fn: Callable[[], Any]) -> Any:
    with _lock:
        if k in _store:
            _store.move_to_end(k)
            return _store[k]
    value = fn()
    with _lock:
        _store[k] = value
        while len(_store) > MAX:
            _store.popitem(last=False)
    return value
