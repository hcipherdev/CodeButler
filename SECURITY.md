# Security Policy

Please do not publish security-sensitive reports in public issues.

To report a vulnerability, use GitHub private vulnerability reporting from the
repository's Security tab. Include a concise description, affected versions,
reproduction steps, and any relevant logs with secrets removed.

Code Butler stores project memory in a project-local `.code-butler/` directory.
Do not commit real `.code-butler/config.json`, `.code-butler/.env`, SQLite
database files, imported conversation logs, API keys, or other local memory
state to public repositories.
