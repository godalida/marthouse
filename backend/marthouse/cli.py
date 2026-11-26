"""`lineage` starts the local app and opens it in your browser."""
from __future__ import annotations

import argparse
import os
import threading
import webbrowser


def main() -> None:
    ap = argparse.ArgumentParser(prog="marthouse", description="A GUI for dbt Core and dlt.")
    ap.add_argument("--port", type=int, default=int(os.environ.get("MARTHOUSE_PORT", 8765)))
    ap.add_argument("--no-browser", action="store_true", help="Don't open the browser")
    ap.add_argument("--hosted", action="store_true", help="Run in hosted (multi-user) mode")
    ap.add_argument("--host", default=None, help="Address to listen on (hosted mode)")
    args = ap.parse_args()

    os.environ["MARTHOUSE_PORT"] = str(args.port)
    if args.hosted:
        os.environ["MARTHOUSE_MODE"] = "hosted"
    from .config import get_settings

    s = get_settings()
    host = args.host or ("0.0.0.0" if s.hosted else "127.0.0.1")
    if not s.hosted and host not in ("127.0.0.1", "localhost"):
        raise SystemExit("Local mode only listens on 127.0.0.1. Use --hosted for a shared server.")

    import uvicorn

    if not s.hosted:
        url = f"http://127.0.0.1:{s.port}/launch?token={s.launch_token}"
        print(f"\n  Marthouse is running. Open:\n  {url}\n\n  Press Ctrl+C to stop.\n", flush=True)
        if not args.no_browser:
            threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    uvicorn.run("marthouse.main:app", host=host, port=s.port, log_level="warning" if not s.hosted else "info",
                proxy_headers=s.hosted)


if __name__ == "__main__":
    main()
