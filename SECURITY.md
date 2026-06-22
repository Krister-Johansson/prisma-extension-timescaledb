# Security Policy

## Supported versions

`prisma-extension-timescaledb` follows semantic versioning. Security fixes are
released against the **latest published version** — please upgrade before reporting.

| Version          | Supported |
| ---------------- | --------- |
| latest release   | ✅        |
| older releases   | ❌        |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub's
[**Report a vulnerability**](https://github.com/Krister-Johansson/prisma-extension-timescaledb/security/advisories/new)
form (repository **Security → Advisories**). This opens a private channel with the
maintainer.

What to expect:

- An acknowledgement within **5 business days**.
- If confirmed, a fix and a coordinated-disclosure timeline. Credit is given in the
  advisory unless you prefer to remain anonymous.

## Scope

This package generates SQL migrations and runs typed queries against TimescaleDB
through Prisma. The most relevant reports concern **SQL injection in the generated SQL
or `timeBucket` query helpers**, and unsafe handling of user-supplied identifiers or
values.

The published package ships only `dist/` and depends on Prisma at runtime — please
report issues in Prisma itself to the [Prisma project](https://github.com/prisma/prisma/security).
