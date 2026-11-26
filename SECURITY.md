# Security policy

## Supported versions

Marthouse is in early release. Security fixes go into the latest release only.

| Version | Supported |
|---|---|
| 0.1.x | Yes |

## Reporting a vulnerability

Please **don't open a public issue** for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include:

- what an attacker could do, and in which mode (local or hosted);
- steps to reproduce, or a proof of concept;
- the Marthouse version, and your dbt and dlt versions if they matter.

You'll get a reply within a week. Once a fix is released, we'll credit you in the changelog unless you'd rather stay anonymous.

## What's in scope

- **Local mode:** anything that lets a website, another local user or another process drive Marthouse, read secrets or run commands. Examples: DNS rebinding, CSRF, a launch-token bypass.
- **Hosted mode:** crossing workspace boundaries, getting around roles, reading another user's secrets or project files, and escaping the job worker.
- **Secrets:** a warehouse password, API token or Git token written to disk in plain text, logged, or sent to the browser.

Out of scope: problems in dbt, dlt or an adapter themselves (report those to their projects), and running untrusted dbt projects in local mode. A dbt project is code; open only projects you trust.
