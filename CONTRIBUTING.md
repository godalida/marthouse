# Contributing to Marthouse

Thanks for helping. Marthouse is a GUI for command-line data tools (dbt Core and dlt today), built for people who'd rather not live in a terminal. Changes that make those tools easier to use without hiding what they do are the most welcome.

## Set up

```bash
cd backend && uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -e ".[dev,hosted]"
cd ../frontend && npm install
scripts/dev-api.sh            # API on :8765 with auto-reload, data in ./.marthouse-data
cd frontend && npm run dev    # web app on :5180, proxies /api to :8765
```

## Before you open a pull request

- `cd backend && .venv/bin/python -m pytest -q` passes.
- If you touched dbt or dlt behaviour, run the end-to-end tests too. They use real tools and a local DuckDB file, with no warehouse needed:
  ```bash
  MARTHOUSE_TEST_DBT=/path/to/venv/bin/dbt MARTHOUSE_TEST_DLT_PY=/path/to/dlt-venv/bin/python .venv/bin/python -m pytest -q
  ```
- `cd frontend && npx tsc -b && npx vite build` is clean.
- UI changes come with a before/after screenshot in the PR.

## House rules

- **Show the real command.** Every action that runs dbt or dlt shows the command it ran, so people learn the tool while using the GUI.
- **Never lock files in.** Projects stay plain dbt projects and plain dlt scripts that work without Marthouse.
- **Secrets never touch disk.** They're kept in the OS keychain (local) or encrypted (hosted) and passed to dbt/dlt as environment variables.
- **Plain words in the UI.** Sentence case, short labels, no jargon where an everyday word works. The normal font for names; the code font only for code.
- **One accent colour.** Indigo is the only accent. Green, yellow and red mean pass, warn and fail, and always come with an icon or a word.

## Reporting security issues

Please don't open a public issue. Follow [SECURITY.md](SECURITY.md) to report it privately.
