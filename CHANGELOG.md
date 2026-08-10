# Changelog

## 0.8.1 - 2026-08-10

### Fixed

- Re-inject the capture relay and MAIN-world hook at navigation commit so APIs
  fired by the next document's initialization code are observed before
  `DOMContentLoaded`.
- Keep the completed-navigation injection as an idempotent fallback for browser
  timing differences.
- Add a real Chromium regression for an API request started synchronously from
  the destination document's `<head>`.
- Prefer a same-origin top-frame API over noisier third-party SDK traffic when
  choosing the collection host.
- Keep safely omitted large responses selected by default instead of treating
  them as empty acknowledgements.
- Ignore timestamp-shaped jQuery `_` cache busters so they do not become
  required Planflow inputs.

## 0.8.0 - 2026-08-10

### Added

- Browser fetch/XHR capture, privacy-safe HAR, OpenAPI, GraphQL introspection,
  Postman Collection, manual contract, and MCP Station inputs for XGEN API Collections.
- Collection preview, readiness, semantic quality, search, plan, execute, and actual
  `APICollectionLoader -> Agent Xgen` workflow acceptance checks against dev XGEN.
- Real Chromium verification for capture, registration, permissions, tab isolation,
  auth profile resolution, navigation reinjection, and failure artifacts.

### Changed

- Capture sessions now use an explicit lifecycle with ACK handling and MV3 service
  worker restart recovery while persisting metadata only.
- Page context and collection authentication are isolated by tab and API origin.
- Host and cookie access are optional, origin-scoped permissions instead of broad
  install-time grants.

### Security

- Validate untrusted page events, normalize captured URLs, cap captured bodies at
  100 KiB, and record binary/SSE/worker coverage limitations explicitly.
- Scrub sensitive request data and keep raw tokens, cookies, user identifiers, and
  payload values out of persisted capture metadata and verification output.
- Resolve the transitive `nanoid` build dependency advisory; `npm audit` reports
  zero known vulnerabilities for this release.
