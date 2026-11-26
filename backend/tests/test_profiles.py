from pathlib import Path

from marthouse import profiles


ORIGINAL = """# team profiles, do not remove this comment
jaffle_shop:
  target: dev
  outputs:
    dev:
      type: postgres
      host: localhost   # local docker
      port: 5432
      user: analyst
      password: plain-text-secret
      dbname: analytics
      schema: dbt_analyst
      threads: 4
other:
  target: prod
  outputs:
    prod:
      type: duckdb
      path: x.duckdb
"""


def test_round_trip_keeps_comments_and_moves_secret(app_env, tmp_path):
    app_env()  # fresh settings + database
    from marthouse.db import SessionLocal

    f = tmp_path / "profiles.yml"
    f.write_text(ORIGINAL)
    with SessionLocal() as db:
        info = profiles.get_target(db, "local", f, "jaffle_shop", "dev")
        assert info["secrets"]["password"]["where"] == "file"
        assert "password" not in info["fields"]
        res = profiles.save_target(db, "local", f, "jaffle_shop", "dev", {"host": "db.internal", "threads": 8}, {"password": "s3cret"})
        text = f.read_text()
        assert "# team profiles, do not remove this comment" in text
        assert "# local docker" in text
        assert "s3cret" not in text and "plain-text-secret" not in text
        assert "env_var('MARTHOUSE_JAFFLE_SHOP_DEV_PASSWORD')" in text
        assert "other:" in text and "x.duckdb" in text
        assert Path(str(f) + ".bak").exists() or f.with_suffix(".yml.bak").exists()
        env = profiles.secret_env(db, "local", f)
        assert env == {"MARTHOUSE_JAFFLE_SHOP_DEV_PASSWORD": "s3cret"}
        assert "db.internal" in res["block"]
        again = profiles.get_target(db, "local", f, "jaffle_shop", "dev")
        assert again["secrets"]["password"]["stored"] is True


def test_add_rename_delete_target(app_env, tmp_path):
    app_env()
    from marthouse.db import SessionLocal

    f = tmp_path / "p" / "profiles.yml"
    with SessionLocal() as db:
        profiles.save_target(db, "local", f, "proj", "dev", {"type": "duckdb", "path": "a.duckdb"}, {}, make_default=True)
        profiles.save_target(db, "local", f, "proj", "dev", {"type": "duckdb"}, {}, rename_to="local")
        s = profiles.summary(db, "local", f, "proj")
        assert [t["name"] for t in s["profiles"][0]["targets"]] == ["local"]
        assert s["profiles"][0]["default_target"] == "local"
        profiles.delete_target(f, "proj", "local")
        assert profiles.summary(db, "local", f, "proj")["profiles"][0]["targets"] == []
