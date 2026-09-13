# Build provenance

This site is the public surface of SFERA Lab (research prototype), built by
`tools/build_public_site.py` in the private lab repository.

- build date: 2026-09-13 (2026-09-13T07:05:37Z)
- languages: RU (default, canonical root) + EN mirrors under /en/ (founder hot patch,
  EXECUTION_004); localization layer: web/site/i18n/site-*.json (build-time) +
  i18n/app-*.json (runtime); calculation engine is language-free
- engine: sfera-western-js 0.1.0-js.1 (browser port of sfera-western 0.1.0)
- place resolution: bundled list + Open-Meteo Geocoding API (GeoNames, CC-BY 4.0;
  keyless, CORS-restricted by CSP to that host) + manual lat/lon/IANA-tz fallback
- telemetry: client SDK consent-gated; sink URL at build time: null (honest NO_SINK state)
- claim audit: PASS (prohibited claims checked: 3; languages scanned: RU + EN)
- verification record: verification/results_differential_js_2026-09-13.json
- all lab-status numbers derive from repository objects at build time;
  public-validation numbers render only from a real sink export, never as invented zeros
