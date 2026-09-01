# Security Policy

## Reporting

Report suspected vulnerabilities through a private GitHub security advisory. Do not include real ZenTao credentials, private server URLs, or production data in an issue.

## Credential Storage

The setup script stores credentials in `~/.config/zentao-v1/credentials.json` and attempts to restrict file permissions to the current OS user. Password storage is optional and disabled by default. Without a saved password, users must run setup again after the token expires.

Use a dedicated account with the minimum required ZenTao permissions. Review every write preview before confirming it.
