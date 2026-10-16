# Security Policy

`agc-analytics-mcp` handles Huawei AppGallery Connect credentials and business data. This document
describes the threat model, the guarantees the code enforces, and how to report a problem.

## Reporting a vulnerability

Open a private security advisory on the repository (Security → Advisories → New draft advisory), or
open an issue that contains **no credentials, tokens, appIds or data samples**. Please include the
affected version, a minimal reproduction, and the impact you believe it has.

## What this server can and cannot do

The tool surface is deliberately read-only:

- No publishing, uploading, package association, review replies, deletions or configuration changes.
- `agc_request` is a read-only passthrough limited to these path prefixes:
  `/api/report/`, `/api/apm/`, `/api/project-service/v1/projects`, `/api/publish/v2/appid-list`,
  `/api/publish/v2/app-info`, `/api/marketing-api/v2/reviews/manage/dev/{reviews,ratings}`,
  `/api/reviews/v1/manage/dev/{reviews,ratings}`.
- `PUT`, `PATCH` and `DELETE` are rejected outright. Review and app-info paths accept `GET` only, so
  the write forms of those endpoints are unreachable even through the passthrough.

## Credential handling

- Credentials are read once from the environment (`AGC_CLIENT_ID`/`AGC_CLIENT_SECRET`,
  `AGC_CLIENT_FILE`, `AGC_SERVICE_ACCOUNT_FILE`) into process memory.
- Nothing is ever written to disk: no token cache file, no settings file, no log file.
- Access tokens and Service-Account JWTs are cached **in memory only**, expired five minutes early.
- All error messages and diagnostics pass through `src/redact.js`, which removes `client_secret`,
  `clientSecret`, `access_token`, `private_key` and `Bearer …` shapes before anything is returned to
  the model or written to stderr.

## Network egress

- Authenticated requests are pinned to the four AGC hosts — `connect-api.cloud.huawei.com`,
  `connect-api-dre.cloud.huawei.com`, `connect-api-dra.cloud.huawei.com`,
  `connect-api-drru.cloud.huawei.com` — and must use HTTPS (`src/sites.js#assertAgcHost`). Any other
  host is refused before a socket is opened, which also blocks SSRF through model-supplied paths.
- The `path` argument of `agc_request` is reduced to its pathname and the URL is always rebuilt from
  the configured site, so an absolute URL in the argument cannot redirect a credential-bearing
  request.
- `AGC_BASE_URL` is the one documented way to point the client elsewhere (a corporate gateway, or a
  loopback mock for integration tests). It is validated at load time: HTTPS is mandatory unless the
  host is a loopback address; an invalid value is reported by `agc_auth_status` and ignored in favour
  of the official site. A loopback base URL relaxes the host check for loopback addresses only.
- Report downloads (`fileURL`) are pre-signed URLs: credentials are **not** attached, HTTPS is
  required, only Huawei-owned hosts are accepted, and the payload is capped at 200 MB.

## Data handling

- Report rows, review text and crash metrics are processed in memory and returned to the MCP client;
  they are not sent anywhere else and are not persisted unless the caller explicitly passes
  `outPath`.
- `outPath` writes are explicit, create parent directories, and refuse to overwrite an existing file
  unless `overwrite: true` is passed.

## Supply chain

- `package.json` declares no `dependencies` and no `devDependencies`; the MCP stdio protocol subset
  is implemented directly (`src/mcp-server.js`) instead of pulling in an SDK.
- There are no install scripts (`preinstall`/`postinstall`) and no build step, so `npx` execution
  runs only the code in this repository.
- `scripts/check-secrets.mjs` scans the tree for committed credentials and runs in CI.

## What is out of scope

- Compromise of the machine or the MCP client itself.
- AGC-side authorisation: the server can only do what the configured credential is allowed to do.
  Grant the credential the minimum role it needs.
- Data already exposed by an over-broad AGC API-key role.
- The security of third-party MCP clients that read tool output.

## Hardening recommendations

1. Create a dedicated AGC API client for this tool rather than reusing a broad key.
2. Keep credential JSON files outside the repository with restrictive filesystem permissions.
3. Prefer the Service Account credential where it suffices; use the API client only for the review
   endpoints that require it.
