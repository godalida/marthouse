import os

import pytest

os.environ["PYTHON_KEYRING_BACKEND"] = "keyring.backends.fail.Keyring"


@pytest.fixture
def app_env(tmp_path, monkeypatch):
    """A fresh app (settings, database) per test. Use mode='hosted' via monkeypatch before calling make()."""
    from marthouse import config, db, events

    def make(mode="local", **env):
        monkeypatch.setenv("MARTHOUSE_MODE", mode)
        monkeypatch.setenv("MARTHOUSE_DATA_DIR", str(tmp_path / "data"))
        for k, v in env.items():
            monkeypatch.setenv(f"MARTHOUSE_{k.upper()}", str(v))
        config.get_settings.cache_clear()
        db.reset_engine()
        events._hub = None
        from fastapi.testclient import TestClient

        from marthouse.main import create_app

        return TestClient(create_app())

    yield make
    config.get_settings.cache_clear()
    db.reset_engine()
