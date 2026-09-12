/* SFERA Lab — client-side, consent-gated telemetry machinery (§2.B funnel stage names).
 *
 * HONEST STATE (EXECUTION_003): the current public surface has NO central telemetry.
 * There is no analytics service and no server. This module implements the canonical
 * stage-event interface (traffic_in → birth_start → calc_complete → reading_consumed)
 * with a pluggable sink that is NULL by default: events are kept in page memory for the
 * session only and are discarded when the tab closes. If a zero-cost research storage
 * backend is ever authorized, `sink` is the single integration point, and only
 * consent-gated, non-identifying events would ever reach it — PRIVACY_LAB.md is
 * updated first, always.
 *
 * Hard rules (standing, EXECUTION_000 §2.B):
 *   - every event beyond traffic_in requires explicit consent in this session;
 *   - payloads NEVER contain birth data, free-text questions, IP, user agent, or
 *     anything identifying — stage names, coarse src tag, and engine flags only;
 *   - telemetry never feeds interpretation (enforced by never exposing these events
 *     to the engine — see sfera_engine.js, which computes only).
 */
(function (root) {
  "use strict";
  var CONSENT_KEY = "sfera_lab_consent";

  function readConsent() {
    try {
      var raw = root.localStorage.getItem(CONSENT_KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      return (v && typeof v.consent === "boolean") ? v : null;
    } catch (e) { return null; }
  }

  function sanitizeSrc(value) {
    if (!value) return "direct";
    var s = String(value).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
    return s || "direct";
  }

  var telemetry = {
    sink: null, // set to function(event, payload) by an authorized research backend only
    consentRecord: readConsent(),
    src: (function () {
      var m = ((root.location && root.location.search) || "").match(/[?&]src=([^&]*)/);
      return sanitizeSrc(m ? m[1] : null);
    })(),
    events: [], // session memory only

    consented: function () {
      return !!(this.consentRecord && this.consentRecord.consent === true);
    },

    setConsent: function (value) {
      this.consentRecord = { consent: !!value, ts: new Date().toISOString() };
      try {
        if (value) root.localStorage.setItem(CONSENT_KEY, JSON.stringify(this.consentRecord));
        else root.localStorage.removeItem(CONSENT_KEY);
      } catch (e) { /* storage unavailable (private mode): session-only then */ }
    },

    /* traffic_in is the only stage recorded without the consent box — and on this
     * surface "recorded" still means page memory only. No IP, no user agent. */
    trackTrafficIn: function () {
      this.track("traffic_in", { src: this.src }, true);
    },

    track: function (event, payload, isTrafficIn) {
      if (!isTrafficIn && !this.consented()) return;
      var rec = { event: event, ts: new Date().toISOString(), src: this.src };
      for (var k in (payload || {})) rec[k] = payload[k];
      this.events.push(rec);
      if (this.sink && (isTrafficIn || this.consented())) {
        try { this.sink(event, rec); } catch (e) { /* sink errors never break the tool */ }
      }
      return rec;
    }
  };

  root.SFERA_TELEMETRY = telemetry;
})(window);
