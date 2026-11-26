# Changelog

All notable changes to Marthouse are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-27

### Added

- **Windows support.** Marthouse finds and installs dbt and dlt in Windows environments (`Scripts\dbt.exe`), looks in Windows locations for pipx, uv and conda, uses the Windows folder picker, and can reveal files in Explorer and open a terminal in the project.
- CI runs the tests on Windows, macOS and Linux, plus end-to-end dbt and dlt runs on Windows and Linux.

### Fixed

- Installing from source (`pip install -e backend`) works again.

### Changed

- Files are always read and written as UTF-8, and dbt and dlt are asked to print UTF-8, so non-English text survives on every OS.
- Git tokens for private repositories are passed through Git's environment configuration, limited to the repository's host, instead of a temporary helper script.

## [0.1.1] - 2026-11-27

### Fixed

- The PyPI page now shows the README, project links and categories.

## [0.1.0] - 2026-11-26

First public release.

### Added

- **dbt:** finds dbt on your machine or installs a private copy with uv; models editor with Jinja highlighting, compiled SQL and row previews; lineage graph with dbt selectors and impact; runs with a live node timeline and plain-word errors; tests and coverage; docs and catalog; source freshness; connections that write `profiles.yml`, with secrets in the keychain.
- **dlt:** pipelines from REST APIs, SQL databases, files and buckets, or dltHub verified sources; schema, loads and incremental state; dbt sources generated from a pipeline; pipelines shown in the lineage graph; "load then build" in one step.
- **Model builder:** filter, join, calculate, group and sort with rows shown after every step; saves a normal dbt model.
- **SQL scratchpad** with `ref()` and `source()`, query history, CSV download and "Save as model".
- **Docs and tests without YAML**, and a staging-model generator.
- **Schedules** with webhook alerts on failure.
- **Team mode (self-hosted):** accounts, workspaces, roles, Git checkouts, a job worker over Redis, and Docker Compose.

[Unreleased]: https://github.com/godalida/marthouse/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/godalida/marthouse/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/godalida/marthouse/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/godalida/marthouse/releases/tag/v0.1.0
