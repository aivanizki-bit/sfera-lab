/* SFERA LAB — deterministic Western astrology calculation engine, browser port.
 * Engine id: sfera-western-js · version 0.1.0-js.1 · schema 1.0
 *
 * This is a JS port of engine/sfera_engine.py (sfera-western 0.1.0), produced for the
 * static public surface (EXECUTION_003). Design rules, inherited from the Python kernel:
 *   - compute only, never interpret (the static reading template is the sole text layer);
 *   - suppression, not approximation (unknown birth time → no Moon degree, no angles,
 *     no houses);
 *   - every convention is disclosed (tropical zodiac, orb set v0.1, house system labeled);
 *   - the port is differentially verified against the Python kernel on a frozen fixture;
 *     the committed verification record (engine/tests/results_differential_js_*.json) is
 *     the proof of agreement. Engine-vs-engine agreement is NOT proof of truth.
 *
 * Differences vs the Python kernel (all labeled, none silent):
 *   - positions: official astronomy-engine JS port, SAME library version 2.1.19 as the
 *     verified Python layer (vendor: web/site/js/astronomy.browser.min.js, sha256
 *     f41139a87941ea017ab902b954c9389fa27ea72083d7fab4971756d7769d14e6);
 *   - timezone history: the browser/Node IANA database via Intl (vs Python zoneinfo) —
 *     identical tzdb lineage; offsets are verified to the second in the fixture;
 *   - houses: ASC/MC/Placidus computed by native formulas here (the Python kernel gets
 *     them from pyswisseph). Koch/Regiomontanus/Campanus are NOT implemented in this
 *     port; the browser surface offers placidus/equal/whole_sign only, labeled as such;
 *   - nodes: MEAN node via the analytic secular formula (Meeus). The TRUE (osculating)
 *     node requires the Layer-B library and is suppressed here, never approximated.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./astronomy.browser.min.js"));
  else root.SferaEngine = factory(root.Astronomy);
})(typeof self !== "undefined" ? self : this, function (Astro) {
  "use strict";

  var ENGINE_ID = "sfera-western-js";
  var ENGINE_VERSION = "0.1.0-js.1";
  var SCHEMA_VERSION = "1.0";
  var TEMPLATE_VERSION = "static-template-v0.1";
  var ZODIAC = "tropical";

  var SIGNS = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
    "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"];

  var BODIES = ["sun", "moon", "mercury", "venus", "mars", "jupiter", "saturn",
    "uranus", "neptune", "pluto"];

  var ASPECT_ANGLES = { conjunction: 0.0, sextile: 60.0, square: 90.0, trine: 120.0, opposition: 180.0 };

  var DEFAULT_CONFIG = {
    zodiac: "tropical",
    house_system: "placidus",
    orbs_natal: { conjunction: 8.0, sextile: 5.0, square: 7.0, trine: 7.0, opposition: 8.0 },
    orbs_transit: { conjunction: 3.0, sextile: 2.0, square: 3.0, trine: 3.0, opposition: 3.0 },
    orbs_to_angles: 5.0,
    config_version: "orbs-v0.1"
  };

  var HOUSE_SYSTEMS_JS = { placidus: true, equal: true, whole_sign: true };

  function BirthTimeError(message) { this.name = "BirthTimeError"; this.message = message; }
  BirthTimeError.prototype = Object.create(Error.prototype);

  // ---------------------------------------------------------------- helpers

  function wrap360(x) { var y = x % 360.0; return y < 0 ? y + 360.0 : y; }
  function wrap180(x) { return (x + 180.0) % 360.0 - 180.0; }
  function signedMinDelta(a, b) { return wrap180(b - a); }
  function round6(x) { return Math.round(x * 1e6) / 1e6; }
  function round4(x) { return Math.round(x * 1e4) / 1e4; }
  function sind(d) { return Math.sin(d * Math.PI / 180); }
  function cosd(d) { return Math.cos(d * Math.PI / 180); }
  function tand(d) { return Math.tan(d * Math.PI / 180); }
  function asind(x) { return Math.asin(x) * 180 / Math.PI; }
  function acosd(x) { return Math.acos(x) * 180 / Math.PI; }
  function atan2d(y, x) { return Math.atan2(y, x) * 180 / Math.PI; }

  function zodiacOf(lon) {
    lon = wrap360(lon);
    var idx = Math.floor(lon / 30.0);
    var inSign = lon - idx * 30.0;
    var deg = Math.floor(inSign);
    var minutesFull = (inSign - deg) * 60.0;
    var minutes = Math.floor(minutesFull);
    var seconds = (minutesFull - minutes) * 60.0;
    var secStr = seconds.toFixed(1);
    if (secStr.length < 4) secStr = "0" + secStr; // match Python f"{s:04.1f}"
    return {
      longitude: round4(lon),
      sign: SIGNS[idx],
      deg_in_sign: round4(inSign),
      dms: deg + "\u00B0" + String(minutes).padStart(2, "0") + "'" + secStr + "\""
    };
  }

  // ---------------------------------------------------------------- timezone (Intl / IANA)

  var dtfCache = {};
  function dtf(tz) {
    if (!dtfCache[tz]) {
      dtfCache[tz] = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
    }
    return dtfCache[tz];
  }

  function tzIsValid(tz) {
    try { dtf(tz).format(0); return true; } catch (e) { return false; }
  }

  // Offset of `tz` at UTC instant `utcMs`, in seconds (verified to the second vs tzdb).
  function tzOffsetSeconds(tz, utcMs) {
    var p = {};
    dtf(tz).formatToParts(utcMs).forEach(function (x) { p[x.type] = x.value; });
    var asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour), Number(p.minute), Number(p.second));
    return (asUtc - utcMs) / 1000;
  }

  function isValidLocal(tz, localMs, offsetSec) {
    var utcCand = localMs - offsetSec * 1000;
    return tzOffsetSeconds(tz, utcCand) === offsetSec &&
      (localMs - utcCand) === offsetSec * 1000;
  }

  /* Resolve naive local wall time in `tz` the way PEP 495 + Python zoneinfo do:
   * gap (spring-forward nonexistent time) → BirthTimeError; ambiguity (fall-back)
   * → flag + fold selection (fold 0 = earlier instant = larger offset). */
  function resolveLocalUtcMs(tz, localMs, fold, flags) {
    var samples = [localMs - 48 * 3600000, localMs - 24 * 3600000,
      localMs + 24 * 3600000, localMs + 48 * 3600000];
    var cands = [];
    samples.forEach(function (s) {
      var o = tzOffsetSeconds(tz, s);
      if (cands.indexOf(o) === -1) cands.push(o);
    });
    cands.sort(function (a, b) { return b - a; }); // descending: [0] = earlier instant
    var valid = cands.filter(function (o) { return isValidLocal(tz, localMs, o); });
    if (valid.length === 0) throw new BirthTimeError("NONEXISTENT_LOCAL_TIME_DST_GAP");
    if (valid.length === 2 && valid[0] !== valid[1]) {
      flags.push("DST_AMBIGUOUS_FALLBACK_TIME");
      flags.push("FOLD_USED=" + fold);
    }
    valid.sort(function (a, b) { return b - a; });
    var f = (fold === 1) ? 1 : 0;
    if (valid.length === 1 && fold === 1) f = 0;
    var off = valid[Math.min(f, valid.length - 1)];
    return { utcMs: localMs - off * 1000, offsetSeconds: off };
  }

  // ---------------------------------------------------------------- positions (Layer A port)

  function eclipticLon(bodyKey, astroTime) {
    if (bodyKey === "sun") return wrap360(Astro.SunPosition(astroTime).elon);
    if (bodyKey === "moon") return wrap360(Astro.Ecliptic(Astro.GeoMoon(astroTime)).elon);
    return wrap360(Astro.Ecliptic(Astro.GeoVector(Astro.Body[bodyKey.charAt(0).toUpperCase() + bodyKey.slice(1)], astroTime, true)).elon);
  }

  var astroTimeCache = {};
  function makeTime(utcMs) {
    if (!astroTimeCache[utcMs]) astroTimeCache[utcMs] = Astro.MakeTime(new Date(utcMs));
    return astroTimeCache[utcMs];
  }

  /* Numeric derivative, 1-hour central difference — identical to the Python kernel's
   * _daily_speed (step 1/24 day → deg/day = delta * 12). Time arithmetic in ms space
   * (constructing AstroTime from offset tt is unreliable, same as in the Python binding). */
  function speedPerDay(bodyKey, utcMs) {
    var step = 3600000;
    var t0 = makeTime(utcMs - step), t1 = makeTime(utcMs + step);
    var delta = signedMinDelta(eclipticLon(bodyKey, t0), eclipticLon(bodyKey, t1));
    return delta * 12.0; // deg/day
  }

  function positionsAt(utcMs) {
    var out = {};
    BODIES.forEach(function (key) {
      var t = makeTime(utcMs);
      var lon = eclipticLon(key, t);
      var speed = speedPerDay(key, utcMs);
      out[key] = Object.assign(zodiacOf(lon), {
        speed_lon_per_day: round6(speed),
        retrograde: !!(speed < 0 && key !== "sun" && key !== "moon")
      });
    });
    return out;
  }

  // ---------------------------------------------------------------- houses (native port, verified vs pyswisseph)

  function raToEclipticLon(raDeg, eps) { return wrap360(atan2d(sind(raDeg) / cosd(eps), cosd(raDeg))); }
  function eclipticLonToRa(lonDeg, eps) { return wrap360(atan2d(sind(lonDeg) * cosd(eps), cosd(lonDeg))); }
  function declinationOf(lonDeg, eps) { return asind(sind(eps) * sind(lonDeg)); }

  function semiDiurnalArc(latDeg, lonDeg, eps) {
    var x = -tand(latDeg) * tand(declinationOf(lonDeg, eps));
    if (x < -1 || x > 1) return null; // circumpolar: semi-arc undefined
    return acosd(x);
  }

  function ascMc(utcMs, latDeg, lonEast) {
    var ramc = wrap360(Astro.SiderealTime(makeTime(utcMs)) * 15 + lonEast);
    var eps = Astro.e_tilt(makeTime(utcMs)).tobl; // true obliquity (matches pyswisseph convention)
    var mc = wrap360(atan2d(sind(ramc), cosd(ramc) * cosd(eps)));
    var asc = wrap360(atan2d(cosd(ramc), -(sind(ramc) * cosd(eps) + tand(latDeg) * sind(eps))));
    return { ramc: ramc, eps: eps, asc: asc, mc: mc };
  }

  function iteratePlacidus(ramc, latDeg, eps, fraction, offsetDeg, nocturnal) {
    // Solves RA_cusp = ramc + offset ± F·SA/NA for the cusp's own semi-arc (4+ iterations).
    var x = wrap360(ramc + offsetDeg);
    for (var i = 0; i < 30; i++) {
      var lon = raToEclipticLon(x, eps);
      var sd = semiDiurnalArc(latDeg, lon, eps);
      if (sd === null) throw new BirthTimeError("HOUSE_SYSTEM_UNDEFINED_AT_LATITUDE");
      var na = 180.0 - sd;
      var xNew = nocturnal
        ? wrap360(ramc + 180.0 - fraction * na)
        : wrap360(ramc + fraction * sd);
      if (Math.abs(signedMinDelta(x, xNew)) < 1e-10) { x = xNew; break; }
      x = xNew;
    }
    return raToEclipticLon(x, eps);
  }

  function housesAt(utcMs, latDeg, lonEast, system) {
    // Domain rule (labeled limitation, matches the /about disclosure): beyond ±66° the
    // ascendant quadrant and house conventions become school-dependent to the point of
    // being undefined (circumpolar semi-arcs). Suppression, not approximation.
    if (Math.abs(latDeg) > 66) {
      throw new BirthTimeError("POLAR_LATITUDE_UNSUPPORTED_IN_BROWSER_BUILD");
    }
    if (!HOUSE_SYSTEMS_JS[system]) {
      throw new BirthTimeError("HOUSE_SYSTEM_NOT_IN_BROWSER_BUILD:" + system);
    }
    var am = ascMc(utcMs, latDeg, lonEast);
    var cusps;
    if (system === "whole_sign") {
      // pyswisseph 'W': purely structural — 12 sign-starts from the ASC's sign.
      // (The MC is reported separately; it is NOT a whole-sign cusp.)
      var start = Math.floor(wrap360(am.asc) / 30.0) * 30.0;
      cusps = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(function (i) { return wrap360(start + 30.0 * i); });
    } else if (system === "equal") {
      cusps = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(function (i) { return wrap360(am.asc + 30.0 * i); });
    } else { // placidus
      var c11 = iteratePlacidus(am.ramc, latDeg, am.eps, 1 / 3, 30, false);
      var c12 = iteratePlacidus(am.ramc, latDeg, am.eps, 2 / 3, 60, false);
      var c2 = iteratePlacidus(am.ramc, latDeg, am.eps, 2 / 3, 120, true);
      var c3 = iteratePlacidus(am.ramc, latDeg, am.eps, 1 / 3, 150, true);
      cusps = [am.asc, c2, c3, wrap360(am.mc + 180), wrap360(c11 + 180), wrap360(c12 + 180),
        wrap360(am.asc + 180), wrap360(c2 + 180), wrap360(c3 + 180),
        am.mc, c11, c12];
    }
    return {
      system: system,
      asc: zodiacOf(am.asc),
      mc: zodiacOf(am.mc),
      cusps: cusps.map(zodiacOf)
    };
  }

  // ---------------------------------------------------------------- mean lunar node (analytic)

  function meanNodeAt(utcMs) {
    var jd = 2440587.5 + utcMs / 86400000.0; // Unix epoch → JD (UT)
    var T = (jd - 2451545.0) / 36525.0;
    var omega = 125.0445479 - 1934.1362891 * T + 0.0020754 * T * T
      + T * T * T / 467441.0 - T * T * T * T / 60616000.0;
    return Object.assign(zodiacOf(omega), {
      speed_lon_per_day: round6(-0.0529539),
      retrograde: true
    });
  }

  function nodesAt(utcMs) {
    return {
      available: true,
      mean_node: meanNodeAt(utcMs),
      true_node: { suppressed: true, reason: "TRUE_NODE_UNAVAILABLE_IN_BROWSER_BUILD" }
    };
  }

  // ---------------------------------------------------------------- aspects

  function aspectBetween(lonA, lonB, orbs, maxOrb) {
    var sep = Math.abs(signedMinDelta(lonB, lonA));
    var best = null;
    Object.keys(ASPECT_ANGLES).forEach(function (name) {
      var dev = Math.abs(wrap180(sep - ASPECT_ANGLES[name]));
      var orbLimit = orbs[name] || 0.0;
      if (maxOrb !== undefined && maxOrb !== null) orbLimit = Math.min(orbLimit, maxOrb);
      if (dev <= orbLimit && (best === null || dev < best.orb)) {
        best = { type: name, orb: round4(dev) };
      }
    });
    return best;
  }

  function natalAspects(planets, angles, orbs, orbToAngles) {
    var results = [];
    var keys = BODIES.filter(function (k) { return planets[k] && planets[k].longitude !== undefined; });
    keys.forEach(function (a, i) {
      keys.slice(i + 1).forEach(function (b) {
        var hit = aspectBetween(planets[a].longitude, planets[b].longitude, orbs, null);
        if (hit) {
          var relSpeed = planets[a].speed_lon_per_day - planets[b].speed_lon_per_day;
          var sepSigned = signedMinDelta(planets[b].longitude, planets[a].longitude);
          var devSigned = wrap180(sepSigned - ASPECT_ANGLES[hit.type]);
          results.push(Object.assign({ a: a, b: b }, hit, { applying: !!(devSigned * relSpeed < 0) }));
        }
      });
    });
    if (angles) {
      keys.forEach(function (a) {
        ["asc", "mc"].forEach(function (angleName) {
          var hit = aspectBetween(planets[a].longitude, angles[angleName].longitude, orbs, orbToAngles);
          if (hit) results.push(Object.assign({ a: a, b: angleName }, hit, { applying: null }));
        });
      });
    }
    return results;
  }

  // ---------------------------------------------------------------- main entry

  function parseLocalDateMs(dateStr, timeStr) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(dateStr + "T" + timeStr);
    if (!m) throw new BirthTimeError("INVALID_DATE_OR_TIME");
    var ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    // guard against silent rollover (e.g. month 13)
    var d = new Date(ms);
    if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
      throw new BirthTimeError("INVALID_DATE_OR_TIME");
    }
    return ms;
  }

  function asUtc(birth, flags) {
    var place = birth.place;
    var lon = Number(place.lon);
    var naive = parseLocalDateMs(birth.date, birth.time);
    var mode = birth.time_mode || "STANDARD";
    if (mode === "LMT") {
      var offSec = (lon / 15.0) * 3600.0;
      flags.push("LMT_DERIVED");
      return { utcMs: naive - offSec * 1000, offsetHours: lon / 15.0 };
    }
    if (mode === "FIXED_OFFSET") {
      var off = Number(birth.utc_offset_hours);
      flags.push("FIXED_OFFSET_EXPLICIT");
      return { utcMs: naive - off * 3600000, offsetHours: off };
    }
    var fold = birth.fold === undefined ? 0 : Number(birth.fold);
    var r = resolveLocalUtcMs(place.tz, naive, fold, flags);
    return { utcMs: r.utcMs, offsetHours: r.offsetSeconds / 3600.0 };
  }

  function isoUtc(utcMs) {
    // Python-aware datetime isoformat ("+00:00"), so fixtures compare byte-identically.
    return new Date(utcMs).toISOString().replace(".000Z", "+00:00");
  }

  function computeChart(birth, config) {
    var cfg = Object.assign({}, DEFAULT_CONFIG, config || {});
    var flags = [];
    var lat = Number(birth.place.lat), lon = Number(birth.place.lon);

    if (birth.time === undefined || birth.time === null || birth.time === "" || birth.time === "unknown") {
      var noonUtc = parseLocalDateMs(birth.date, "12:00");
      var posN = positionsAt(noonUtc);
      posN.moon = { suppressed: true, reason: "BIRTH_TIME_UNKNOWN_MOON_SUPPRESSED" };
      flags.push("BIRTH_TIME_UNKNOWN");
      flags.push("NOON_UTC_REPRESENTATIVE_INSTANT_SLOW_BODIES_ONLY");
      flags.push("MOON_SUPPRESSED");
      return finalize(birth, cfg, null, posN, null, null, flags, null, null);
    }

    var tzInfo = asUtc(birth, flags);
    var pos = positionsAt(tzInfo.utcMs);
    var hs = null, angles = null;
    try {
      hs = housesAt(tzInfo.utcMs, lat, lon, cfg.house_system);
      angles = { asc: hs.asc, mc: hs.mc };
      flags.push("HOUSES_SOURCE=native-js-port");
    } catch (e) {
      hs = null; angles = null;
      flags.push("HOUSES_UNAVAILABLE=" + e.message);
    }
    var nodes = nodesAt(tzInfo.utcMs);
    return finalize(birth, cfg, tzInfo.utcMs, pos, angles, { houses: hs, nodes: nodes }, flags, null, tzInfo.offsetHours);
  }

  function finalize(birth, cfg, utcMs, pos, angles, extra, flags, when, offsetHours) {
    var aspects = pos ? natalAspects(pos, angles, cfg.orbs_natal, cfg.orbs_to_angles) : [];
    return {
      schema_version: SCHEMA_VERSION,
      engine: {
        id: ENGINE_ID,
        version: ENGINE_VERSION,
        libraries: {
          "astronomy-engine": "2.1.19 (official JS port)",
          "houses/nodes": "native JS port, differentially verified vs pyswisseph kernel",
          tzdb: "IANA via runtime Intl"
        }
      },
      birth: {
        date: birth.date,
        time: birth.time === undefined ? null : birth.time,
        place: { lat: Number(birth.place.lat), lon: Number(birth.place.lon), tz: birth.place.tz || null },
        time_mode: birth.time_mode || "STANDARD",
        utc_datetime: utcMs === null ? null : isoUtc(utcMs),
        utc_offset_hours: offsetHours === undefined ? null : offsetHours
      },
      flags: flags,
      planets: pos,
      angles: angles,
      houses: extra ? extra.houses : null,
      nodes: extra ? extra.nodes : null,
      aspects: aspects,
      config: cfg,
      provenance: {
        computed_at: new Date().toISOString(),
        zodiac: cfg.zodiac,
        conventions: "single natal orb set v0.1; numeric speed via 1h central difference; " +
          "mean node analytic; houses native JS port verified against the pyswisseph kernel record"
      }
    };
  }

  // ---------------------------------------------------------------- chart summary + static reading (template port)

  function fmtDeg(v) {
    return v === undefined || v === null || v.suppressed ? "suppressed"
      : v.deg_in_sign.toFixed(1) + "\u00B0 " + v.sign + (v.retrograde ? " R" : "");
  }

  function chartSummary(chart) {
    var planets = {};
    BODIES.forEach(function (k) { planets[k] = fmtDeg(chart.planets[k]); });
    var angles = null;
    if (chart.angles) {
      angles = {
        asc: chart.angles.asc.deg_in_sign.toFixed(1) + "\u00B0 " + chart.angles.asc.sign,
        mc: chart.angles.mc.deg_in_sign.toFixed(1) + "\u00B0 " + chart.angles.mc.sign
      };
    }
    var houses = null;
    if (chart.houses) {
      houses = { system: chart.houses.system, cusps: chart.houses.cusps.map(function (c) { return c.deg_in_sign.toFixed(1) + "\u00B0 " + c.sign; }) };
    }
    return {
      birth: chart.birth, flags: chart.flags, planets: planets, angles: angles, houses: houses,
      aspects: chart.aspects.map(function (a) { return a.a + " " + a.type + " " + a.b + " (orb " + a.orb + "\u00B0)"; }),
      engine: chart.engine.id + " " + chart.engine.version
    };
  }

  function staticReading(chart, question) {
    var s = chartSummary(chart);
    var lines = ["SFERA LAB \u2014 STATIC TEMPLATE READING (no AI in this reading)", ""];
    if (chart.flags.indexOf("BIRTH_TIME_UNKNOWN") !== -1) {
      lines.push("Birth time unknown: house cusps, angles and the Moon's degree are " +
        "deliberately suppressed rather than approximated. Slow bodies only.");
    }
    var p = s.planets;
    lines.push("Sun: " + p.sun + " \u00B7 Moon: " + p.moon + " \u00B7 Mercury: " + p.mercury + " \u00B7 " +
      "Venus: " + p.venus + " \u00B7 Mars: " + p.mars);
    ["jupiter", "saturn", "uranus", "neptune", "pluto"].forEach(function (body) {
      lines.push(body.charAt(0).toUpperCase() + body.slice(1) + ": " + p[body]);
    });
    if (s.angles) {
      lines.push("Ascendant: " + s.angles.asc + " \u00B7 Midheaven: " + s.angles.mc +
        " (house system: " + (s.houses ? s.houses.system : "n/a") + ")");
    }
    if (s.aspects.length) {
      lines.push("");
      lines.push("Major natal aspects:");
      s.aspects.slice(0, 6).forEach(function (a) { lines.push("  \u00B7 " + a); });
    }
    if (question) {
      lines.push("");
      lines.push("Question received: \u201C" + question + "\u201D \u2014 this static template does not answer " +
        "outcome questions. It describes the calculated chart only.");
    }
    lines.push("");
    lines.push("Provenance: " + s.engine + " \u00B7 template " + TEMPLATE_VERSION + " \u00B7 tropical zodiac \u00B7 " +
      "deterministic calculation, no user history, no memory.");
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- public API

  return {
    ENGINE_ID: ENGINE_ID,
    ENGINE_VERSION: ENGINE_VERSION,
    SCHEMA_VERSION: SCHEMA_VERSION,
    TEMPLATE_VERSION: TEMPLATE_VERSION,
    ZODIAC: ZODIAC,
    SIGNS: SIGNS,
    BODIES: BODIES,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    BirthTimeError: BirthTimeError,
    wrap360: wrap360,
    wrap180: wrap180,
    signedMinDelta: signedMinDelta,
    zodiacOf: zodiacOf,
    tzIsValid: tzIsValid,
    tzOffsetSeconds: tzOffsetSeconds,
    resolveLocalUtcMs: resolveLocalUtcMs,
    asUtcForVerify: asUtc,
    isoUtcForVerify: isoUtc,
    positionsAt: positionsAt,
    housesAt: housesAt,
    meanNodeAt: meanNodeAt,
    nodesAt: nodesAt,
    natalAspects: natalAspects,
    computeChart: computeChart,
    chartSummary: chartSummary,
    staticReading: staticReading
  };
});
