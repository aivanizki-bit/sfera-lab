/* SFERA Lab — public generator page logic (Research UI).
 *
 * Everything here runs in the visitor's browser: validation, calculation
 * (sfera_engine.js), rendering, telemetry events (telemetry.js). No network requests
 * are made with user input — ever. DOM is built with textContent (no innerHTML for
 * user-influenced strings), so there is no injection surface even in error paths.
 */
(function () {
  "use strict";
  var SE = window.SferaEngine, T = window.SFERA_TELEMETRY;

  var cities = null; // loaded from cities.json (bundled static file)
  fetch(new URL("cities.json", document.baseURI))
    .then(function (r) { return r.json(); })
    .then(function (d) { cities = d.cities; wireCityPicker(); })
    .catch(function () { /* city picker stays unavailable; manual entry still works */ });

  // ---------------------------------------------------------------- validation helpers

  function fail(msg) { throw { validation: true, message: msg }; }

  function str(form, name, maxLen) {
    var v = (form.get(name) || "").toString().trim();
    // strip control characters (unicode category Cc/Cf via regex on common ranges)
    v = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, "");
    if (v.length > maxLen) v = v.slice(0, maxLen);
    return v;
  }

  function validate(form) {
    var date = str(form, "date", 10);
    var time = str(form, "time", 5);
    var city = str(form, "city", 80);
    var latS = str(form, "lat", 12), lonS = str(form, "lon", 12);
    var tz = str(form, "tz", 60);
    var houses = str(form, "houses", 20) || "placidus";
    var question = str(form, "question", 300);

    // boundary allowlist (model-council finding: don't trust even the <select>)
    if (["placidus", "whole_sign", "equal"].indexOf(houses) === -1) {
      fail("Unknown house system.");
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("Enter the birth date as a calendar date.");
    var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    var y = +dm[1], mo = +dm[2], d = +dm[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) fail("That date does not exist.");
    var probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) fail("That date does not exist.");
    if (date < "1800-01-01") fail("Dates before 1800-01-01 are outside this tool's verified range.");
    if (date > "2039-12-31") fail("Dates after 2039-12-31 are outside this tool's verified range.");

    if (time !== "") {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail("Enter the birth time as HH:MM (24-hour), or leave it empty.");
    }

    var lat = null, lon = null, tzName = null;
    if (city) {
      var c = (cities || []).find(function (x) { return x.name === city; });
      if (!c) fail("City not in the bundled list — enter latitude/longitude manually.");
      lat = c.lat; lon = c.lon; tzName = c.tz;
    }
    if (latS !== "" || lonS !== "") {
      if (!/^[+-]?\d{1,2}(\.\d{1,4})?$/.test(latS) || !/^[+-]?\d{1,3}(\.\d{1,4})?$/.test(lonS))
        fail("Latitude/longitude must be decimal numbers (e.g. 52.52 / 13.405).");
      lat = parseFloat(latS); lon = parseFloat(lonS);
      if (lat < -90 || lat > 90) fail("Latitude must be between -90 and 90.");
      if (lon < -180 || lon > 180) fail("Longitude must be between -180 and 180.");
    }
    if (lat === null || lon === null) fail("Provide a city or latitude/longitude.");
    if (tz) {
      if (!SE.tzIsValid(tz)) fail("Unknown IANA time zone name — use e.g. Europe/Berlin or America/New_York.");
      tzName = tz;
    }
    if (!tzName && time) {
      // no zone info at all: LMT (local mean time), flagged honestly, as in the local tool
      return { birth: { date: date, time: time, place: { lat: lat, lon: lon, tz: null }, time_mode: "LMT" }, houses: houses, question: question };
    }
    return { birth: { date: date, time: time || null, place: { lat: lat, lon: lon, tz: tzName } }, houses: houses, question: question || null };
  }

  // ---------------------------------------------------------------- rendering (textContent only)

  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function txt(tag, text, cls) { var e = el(tag, cls); e.textContent = text; return e; }

  function chip(text) { return txt("span", text, "chip"); }

  function simpleTable(headers, rows) {
    var t = el("table"), tr = el("tr");
    headers.forEach(function (h) { tr.appendChild(txt("th", h)); });
    t.appendChild(tr);
    rows.forEach(function (r) {
      var trr = el("tr");
      r.forEach(function (cell) { trr.appendChild(txt("td", cell)); });
      t.appendChild(trr);
    });
    return t;
  }

  function renderChart(birth, cfg, chart, question) {
    var box = el("div");
    var chips = el("div");
    ["CALCULATED: " + chart.engine.id + " " + chart.engine.version,
     "STATIC TEMPLATE — no AI in this reading",
     "BROWSER-LOCAL — your input never left this device",
     "NO MEMORY — nothing about you is stored",
     "ZODIAC: " + chart.provenance.zodiac,
     "HOUSES: " + cfg.house_system + " (school-labeled)"
    ].forEach(function (c) { chips.appendChild(chip(c)); });
    box.appendChild(chips);

    box.appendChild(txt("h2", "Planets"));
    var rows = [];
    SE.BODIES.forEach(function (b) {
      var v = chart.planets[b];
      if (v && v.sign) rows.push([b.charAt(0).toUpperCase() + b.slice(1), v.dms + " " + v.sign,
        v.retrograde ? "retrograde" : "", v.speed_lon_per_day.toFixed(4) + "°/day"]);
      else rows.push([b.charAt(0).toUpperCase() + b.slice(1),
        "suppressed (" + (v && v.reason ? v.reason : "BIRTH_TIME_UNKNOWN") + ")", "", ""]);
    });
    box.appendChild(simpleTable(["Body", "Position", "Motion", "Speed"], rows));

    box.appendChild(txt("h2", "Angles"));
    if (chart.angles) {
      box.appendChild(txt("p", "Ascendant " + chart.angles.asc.dms + " " + chart.angles.asc.sign +
        " · Midheaven " + chart.angles.mc.dms + " " + chart.angles.mc.sign));
    } else {
      box.appendChild(txt("p", "Suppressed — birth time unknown (suppression-not-approximation), " +
        "or birth latitude beyond the browser build's verified domain."));
    }

    box.appendChild(txt("h2", "Lunar nodes"));
    if (chart.nodes && chart.nodes.mean_node) {
      var n = chart.nodes.mean_node;
      box.appendChild(simpleTable(["Node", "Position", "Motion"], [
        ["Mean node (analytic)", n.dms + " " + n.sign, "retrograde"],
        ["True (osculating) node", "suppressed (TRUE_NODE_UNAVAILABLE_IN_BROWSER_BUILD) — school-relevant; see /about", ""]
      ]));
    } else {
      box.appendChild(txt("p", "Nodes are shown only for timed charts."));
    }

    box.appendChild(txt("h2", "House cusps"));
    box.appendChild(txt("p", "Within Western astrology, house systems genuinely disagree on cusp " +
      "placement away from the angles; both this system and alternatives are legitimate within " +
      "their schools.", "small"));
    if (chart.houses) {
      box.appendChild(simpleTable(["House", "Cusp (" + chart.houses.system + ")"],
        chart.houses.cusps.map(function (c, i) { return [String(i + 1), c.dms + " " + c.sign]; })));
    } else {
      box.appendChild(txt("p", "Suppressed — see the Angles note above."));
    }

    box.appendChild(txt("h2", "Major aspects"));
    var arows = chart.aspects.map(function (a) {
      var phase = a.applying === null ? "to angle" : (a.applying ? "applying" : "separating");
      return [a.a.charAt(0).toUpperCase() + a.a.slice(1) + " " + a.type + " " +
        (a.b === "asc" ? "Ascendant" : a.b === "mc" ? "Midheaven" : a.b.charAt(0).toUpperCase() + a.b.slice(1)),
        "orb " + a.orb + "°", phase];
    });
    box.appendChild(arows.length ? simpleTable(["Aspect", "Orb", "Phase"], arows)
      : txt("p", "none within the disclosed orb set"));

    box.appendChild(txt("h2", "Reading (static template — describes the chart, predicts nothing)"));
    box.appendChild(txt("pre", SE.staticReading(chart, question)));

    box.appendChild(txt("h2", "Calculation flags"));
    var flags = el("p");
    chart.flags.forEach(function (f) { flags.appendChild(chip(f)); });
    box.appendChild(flags);

    box.appendChild(txt("h2", "Provenance"));
    var libs = chart.engine.libraries;
    box.appendChild(simpleTable(["Field", "Value"], [
      ["Engine", chart.engine.id + " " + chart.engine.version + " (schema " + chart.schema_version + ")"],
      ["Position library", libs["astronomy-engine"]],
      ["Houses / nodes", libs["houses/nodes"]],
      ["Time zone data", libs["tzdb"]],
      ["Conventions", chart.provenance.conventions],
      ["Verification", "JS port differentially verified against the Python kernel: 260 frozen cases, " +
        "0 failures (positions Δ≤0.0051°, time zones exact, houses Δ≤0.0001°) — engine agreement is not proof of truth"],
      ["Computed at", chart.provenance.computed_at + " (in your browser)"]
    ]));

    box.appendChild(txt("h2", "Limitations"));
    var ul = el("ul");
    ["Unknown birth time: Moon degree, angles and houses are suppressed, not approximated.",
     "House systems genuinely disagree; the system used is labeled, not claimed as correct.",
     "The true (osculating) lunar node, Chiron and Lilith are not computed in this browser build.",
     "Beyond ±66° latitude angles/houses are suppressed (school-dependent to the point of undefined).",
     "The reading is a static template: it describes the calculated chart and interprets nothing.",
     "A birth date is not a person; 18+ only."]
      .forEach(function (s) { ul.appendChild(txt("li", s)); });
    box.appendChild(ul);

    var share = el("p");
    var shareBtn = txt("button", "Copy a plain link to this tool", "chip");
    shareBtn.type = "button";
    shareBtn.addEventListener("click", function () {
      var link = new URL("?src=share-001", document.baseURI).href;
      copyText(shareBtn, link);
    });
    var copyBtn = txt("button", "Copy reading as text", "chip");
    copyBtn.type = "button";
    copyBtn.addEventListener("click", function () {
      copyText(copyBtn, SE.staticReading(chart, question));
    });
    share.appendChild(txt("span", "Sharing is explicit and manual: ", "small"));
    share.appendChild(shareBtn);
    share.appendChild(document.createTextNode(" "));
    share.appendChild(copyBtn);
    box.appendChild(share);

    return box;
  }

  function copyText(button, text) {
    var done = function () { var old = button.textContent; button.textContent = "Copied ✓";
      setTimeout(function () { button.textContent = old; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) { }
    document.body.removeChild(ta);
  }

  function showError(box, title, message) {
    box.textContent = "";
    var err = el("div", "err");
    err.appendChild(txt("strong", title));
    err.appendChild(txt("p", message));
    box.appendChild(err);
  }

  // ---------------------------------------------------------------- form wiring

  function wireCityPicker() {
    var input = document.getElementById("city");
    var dl = document.getElementById("cities");
    if (!input || !dl || !cities) return;
    cities.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c.name;
      dl.appendChild(o);
    });
    input.addEventListener("change", function () {
      var c = cities.find(function (x) { return x.name === input.value; });
      if (c) {
        document.getElementById("lat").value = c.lat;
        document.getElementById("lon").value = c.lon;
        document.getElementById("tz").value = c.tz;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    T.trackTrafficIn();

    var consent = document.getElementById("consent");
    if (consent && T.consentRecord) consent.checked = T.consentRecord.consent;
    if (consent) consent.addEventListener("change", function () { T.setConsent(consent.checked); });

    var form = document.getElementById("chart-form");
    var result = document.getElementById("result");
    if (!form) return;

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      result.textContent = "";
      var fd = new FormData(form);
      var parsed;
      try { parsed = validate(fd); }
      catch (e) {
        showError(result, "Please check the form.", (e && e.validation) ? e.message : "Invalid input.");
        return;
      }
      T.track("birth_start", { has_time: !!parsed.birth.time, houses: parsed.houses });
      var chart;
      try {
        chart = SE.computeChart(parsed.birth, { house_system: parsed.houses });
      } catch (e) {
        T.track("calc_complete", { ok: false, houses: parsed.houses });
        if (e && e.message === "NONEXISTENT_LOCAL_TIME_DST_GAP") {
          showError(result, "That time does not exist",
            "Your local clock jumped over this moment (daylight-saving spring change). " +
            "Pick a time that existed, or use the unambiguous neighboring hour.");
        } else if (e && e.message === "INVALID_DATE_OR_TIME") {
          showError(result, "Invalid date or time", "Check the birth date and time fields.");
        } else {
          showError(result, "Calculation failed",
            "The chart could not be computed for this input. No partial data is shown.");
        }
        return;
      }
      T.track("calc_complete", { ok: true, houses: parsed.houses, flags: chart.flags });
      T.track("reading_consumed", { flags: chart.flags });
      result.appendChild(renderChart(parsed.birth, { house_system: parsed.houses }, chart, parsed.question));
      result.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
})();
