"""dbt project folders: validation, file tree, safe file access, scaffolding and Git."""
from __future__ import annotations

import base64
import os
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

from ruamel.yaml import YAML

SKIP_DIRS = {"target", "dbt_packages", "dbt_modules", "logs", ".git", ".venv", "venv", "node_modules", "__pycache__", ".idea", ".vscode"}
TEXT_EXT = {".sql", ".yml", ".yaml", ".md", ".csv", ".py", ".txt", ".json", ".toml", ".cfg", ".gitignore", ".sqlfluff", ""}
BINARY_EXT = {".duckdb", ".db", ".sqlite", ".wal", ".parquet", ".pyc", ".zip", ".png", ".jpg", ".gif", ".ico"}
_yaml = YAML(typ="safe")


class ProjectError(ValueError):
    pass


def read_project_yml(root: str | Path) -> dict:
    f = Path(root) / "dbt_project.yml"
    if not f.is_file():
        raise ProjectError("This folder has no dbt_project.yml, so it isn't a dbt project.")
    try:
        data = _yaml.load(f.read_text(encoding="utf-8")) or {}
    except Exception as e:
        raise ProjectError(f"dbt_project.yml couldn't be read: {e}") from e
    return data


def info(root: str | Path) -> dict:
    root = Path(root)
    if not (root / "dbt_project.yml").is_file() and (root / "pipelines").is_dir():
        # a pipelines-only project: dlt without dbt
        return {"name": root.name, "profile": "", "version": "", "model_paths": [], "seed_paths": [], "macro_paths": [],
                "test_paths": [], "snapshot_paths": [], "target_path": "target", "n_models": 0, "has_dbt": False, "has_dlt": True}
    data = read_project_yml(root)
    model_paths = data.get("model-paths") or data.get("source-paths") or ["models"]
    n_models = sum(1 for mp in model_paths for _ in (root / mp).rglob("*.sql")) if model_paths else 0
    return {
        "name": data.get("name", root.name),
        "profile": data.get("profile", data.get("name", "")),
        "version": str(data.get("version", "")),
        "model_paths": model_paths,
        "seed_paths": data.get("seed-paths", ["seeds"]),
        "macro_paths": data.get("macro-paths", ["macros"]),
        "test_paths": data.get("test-paths", ["tests"]),
        "snapshot_paths": data.get("snapshot-paths", ["snapshots"]),
        "target_path": data.get("target-path", "target"),
        "n_models": n_models,
        "has_dbt": True,
        "has_dlt": (root / "pipelines").is_dir(),
    }


def safe_path(root: str | Path, rel: str) -> Path:
    base = Path(root).resolve()
    p = (base / rel.lstrip("/")).resolve()
    if p != base and base not in p.parents:
        raise ProjectError("That path is outside the project.")
    return p


def tree(root: str | Path) -> list[dict]:
    base = Path(root)

    def walk(d: Path) -> list[dict]:
        items = []
        try:
            entries = sorted(d.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return items
        for p in entries:
            if p.name in SKIP_DIRS or (p.name.startswith(".") and p.name not in (".sqlfluff", ".gitignore")):
                continue
            rel = p.relative_to(base).as_posix()
            if p.is_file() and p.suffix.lower() in BINARY_EXT:
                continue
            if p.is_dir():
                items.append({"name": p.name, "path": rel, "dir": True, "children": walk(p)})
            else:
                items.append({"name": p.name, "path": rel, "dir": False})
        return items

    return walk(base)


def read_file(root: str | Path, rel: str) -> dict:
    p = safe_path(root, rel)
    if not p.is_file():
        raise ProjectError("File not found.")
    if p.stat().st_size > 2_000_000:
        raise ProjectError("File is larger than 2 MB.")
    try:
        text = p.read_text(encoding="utf-8")
    except UnicodeDecodeError as e:
        raise ProjectError("Binary file.") from e
    return {"path": rel, "content": text, "mtime": p.stat().st_mtime}


def write_file(root: str | Path, rel: str, content: str) -> dict:
    p = safe_path(root, rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return {"path": rel, "mtime": p.stat().st_mtime}


def delete_file(root: str | Path, rel: str) -> None:
    p = safe_path(root, rel)
    if p.is_file():
        p.unlink()


def rename_file(root: str | Path, rel: str, new_rel: str) -> None:
    src, dst = safe_path(root, rel), safe_path(root, new_rel)
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)


def stale_files(root: str | Path) -> list[str]:
    """Project files edited after the last manifest was written."""
    root = Path(root)
    try:
        i = info(root)
    except ProjectError:
        return []
    if not i["has_dbt"]:
        return []
    manifest = root / i["target_path"] / "manifest.json"
    if not manifest.exists():
        return ["(never parsed)"]
    m = manifest.stat().st_mtime
    out = []
    dirs = i["model_paths"] + i["seed_paths"] + i["macro_paths"] + i["test_paths"] + i["snapshot_paths"]
    for d in dirs:
        for p in (root / d).rglob("*"):
            if p.is_file() and p.suffix in (".sql", ".yml", ".yaml", ".csv", ".py") and p.stat().st_mtime > m:
                out.append(p.relative_to(root).as_posix())
    if (root / "dbt_project.yml").stat().st_mtime > m:
        out.append("dbt_project.yml")
    return sorted(out)


SCAFFOLD = {
    "dbt_project.yml": """name: '{name}'
version: '1.0.0'
profile: '{name}'

model-paths: ["models"]
analysis-paths: ["analyses"]
test-paths: ["tests"]
seed-paths: ["seeds"]
macro-paths: ["macros"]
snapshot-paths: ["snapshots"]

clean-targets:
  - "target"
  - "dbt_packages"

models:
  {name}:
    staging:
      +materialized: view
    marts:
      +materialized: table
""",
    "models/staging/_sources.yml": """version: 2

sources:
  - name: raw
    description: Raw tables loaded into the warehouse.
    tables: []
""",
    "models/marts/.gitkeep": "",
    "seeds/.gitkeep": "",
    "macros/.gitkeep": "",
    "tests/.gitkeep": "",
    "snapshots/.gitkeep": "",
    "analyses/.gitkeep": "",
    ".gitignore": "target/\ndbt_packages/\nlogs/\n.venv/\n*.duckdb\npipelines/.dlt-data/\npipelines/.dlt/secrets.toml\n",
    "pipelines/.gitkeep": "",
    "README.md": "# {name}\n\nA dbt project made with Marthouse.\n",
}


def scaffold_pipelines_only(parent: str | Path, name: str) -> Path:
    root = Path(parent).expanduser() / name
    if root.exists() and any(root.iterdir()):
        raise ProjectError(f"{root} already exists and isn't empty.")
    (root / "pipelines").mkdir(parents=True)
    (root / "pipelines" / ".gitignore").write_text(".dlt-data/\n.dlt/secrets.toml\n*.duckdb\n", encoding="utf-8")
    (root / "README.md").write_text(f"# {name}\n\nData pipelines made with Marthouse (dlt).\n", encoding="utf-8")
    return root


def scaffold(parent: str | Path, name: str) -> Path:
    import re

    if not re.fullmatch(r"[a-z_][a-z0-9_]*", name):
        raise ProjectError("Use lowercase letters, numbers and underscores, starting with a letter.")
    root = Path(parent).expanduser() / name
    if root.exists() and any(root.iterdir()):
        raise ProjectError(f"{root} already exists and isn't empty.")
    for rel, text in SCAFFOLD.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text.format(name=name), encoding="utf-8")
    return root


# ---------- Git ----------

def _git(root: str | Path, *args: str, env: dict | None = None, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                          env={**os.environ, "GIT_TERMINAL_PROMPT": "0", **(env or {})})


def git_info(root: str | Path) -> dict | None:
    if not (Path(root) / ".git").exists():
        r = _git(root, "rev-parse", "--is-inside-work-tree")
        if r.returncode != 0:
            return None
    branch = _git(root, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    status = _git(root, "status", "--porcelain").stdout.splitlines()
    remote = _git(root, "remote", "get-url", "origin").stdout.strip()
    ahead = _git(root, "rev-list", "--count", "@{u}..HEAD")
    behind = _git(root, "rev-list", "--count", "HEAD..@{u}")
    return {
        "branch": branch,
        "changed": [{"status": l[:2].strip(), "path": l[3:]} for l in status],
        "remote": remote,
        "ahead": int(ahead.stdout.strip() or 0) if ahead.returncode == 0 else 0,
        "behind": int(behind.stdout.strip() or 0) if behind.returncode == 0 else 0,
    }


def _askpass_env(token: str | None, url: str) -> tuple[dict, str | None]:
    """Give Git a token through environment-variable config (Git 2.31+), on every OS.

    The token never appears in the URL, the process list or a file, and isn't saved in the
    repository's config. It is scoped to the repository's host, so a redirect elsewhere never
    receives it. Basic auth with the `x-access-token` user works for GitHub tokens and
    GitLab/Bitbucket access tokens alike.
    """
    u = urlsplit(url)
    if not token or u.scheme not in ("http", "https") or not u.hostname:
        return {}, None  # SSH remotes use the user's SSH keys instead
    origin = f"{u.scheme}://{u.hostname}{f':{u.port}' if u.port else ''}"
    basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    return {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": f"http.{origin}/.extraHeader",
            "GIT_CONFIG_VALUE_0": f"Authorization: Basic {basic}", "GIT_TERMINAL_PROMPT": "0"}, None


def git_clone(url: str, dest: str | Path, branch: str = "", token: str | None = None) -> None:
    env, tmp = _askpass_env(token, url)
    try:
        args = ["clone", "--depth", "50"]
        if branch:
            args += ["--branch", branch]
        r = _git(Path(dest).parent, *args, url, str(dest), env=env, timeout=300)
        if r.returncode != 0:
            raise ProjectError(r.stderr.strip() or "git clone failed")
    finally:
        if tmp:
            os.unlink(tmp)


def git_pull(root: str | Path, token: str | None = None) -> str:
    env, tmp = _askpass_env(token, _git(root, "remote", "get-url", "origin").stdout.strip())
    try:
        r = _git(root, "pull", "--ff-only", env=env, timeout=120)
        if r.returncode != 0:
            raise ProjectError(r.stderr.strip() or "git pull failed")
        return r.stdout.strip()
    finally:
        if tmp:
            os.unlink(tmp)


def git_commit_push(root: str | Path, message: str, author: str = "", token: str | None = None, push: bool = True) -> str:
    _git(root, "add", "-A")
    args = ["commit", "-m", message]
    if author:
        args = ["-c", f"user.name={author.split('<')[0].strip()}", "-c", f"user.email={author.split('<')[-1].rstrip('>').strip()}", *args]
    r = _git(root, *args)
    if r.returncode != 0 and "nothing to commit" not in r.stdout:
        raise ProjectError(r.stderr.strip() or r.stdout.strip())
    if not push:
        return r.stdout.strip()
    env, tmp = _askpass_env(token, _git(root, "remote", "get-url", "origin").stdout.strip())
    try:
        p = _git(root, "push", env=env, timeout=120)
        if p.returncode != 0:
            raise ProjectError(p.stderr.strip() or "git push failed")
        return (r.stdout + p.stderr).strip()
    finally:
        if tmp:
            os.unlink(tmp)
