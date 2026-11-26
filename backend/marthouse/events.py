"""Live job events (log lines, node status, step changes) fanned out to WebSocket clients.

LocalHub keeps everything in this process. RedisHub is used when jobs run in the hosted
worker: the worker publishes, the API process subscribes.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

FINAL = {"success", "error", "cancelled"}


class LocalHub:
    def __init__(self) -> None:
        self._events: dict[str, list[dict]] = {}
        self._subs: dict[str, set[asyncio.Queue]] = {}

    async def publish(self, job_id: str, ev: dict[str, Any]) -> None:
        self._events.setdefault(job_id, []).append(ev)
        for q in list(self._subs.get(job_id, ())):
            q.put_nowait(ev)

    async def subscribe(self, job_id: str) -> AsyncIterator[dict]:
        q: asyncio.Queue = asyncio.Queue()
        self._subs.setdefault(job_id, set()).add(q)
        try:
            for ev in list(self._events.get(job_id, [])):
                yield ev
                if ev.get("type") == "status" and ev.get("status") in FINAL:
                    return
            while True:
                ev = await q.get()
                yield ev
                if ev.get("type") == "status" and ev.get("status") in FINAL:
                    return
        finally:
            self._subs.get(job_id, set()).discard(q)

    def forget(self, job_id: str) -> None:
        self._events.pop(job_id, None)

    def has(self, job_id: str) -> bool:
        return job_id in self._events


class RedisHub:
    def __init__(self, url: str) -> None:
        import redis.asyncio as redis

        self.r = redis.from_url(url, decode_responses=True)

    async def publish(self, job_id: str, ev: dict[str, Any]) -> None:
        n = await self.r.rpush(f"job:{job_id}:events", json.dumps(ev))
        await self.r.expire(f"job:{job_id}:events", 86400)
        await self.r.publish(f"job:{job_id}", json.dumps({**ev, "seq": n - 1}))

    async def subscribe(self, job_id: str) -> AsyncIterator[dict]:
        ps = self.r.pubsub()
        await ps.subscribe(f"job:{job_id}")
        try:
            past = await self.r.lrange(f"job:{job_id}:events", 0, -1)
            n = len(past)
            for raw in past:
                ev = json.loads(raw)
                yield ev
                if ev.get("type") == "status" and ev.get("status") in FINAL:
                    return
            while True:
                msg = await ps.get_message(ignore_subscribe_messages=True, timeout=5)
                if msg is None:
                    continue
                ev = json.loads(msg["data"])
                if ev.pop("seq", n) < n:  # already sent from the replay
                    continue
                yield ev
                if ev.get("type") == "status" and ev.get("status") in FINAL:
                    return
        finally:
            await ps.unsubscribe()
            await ps.aclose()

    async def request_cancel(self, job_id: str) -> None:
        await self.r.set(f"job:{job_id}:cancel", "1", ex=3600)

    async def cancel_requested(self, job_id: str) -> bool:
        return bool(await self.r.get(f"job:{job_id}:cancel"))


_hub: LocalHub | RedisHub | None = None


def hub() -> LocalHub | RedisHub:
    global _hub
    if _hub is None:
        from .config import get_settings

        s = get_settings()
        _hub = RedisHub(s.redis_url) if (s.hosted and s.use_queue) else LocalHub()
    return _hub


def set_hub(h: LocalHub | RedisHub) -> None:
    global _hub
    _hub = h
