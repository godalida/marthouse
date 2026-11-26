"""The few places where Windows and macOS/Linux differ.

A Python environment keeps its programs in `bin/` on macOS and Linux, and in `Scripts\\` on
Windows, where they also end in `.exe`.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

WINDOWS = sys.platform == "win32"
BIN = "Scripts" if WINDOWS else "bin"


def exe(name: str) -> str:
    """A program's file name on this OS: `dbt` or `dbt.exe`."""
    return f"{name}.exe" if WINDOWS else name


def venv_bin(root: str | Path, name: str) -> Path:
    """A program inside a Python environment: `<root>/bin/dbt` or `<root>\\Scripts\\dbt.exe`."""
    return Path(root) / BIN / exe(name)


def venv_glob(base: str | Path, name: str) -> str:
    """Glob for a program in every environment directly under `base`."""
    return str(Path(base) / "*" / BIN / exe(name))


def path_dirs() -> list[str]:
    """This process's PATH, split the way this OS separates it."""
    return [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]


def env_python(program: str | Path) -> str | None:
    """The Python next to a program, for launchers that don't name it (Windows .exe launchers).

    In an environment it is `Scripts\\python.exe` beside the program; in a base install the
    program is in `<python>\\Scripts` and Python is one level up.
    """
    d = Path(program).parent
    for cand in (d / exe("python"), d.parent / exe("python")):
        if cand.exists():
            return str(cand)
    return None


def rel(path: Path, base: Path) -> str:
    """A path relative to `base`, always with forward slashes, as the web app expects."""
    return path.relative_to(base).as_posix()
