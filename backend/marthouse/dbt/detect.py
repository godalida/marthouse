"""Find dbt installations on this machine.

Looks in the places people actually install dbt, reads each one's versions without
touching the network, and says whether Lineage can use it.
"""
from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path

from packaging.specifiers import SpecifierSet
from packaging.version import InvalidVersion, Version

from ..config import get_settings
from ..oscompat import WINDOWS, env_python, exe, path_dirs, venv_bin, venv_glob

MIN_VERSION = Version("1.8")

PROBE = (
    "import json, importlib.metadata as m\n"
    "out = {}\n"
    "for d in m.distributions():\n"
    "    n = (d.metadata['Name'] or '').lower().replace('_', '-')\n"
    "    skip = ('dbt-extractor', 'dbt-semantic-interfaces', 'dbt-common', 'dbt-adapters', 'dbt-protos', 'dbt-osmosis')\n"
    "    if n == 'dbt-core' or (n.startswith('dbt-') and not n.startswith('dbt-core-') and n not in skip):\n"
    "        out[n] = d.version\n"
    "print(json.dumps(out))\n"
)

KIND_LABEL = {
    "project": "Project environment",
    "path": "On your PATH",
    "pipx": "pipx",
    "uv": "uv tool",
    "brew": "Homebrew",
    "conda": "conda",
    "private": "Marthouse's private copy",
    "custom": "Chosen by you",
}


@dataclass
class Location:
    id: str
    label: str
    detail: str


@dataclass
class Install:
    path: str
    kind: str
    label: str
    core: str | None = None
    adapters: dict[str, str] = field(default_factory=dict)
    python: str | None = None
    status: str = "ok"  # ok|too_old|fusion|broken|no_adapter
    note: str = ""
    project: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def login_shell_path() -> list[str]:
    """PATH as the user's login shell sees it (a GUI-launched process gets a short PATH).

    Windows has no login shell; the process's own PATH is the user's PATH there.
    """
    paths: list[str] = []
    if not WINDOWS:
        shell = os.environ.get("SHELL", "/bin/zsh")
        try:
            out = subprocess.run([shell, "-lc", 'printf %s "$PATH"'], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=6).stdout
            paths += [p for p in out.split(":") if p]
        except Exception:
            pass
    paths += path_dirs()
    seen: set[str] = set()
    return [p for p in paths if not (p in seen or seen.add(p))]


def locations(project_dirs: list[str] | None = None) -> list[Location]:
    home = Path.home()
    locs = [
        Location("project", "Project folders", ", ".join(Path(p).name for p in (project_dirs or [])) or ".venv and venv in recent projects"),
        Location("path", "Your PATH" if WINDOWS else "Your shell's PATH", "the PATH environment variable" if WINDOWS else "read from your login shell"),
        Location("pipx", "pipx and uv tools", str(home / "pipx") if WINDOWS else str(home / ".local")),
        *([] if WINDOWS else [Location("brew", "Homebrew", "/opt/homebrew and /usr/local")]),
        Location("conda", "conda environments", "miniforge, miniconda, anaconda"),
        Location("private", "Marthouse's private copy", str(get_settings().private_dbt_dir)),
    ]
    return locs


def _candidates(loc: str, project_dirs: list[str]) -> list[tuple[str, str | None]]:
    home = Path.home()
    out: list[tuple[str, str | None]] = []

    def add(pattern: str, project: str | None = None) -> None:
        for p in sorted(glob.glob(pattern)):
            out.append((p, project))

    if loc == "project":
        for d in project_dirs:
            for venv in (".venv", "venv", "env"):
                add(str(venv_bin(Path(d) / venv, "dbt")), d)
    elif loc == "path":
        for d in login_shell_path():
            add(str(Path(d) / exe("dbt")))
    elif loc == "pipx" and WINDOWS:
        appdata, local = os.environ.get("APPDATA", ""), os.environ.get("LOCALAPPDATA", "")
        add(str(home / ".local/bin/dbt.exe"))
        add(venv_glob(home / "pipx/venvs", "dbt"))
        if local:
            add(venv_glob(Path(local) / "pipx/pipx/venvs", "dbt"))
        if appdata:
            add(venv_glob(Path(appdata) / "uv/tools", "dbt"))
            add(str(Path(appdata) / "Python/Python3*/Scripts/dbt.exe"))
    elif loc == "conda" and WINDOWS:
        for base in ("miniforge3", "miniconda3", "anaconda3", "mambaforge"):
            add(str(home / base / "Scripts/dbt.exe"))
            add(venv_glob(home / base / "envs", "dbt"))
    elif loc == "pipx":
        add(str(home / ".local/bin/dbt"))
        add(str(home / ".local/pipx/venvs/*/bin/dbt"))
        add(str(home / ".local/share/pipx/venvs/*/bin/dbt"))
        add(str(home / ".local/share/uv/tools/*/bin/dbt"))
    elif loc == "brew":
        add("/opt/homebrew/bin/dbt")
        add("/usr/local/bin/dbt")
        add("/opt/homebrew/opt/*/libexec/bin/dbt")
    elif loc == "conda":
        for base in ("miniforge3", "miniconda3", "anaconda3", "mambaforge", "opt/miniconda3", "opt/anaconda3"):
            add(str(home / base / "bin/dbt"))
            add(str(home / base / "envs/*/bin/dbt"))
    elif loc == "private":
        add(venv_glob(get_settings().private_dbt_dir, "dbt"))
    return out


def _shebang_python(exe: str) -> str | None:
    try:
        with open(exe, "rb") as f:
            head = f.read(512)
    except OSError:
        return None
    if not head.startswith(b"#!"):
        return None
    line = head.splitlines()[0][2:].decode(errors="replace").strip()
    if line.startswith("/bin/sh"):
        # pip's long-path launcher: '#!/bin/sh\n'''exec' "/path/python" "$0" "$@"
        for l in head.decode(errors="replace").splitlines()[1:3]:
            if "exec'" in l and '"' in l:
                return l.split('"')[1]
        return None
    parts = line.split()
    if parts and parts[0].endswith("/env") and len(parts) > 1:
        return shutil.which(parts[1])
    return parts[0] if parts else None


def inspect(exe: str, kind: str = "custom", project: str | None = None) -> Install:
    inst = Install(path=exe, kind=kind, label=KIND_LABEL.get(kind, kind), project=project)
    if not os.access(exe, os.X_OK):
        inst.status, inst.note = "broken", "File is missing or not executable"
        return inst
    py = _shebang_python(exe) or env_python(exe)
    if py and os.path.exists(py):
        inst.python = py
        try:
            r = subprocess.run([py, "-c", PROBE], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20)
            pkgs = json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 and r.stdout.strip() else {}
        except Exception:
            pkgs = {}
        inst.core = pkgs.pop("dbt-core", None)
        inst.adapters = {k.removeprefix("dbt-"): v for k, v in sorted(pkgs.items())}
    if inst.core is None:
        # Not a Python launcher (or the probe failed): ask the binary.
        try:
            r = subprocess.run([exe, "--version"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
            text = r.stdout + r.stderr
        except Exception as e:
            inst.status, inst.note = "broken", f"Could not run: {e}"
            return inst
        if "fusion" in text.lower():
            inst.status, inst.note = "fusion", "dbt Fusion engine. Marthouse works with dbt Core."
            return inst
        inst.core, inst.adapters = parse_version_output(text)
        if inst.core is None:
            inst.status, inst.note = "broken", "dbt didn't report a version"
            return inst
    try:
        if Version(inst.core) < MIN_VERSION:
            inst.status, inst.note = "too_old", f"Older than {MIN_VERSION}, so Marthouse won't use it"
            return inst
    except InvalidVersion:
        pass
    if not inst.adapters:
        inst.status, inst.note = "no_adapter", "dbt is here but no warehouse adapter is installed"
    return inst


def parse_version_output(text: str) -> tuple[str | None, dict[str, str]]:
    core: str | None = None
    adapters: dict[str, str] = {}
    section = None
    for raw in text.splitlines():
        line = raw.strip()
        low = line.lower()
        if low.startswith("core:"):
            section = "core"
            continue
        if low.startswith("plugins:"):
            section = "plugins"
            continue
        if line.startswith("- "):
            body = line[2:]
            if section == "core" and body.startswith("installed:"):
                core = body.split(":", 1)[1].strip().split()[0]
            elif section == "plugins" and ":" in body:
                name, rest = body.split(":", 1)
                adapters[name.strip()] = rest.strip().split()[0]
        elif low.startswith("installed version:"):  # dbt < 1.5 style
            core = line.split(":", 1)[1].strip()
    return core, adapters


def scan_location(loc: str, project_dirs: list[str], seen: set[str]) -> list[Install]:
    found: list[Install] = []
    for exe, project in _candidates(loc, project_dirs):
        try:
            real = os.path.realpath(exe)
        except OSError:
            continue
        if real in seen:
            continue
        seen.add(real)
        found.append(inspect(exe, loc, project))
    return found


def scan(project_dirs: list[str] | None = None) -> list[Install]:
    seen: set[str] = set()
    out: list[Install] = []
    for loc in locations(project_dirs):
        out += scan_location(loc.id, project_dirs or [], seen)
    return out


def allowed(version: str | None, spec: str) -> bool:
    if not version:
        return False
    try:
        return Version(version) in SpecifierSet(spec or ">=1.8")
    except Exception:
        return True
