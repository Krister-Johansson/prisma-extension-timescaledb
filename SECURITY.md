# Security policy

## Supported versions

`prisma-extension-timescaledb` follows semantic versioning. Security fixes are
released against the latest published version, so upgrade before reporting.

| Version        | Supported |
| -------------- | --------- |
| latest release | Yes       |
| older releases | No        |

Support covers bug fixes and security updates for the latest release only. A
release stops receiving security updates the moment a newer release is
published; there are no long-term support branches.

## Verifying a release

npm releases are published from GitHub Actions through OIDC trusted publishing
with provenance, so you can check both integrity and origin:

```bash
npm audit signatures
```

The command needs npm 9.5.0 or newer and installed dependencies
(`npm install` or `npm ci`). It verifies the registry signatures and Sigstore provenance
attestations of your installed packages, `prisma-extension-timescaledb`
included, and reports how many packages have verified attestations. You can
also inspect the provenance on the package's npm page, which shows the source
commit, workflow, and build log for each version.

The expected identity in the attestation is this repository:
`Krister-Johansson/prisma-extension-timescaledb`, built by GitHub Actions from
the release-please workflow. Treat any version whose provenance names a
different repository or builder as compromised, and report it.

Each GitHub release also carries a CycloneDX software bill of materials
(`prisma-extension-timescaledb-<version>.cdx.json`) as an asset, listing the
exact runtime dependency tree the release shipped with, along with a keyless
Sigstore signature bundle over it (`.sigstore.json`). Verify the SBOM with:

```bash
cosign verify-blob \
  --bundle prisma-extension-timescaledb-<version>.cdx.json.sigstore.json \
  --certificate-identity-regexp '^https://github.com/Krister-Johansson/prisma-extension-timescaledb/\.github/workflows/sbom\.yml@refs/tags/prisma-extension-timescaledb-v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  prisma-extension-timescaledb-<version>.cdx.json
```

The certificate identity must be this repository's sbom.yml workflow running
on a release tag; treat anything else as compromised, and report it. One
exception: releases 0.5.0 through 0.8.0 predate the signing workflow and had
their signatures backfilled by a manual run of it, so their identity ends in
`sbom.yml@refs/heads/main` instead of the tag. From the next release onward,
expect the tag form.

## Reporting a vulnerability

Do not open a public issue for security problems.

Report vulnerabilities privately through GitHub's
[Report a vulnerability](https://github.com/Krister-Johansson/prisma-extension-timescaledb/security/advisories/new)
form (repository Security → Advisories). This opens a private channel with the
maintainer.

What to expect:

- An acknowledgement within 5 business days.
- If confirmed, a fix and a coordinated-disclosure timeline. Credit is given in
  the advisory unless you prefer to remain anonymous.

## Scope

This package generates SQL migrations and runs typed queries against
TimescaleDB through Prisma. The most relevant reports concern SQL injection in
the generated SQL or the `timeBucket` query helpers, and unsafe handling of
user-supplied identifiers or values.

The published package ships only `dist/` and depends on Prisma at runtime.
Report issues in Prisma itself to the
[Prisma project](https://github.com/prisma/prisma/security).
