/* SFERA Lab — client-side, consent-gated telemetry v2 (§2.B funnel, EXECUTION_004).
 *
 * CHANGE vs v1 (EXECUTION_003): an authorized central sink may now exist (a minimal
 * Cloudflare Worker + D1 research store, deployed only with explicit founder
 * authorization; one founder action, €0). `window.SFERA_TELEMETRY_CONFIG.sinkUrl` is
 * null until that deploy lands — with a null sink this module stays exactly as honest
 * as v1: events live in page memory and die with the tab.
 *
 * Consent model (single rule, no exceptions):
 *   - WITHOUT the consent box: nothing is transmitted — not even the fact of a visit.
 *     Events still exist client-side (page memory) so the tool can honestly tell the
 *     visitor what WOULD be measured; they are never sent.
 *   - WITH consent: consent-gated, non-identifying events go to the sink.
 *
 * Payload minimization (EXECUTION_000 §2.B + EXECUTION_004 Part 3 — reviewed field by
 * field; everything not listed here is deliberately absent):
 *   event, ts, sid (random per-tab session id), vid (random persistent id, created
 *   ONLY after consent; deletable by un-ticking consent or clearing site data),
 *   src (canonical family), src_raw (sanitized tag ≤60), wave, class (traffic class:
 *   HUMAN_LIKELY | BOT_LIKELY | INTERNAL_QA | UNKNOWN), lang, device (mobile|desktop),
 *   v (site client version), d (small per-event payload; see D-SHAPE below).
 *
 *   NEVER transmitted, by construction: birth date, birth time, birth place string,
 *   coordinates, timezone, natal positions, chart JSON, the free-text question, IP
 *   (the sink is configured to not store it either), user agent string, fingerprints.
 *
 * Telemetry never feeds interpretation: nothing in this module is reachable from the
 * calculation engine (sfera_engine.js computes only).
 *
 * READING_CONSUMED definition (versioned methodology, READING_CONSUMED_DEF=v1):
 * the reading section of a successfully rendered result was scrolled into the visitor's
 * viewport (≥40% visible, cumulative ≥3 s), OR the visitor kept the page visible and
 * foreground for ≥20 s after the result rendered. Render alone never counts.
 */
(function (root) {
  "use strict";

  var CONSENT_KEY = "sfera_lab_consent";
  var SID_KEY = "sfera_lab_sid";
  var VID_KEY = "sfera_lab_vid";
  var SEEN_KEY = "sfera_lab_seen";

  var cfg = root.SFERA_TELEMETRY_CONFIG || {};
  var SINK_URL = cfg.sinkUrl || null;          // set only by an authorized deploy
  var WAVE_DEFAULT = cfg.wave || "001";
  var CLIENT_VERSION = cfg.clientVersion || "0.4.0";

  var SRC_FAMILIES = ["direct", "bio", "reddit", "telegram", "instagram", "tiktok",
    "x", "facebook", "personal", "practitioner", "ai-share", "share", "other"];
  var SRC_TOKEN_MAP = { tg: "telegram", ig: "instagram", tt: "tiktok", fb: "facebook" };

  function randomId() {
    try {
      if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
      var b = new Uint8Array(16); root.crypto.getRandomValues(b);
      return Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    } catch (e) {
      return "r" + String(root.Math.random()).slice(2) + String(Date.now());
    }
  }

  function readJSON(store, key) {
    try {
      var raw = store.getItem(key);
      if (!raw) return null;
      var v = JSON.parse(raw);
      return (v && typeof v === "object") ? v : null;
    } catch (e) { return null; }
  }

  function sanitizeSrc(value) {
    if (!value) return { raw: "direct", family: "direct" };
    var s = String(value).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || "direct";
    var family;
    if (/^qa/i.test(s)) family = "qa";
    else if (s.indexOf("ai-share") === 0) family = "ai-share";
    else {
      var token = s.split("-")[0].toLowerCase();
      token = SRC_TOKEN_MAP[token] || token;
      family = SRC_FAMILIES.indexOf(token) !== -1 ? token : "other";
    }
    return { raw: s, family: family };
  }

  function params() {
    try { return new root.URL(root.location.href).searchParams; }
    catch (e) { return { get: function () { return null; } }; }
  }

  function classify() {
    try {
      if (navigator.webdriver) return "BOT_LIKELY";
      var ua = navigator.userAgent || "";
      if (/bot|crawl|spider|slurp|headless|phantom|puppeteer|playwright|python-requests|curl\/|wget|httrack|monitor|lighthouse/i.test(ua)) return "BOT_LIKELY";
      var p = params();
      if (p.get("qa") === "1") return "INTERNAL_QA";
      return "HUMAN_LIKELY";
    } catch (e) { return "UNKNOWN"; }
  }

  function deviceClass() {
    try {
      var coarse = root.matchMedia && root.matchMedia("(pointer: coarse)").matches;
      var small = root.matchMedia && root.matchMedia("(max-width: 768px)").matches;
      return (coarse || small) ? "mobile" : "desktop";
    } catch (e) { return "unknown"; }
  }

  var telemetry = {
    consentRecord: readJSON(root.localStorage, CONSENT_KEY),
    srcInfo: sanitizeSrc(params().get("src")),
    wave: (function () {
      var w = String(params().get("wave") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20);
      return w || WAVE_DEFAULT;
    })(),
    trafficClass: classify(),
    device: deviceClass(),
    lang: (document.documentElement && document.documentElement.lang) || "en",
    queue: [],            // unsent, consented events
    sessionEvents: [],    // in-memory ring (last 30) regardless of consent — never leaves the page
    _fired: {},           // once-per-load flags
    READING_CONSUMED_DEF: "v1_scroll_or_dwell",

    sid: (function () {
      try {
        var s = root.sessionStorage.getItem(SID_KEY);
        if (!s) { s = randomId(); root.sessionStorage.setItem(SID_KEY, s); }
        return s;
      } catch (e) { return randomId(); } // private mode: ephemeral id, not stored
    })(),

    visitorId: (function () {
      try { return root.localStorage.getItem(VID_KEY); } catch (e) { return null; }
    })(),

    consented: function () {
      return !!(this.consentRecord && this.consentRecord.consent === true);
    },

    setConsent: function (value) {
      this.consentRecord = { consent: !!value, ts: new Date().toISOString() };
      try {
        if (value) {
          root.localStorage.setItem(CONSENT_KEY, JSON.stringify(this.consentRecord));
          if (!this.visitorId) {
            this.visitorId = randomId();
            root.localStorage.setItem(VID_KEY, this.visitorId);
          }
        } else {
          // Deletion mechanism: withdrawing consent erases the visitor id locally.
          root.localStorage.removeItem(CONSENT_KEY);
          root.localStorage.removeItem(VID_KEY);
          root.localStorage.removeItem(SEEN_KEY);
          this.visitorId = null;
        }
      } catch (e) { /* storage unavailable: session-only */ }
      if (value) {
        // Mid-session consent: the visit itself becomes sendable from that moment on.
        if (!this._trafficQueued) { this._trafficQueued = true; this._push("traffic_in", {}); this._maybeReturnVisit(); }
        this.flush();
      }
    },

    _push: function (event, d) {
      var rec = {
        event: event,
        ts: new Date().toISOString(),
        sid: this.sid,
        src: this.srcInfo.family,
        src_raw: this.srcInfo.raw,
        wave: this.wave,
        class: this.trafficClass,
        lang: this.lang,
        device: this.device,
        v: CLIENT_VERSION
      };
      if (this.consented() && this.visitorId) rec.vid = this.visitorId;
      if (d) rec.d = d;
      this.sessionEvents.push(rec);
      if (this.sessionEvents.length > 30) this.sessionEvents.shift();

      if (!SINK_URL) return rec;                    // honest v1 behavior: nowhere to send
      if (!this.consented()) return rec;            // nothing is sent without consent
      this.queue.push(rec);
      this._scheduleFlush();
      return rec;
    },

    /* traffic_in: recorded in page memory unconditionally; SENT only under the same
     * consent rule as everything else (disclosed on /privacy). */
    trackTrafficIn: function () {
      var rec = this._push("traffic_in", {});
      if (this.queue.length && rec.event === "traffic_in") this._trafficQueued = true;
      if (this.consented() && this.visitorId) this._maybeReturnVisit();
    },

    _maybeReturnVisit: function () {
      try {
        var now = Date.now(), seen = readJSON(root.localStorage, SEEN_KEY);
        if (seen && seen.last) {
          var gapH = (now - seen.last) / 3600000;
          if (gapH >= 24) {
            var gap = gapH < 48 ? "1d" : gapH < 24 * 8 ? "2-7d" : gapH < 24 * 31 ? "8-30d" : "30d+";
            this._push("return_visit", { gap: gap });
          }
        }
        var next = { first: (seen && seen.first) || now, last: now };
        root.localStorage.setItem(SEEN_KEY, JSON.stringify(next));
      } catch (e) { /* storage unavailable */ }
    },

    track: function (event, d) {
      if (!this.consented()) {
        // keep session-memory copy for transparency/debug; never queued
        this._push(event, d);
        return null;
      }
      return this._push(event, d);
    },

    /* Page-context stage events (fired from the shared script; static pages have no
     * inline scripts by CSP). */
    trackPageContext: function () {
      var p = root.location.pathname;
      if (/about\.html$/.test(p)) this.trackOnce("methodology_opened", {});
      else if (/x01z\.html$/.test(p)) this.trackOnce("research_note_opened", {});
    },

    trackOnce: function (event, d) {
      if (this._fired[event]) return;
      this._fired[event] = 1;
      return this.track(event, d);
    },

    /* READING_CONSUMED_DEF=v1 — called by app.js; the two honest triggers: */
    markReadingSeen: function (how) {
      var dwell = this._renderedAt ? Math.round((Date.now() - this._renderedAt) / 1000) : null;
      return this.trackOnce("reading_consumed", { how: how, dwell_s: dwell, rule: this.READING_CONSUMED_DEF });
    },
    markRendered: function () { this._renderedAt = Date.now(); },

    shareTool: function (target, method) {
      return this.track("share_tool", { tgt: target === "text" ? "text" : "link", m: method === "webshare" ? "webshare" : "clipboard" });
    },

    feedback: function (answers) {
      function cut(s, n) {
        s = String(s || "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
        return s.slice(0, n);
      }
      return this.track("feedback_submit", {
        a1: cut(answers.a1, 12), a2: cut(answers.a2, 500), a3: cut(answers.a3, 500),
        a4: cut(answers.a4, 12), a5: cut(answers.a5, 500)
      });
    },

    /* ---------------------------------------------------------------- transport */

    _flushTimer: null,
    _scheduleFlush: function () {
      if (this._flushTimer) return;
      var self = this;
      this._flushTimer = setTimeout(function () { self._flushTimer = null; self.flush(); }, 4000);
    },

    flush: function () {
      if (!SINK_URL || !this.consented() || !this.queue.length) return;
      var batch = this.queue.splice(0, 50);
      var body = JSON.stringify({ v: CLIENT_VERSION, events: batch });
      try {
        if (navigator.sendBeacon &&
            navigator.sendBeacon(SINK_URL, new Blob([body], { type: "text/plain;charset=UTF-8" }))) return;
      } catch (e) { /* fall through */ }
      try {
        fetch(SINK_URL, { method: "POST", body: body, keepalive: true,
          headers: { "Content-Type": "application/json" }, credentials: "omit", mode: "cors" })
          .catch(function () { /* research-grade: no retry storm; next event re-flushes */ });
      } catch (e) { /* never break the tool over telemetry */ }
    }
  };

  // flush when the tab hides/closes
  try {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") telemetry.flush();
    });
    root.addEventListener("pagehide", function () { telemetry.flush(); });
  } catch (e) { /* old engine */ }

  root.SFERA_TELEMETRY = telemetry;
})(window);
