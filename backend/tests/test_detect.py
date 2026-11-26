import os
import stat
from pathlib import Path

import pytest

from marthouse.dbt import detect
from marthouse.oscompat import WINDOWS

# The fake dbt programs below are shell scripts, which Windows can't run.
unix_only = pytest.mark.skipif(WINDOWS, reason="shell-script fakes; Windows is covered by test_real_dbt")
DBT = os.environ.get("MARTHOUSE_TEST_DBT")


def script(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return path


VERSION_1_10 = """cat <<'X'
Core:
  - installed: 1.10.4
  - latest:    1.10.4 - Up to date!

Plugins:
  - postgres: 1.10.0 - Up to date!
  - duckdb:   1.10.1 - Up to date!
X
"""


def test_parse_version_output():
    core, adapters = detect.parse_version_output(VERSION_1_10.split("'X'\n", 1)[1])
    assert core == "1.10.4"
    assert adapters == {"postgres": "1.10.0", "duckdb": "1.10.1"}


@unix_only
def test_inspect_ok_old_fusion_and_missing(tmp_path):
    ok = detect.inspect(str(script(tmp_path / "a/bin/dbt", VERSION_1_10)), "path")
    assert ok.status == "ok" and ok.core == "1.10.4" and "postgres" in ok.adapters

    old = detect.inspect(str(script(tmp_path / "b/bin/dbt", "echo 'Core:'; echo '  - installed: 1.5.2'; echo 'Plugins:'; echo '  - postgres: 1.5.2'\n")), "brew")
    assert old.status == "too_old"

    fusion = detect.inspect(str(script(tmp_path / "c/bin/dbt", "echo 'dbt-fusion 2.0.0-preview'\n")), "path")
    assert fusion.status == "fusion"

    noad = detect.inspect(str(script(tmp_path / "d/bin/dbt", "echo 'Core:'; echo '  - installed: 1.9.0'\n")), "path")
    assert noad.status == "no_adapter"

    missing = detect.inspect(str(tmp_path / "nope/dbt"))
    assert missing.status == "broken"


@unix_only
def test_scan_project_venv_dedupes(tmp_path):
    proj = tmp_path / "proj"
    exe = script(proj / ".venv/bin/dbt", VERSION_1_10)
    os.symlink(exe, tmp_path / "link")
    seen: set[str] = set()
    found = detect.scan_location("project", [str(proj)], seen)
    assert [f.kind for f in found] == ["project"] and found[0].project == str(proj)
    assert detect.scan_location("project", [str(proj)], seen) == []  # same real path is not listed twice


def test_allowed():
    assert detect.allowed("1.10.4", ">=1.8,<2")
    assert not detect.allowed("1.7.0", ">=1.8,<2")
    assert not detect.allowed(None, ">=1.8")


@pytest.mark.skipif(not DBT, reason="set MARTHOUSE_TEST_DBT to a real dbt")
def test_real_dbt_inspect_and_project_scan():
    """A real install on this OS: finds its Python, versions and adapters (Windows: Scripts\\dbt.exe)."""
    inst = detect.inspect(DBT, "custom")
    assert inst.status == "ok", inst.note
    assert inst.core and "duckdb" in inst.adapters
    assert inst.python and Path(inst.python).exists()
    env = Path(DBT).parent.parent
    if env.name == ".venv":  # CI installs dbt into <project>/.venv, as people do
        found = detect.scan_location("project", [str(env.parent)], set())
        assert [Path(f.path).resolve() for f in found] == [Path(DBT).resolve()]
