"""Settings read from the environment (prefix MARTHOUSE_)."""
from __future__ import annotations

import secrets
from functools import lru_cache
from pathlib import Path
from typing import Literal

from platformdirs import user_data_dir
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MARTHOUSE_", env_file=".env", extra="ignore")

    mode: Literal["local", "hosted"] = "local"
    host: str = "127.0.0.1"
    port: int = 8765
    data_dir: Path = Path(user_data_dir("Marthouse", appauthor=False))
    database_url: str = ""  # default: sqlite file in data_dir

    # Local mode: the browser must present this token once (it is put in the launch URL).
    # Set MARTHOUSE_NO_TOKEN=1 for development with the Vite dev server.
    no_token: bool = False
    launch_token: str = secrets.token_urlsafe(24)
    extra_hosts: str = ""  # comma-separated host:port values also accepted (dev servers)

    # Hosted mode
    secret_key: str = ""  # Fernet key for encrypting secrets; generated into data_dir if empty
    public_url: str = "http://localhost:8765"
    cookie_secure: bool = False
    redis_url: str = "redis://localhost:6379"
    use_queue: bool = False  # hosted: run jobs in the arq worker instead of the API process
    job_timeout_s: int = 3600

    update_feed_url: str = ""  # JSON {"version": "x.y.z", "url": "..."} for app updates

    @property
    def hosted(self) -> bool:
        return self.mode == "hosted"

    @property
    def db_url(self) -> str:
        return self.database_url or f"sqlite:///{self.data_dir / 'marthouse.db'}"

    @property
    def private_dbt_dir(self) -> Path:
        return self.data_dir / "dbt"

    @property
    def workspaces_dir(self) -> Path:
        return self.data_dir / "workspaces"


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.data_dir.mkdir(parents=True, exist_ok=True)
    return s
