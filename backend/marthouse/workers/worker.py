"""Hosted job worker: `arq marthouse.workers.worker.WorkerSettings`.

Runs user dbt code away from the API process. In production run one worker container per job
(or a small pool with strict limits); see docker/ for an example.
"""
from __future__ import annotations

from arq import cron
from arq.connections import RedisSettings

from ..config import get_settings
from ..db import init_db
from ..jobs import execute


async def run_job(ctx, job_id: str) -> None:  # noqa: ANN001
    await execute(job_id)


async def schedules(ctx) -> None:  # noqa: ANN001
    from ..scheduler import tick

    await tick()


async def startup(ctx) -> None:  # noqa: ANN001
    init_db()


class WorkerSettings:
    functions = [run_job]
    cron_jobs = [cron(schedules, second=0)]
    on_startup = startup
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
    job_timeout = get_settings().job_timeout_s + 60
    max_jobs = 4
