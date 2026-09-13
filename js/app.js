/* SFERA Lab — public generator page logic v2 (Research UI, EXECUTION_004).
 *
 * Everything here runs in the visitor's browser: validation, calculation
 * (sfera_engine.js — UNTOUCHED verified port), localized rendering, telemetry events
 * (telemetry.js), place resolution (places.js). User input is only ever inserted with
 * textContent (no innerHTML for user-influenced strings), so there is no injection
 * surface even in error paths.
 *
 * Language layer: page strings are rendered server-side at build time (RU default /
 * EN under /en/); this script loads i18n/app-<lang>.json for the dynamic surface.
 * Language NEVER affects calculation — sfera_engine.js is language-free and remains
 * byte-identical to the differentially verified port.
 */
(function () {
  "use strict";
  var SE = window.SferaEngine, T = window.SFERA_TELEMETRY, P = window.SFERA_PLACES;

  // Asset root = directory of this script (pages may live at / or /en/…)
  var ASSET_ROOT = (document.currentScript && document.currentScript.src
    ? document.currentScript.src.replace(/js\/app\.js.*$/, "")
    : new URL("js/", document.baseURI).href);

  var LANG = (document.documentElement.lang || "en").toLowerCase() === "ru" ? "ru" : "en";
  var t = {}; // dictionary, loaded below

  function dictGet(path) {
    var cur = t;
    for (var i = 0; i < path.length; i++) {
      if (cur == null) return null;
      cur = cur[path[i]];
    }
    return cur === undefined ? null : cur;
  }
  function tr(path, vars) {
    var v = dictGet(path.split("."));
    if (v == null) return path.join ? path.join(".") : String(path);
    if (vars) {
      return v.replace(/\{(\w+)\}/g, function (_, k) {
        return vars[k] !== undefined ? String(vars[k]) : "{" + k + "}";
      });
    }
    return v;
  }

  fetch(ASSET_ROOT + "i18n/app-" + LANG + ".json")
    .then(function (r) { return r.ok ? r.json() : Promise.reject(0); })
    .catch(function () {
      return fetch(ASSET_ROOT + "i18n/app-en.json").then(function (r) { return r.json(); });
    })
    .then(function (d) {
      t = d || {};
      if (LANG === "ru") {
        // human-reading phrase library (EXECUTION_004 addendum prototype, hr-v0.1)
        return fetch(ASSET_ROOT + "i18n/reading-ru.json")
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (hr) { t._hr = hr || null; })
          .catch(function () { t._hr = null; });
      }
      t._hr = null;
    })
    .then(function () { wireCityPicker(); })
    .catch(function () { t = {}; wireCityPicker(); });

  var cities = null;
  fetch(ASSET_ROOT + "cities.json")
    .then(function (r) { return r.json(); })
    .then(function (d) { cities = d.cities; })
    .catch(function () { /* manual entry still works */ });

  // ---------------------------------------------------------------- validation

  function fail(key) { throw { validation: true, key: key }; }

  function str(form, name, maxLen) {
    var v = (form.get(name) || "").toString().trim();
    v = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, "");
    if (v.length > maxLen) v = v.slice(0, maxLen);
    return v;
  }

  function validate(form, pickedPlace) {
    var date = str(form, "date", 10);
    var time = str(form, "time", 5);
    var latS = str(form, "lat", 12), lonS = str(form, "lon", 12);
    var tz = str(form, "tz", 60);
    var houses = str(form, "houses", 20) || "placidus";
    var question = str(form, "question", 300);

    if (["placidus", "whole_sign", "equal"].indexOf(houses) === -1) fail("errors.unknown_houses");

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("errors.bad_date");
    var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    var y = +dm[1], mo = +dm[2], d = +dm[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) fail("errors.no_such_date");
    var probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) fail("errors.no_such_date");
    if (date < "1800-01-01" || date > "2039-12-31") fail("errors.date_range");

    if (time !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail("errors.bad_time");

    var lat = null, lon = null, tzName = null, placeLabel = null;
    if (pickedPlace && isFinite(pickedPlace.lat) && isFinite(pickedPlace.lon)) {
      lat = pickedPlace.lat; lon = pickedPlace.lon;
      tzName = pickedPlace.tz || null;
      placeLabel = pickedPlace;
    } else if (latS !== "" && lonS !== "") {
      if (!/^[+-]?\d{1,2}(\.\d{1,4})?$/.test(latS) || !/^[+-]?\d{1,3}(\.\d{1,4})?$/.test(lonS))
        fail("errors.bad_coords");
      lat = parseFloat(latS); lon = parseFloat(lonS);
      if (lat < -90 || lat > 90) fail("errors.lat_range");
      if (lon < -180 || lon > 180) fail("errors.lon_range");
    } else {
      fail("errors.need_place");
    }
    if (tz) {
      if (!SE.tzIsValid(tz)) fail("errors.bad_tz");
      tzName = tz;
    }
    if (!tzName && time) {
      // no zone info at all: LMT (local mean time), flagged honestly by the engine
      return { birth: { date: date, time: time, place: { lat: lat, lon: lon, tz: null }, time_mode: "LMT" },
        houses: houses, question: question, placeLabel: placeLabel };
    }
    return { birth: { date: date, time: time || null, place: { lat: lat, lon: lon, tz: tzName } },
      houses: houses, question: question || null, placeLabel: placeLabel };
  }

  // ---------------------------------------------------------------- human reading (hr-v0.1 prototype)
  /* DETERMINISTIC composition over the verified chart structure + the labeled phrase
   * library (i18n/reading-ru.json). No AI at runtime, no network, nothing sent. Every
   * block keeps an internal evidence trail (factors used) rendered in section 10 —
   * "the user sees clean prose, the Lab retains the evidence chain". Forecasting is
   * honestly NOT_IMPLEMENTED (needs a deterministic transit layer); natal data alone
   * never fabricates a "today/month/year" reading. */

  function hr() { return dictGet(["_hr"]); }

  function houseOf(lon, cusps) {
    for (var i = 0; i < 12; i++) {
      var a = cusps[i].longitude, b = cusps[(i + 1) % 12].longitude;
      if (((b - a + 360) % 360) > ((lon - a + 360) % 360)) return i + 1;
    }
    return null;
  }

  function factorStr(bodyKey, chart, withHouse) {
    var v = chart.planets[bodyKey];
    if (!v || !v.sign) return null;
    var s = bodyName(bodyKey) + " в " + (hr().meta.signs_gen[v.sign] || v.sign) + " (" + v.dms + " " + v.sign + ")";
    if (withHouse && chart.houses) {
      var h = houseOf(v.longitude, chart.houses.cusps);
      if (h) s += " · дом " + h;
    }
    return s;
  }

  function aspectsOf(chart, keys, types) {
    return chart.aspects.filter(function (a) {
      return (keys.indexOf(a.a) !== -1) && (keys.indexOf(a.b) !== -1) &&
        (!types || types.indexOf(a.type) !== -1);
    }).sort(function (x, y) { return x.orb - y.orb; });
  }

  function buildHumanReading(chart) {
    var box = el("div");
    box.className = "human-reading";
    if (LANG !== "ru" || !hr()) {
      box.appendChild(txt("h2", "What the chart says — human reading"));
      box.appendChild(txt("p", "Human Reading prototype: this research build ships it in Russian only. The complete technical chart is below.", "small"));
      return box;
    }
    var H = hr(), T2 = H.titles, timed = !!(chart.angles && chart.houses);
    var ev = []; // evidence trail {section, factors}

    function block(title, paras, sectionId, factors, conf) {
      var b = el("section");
      b.className = "hr-block";
      b.appendChild(txt("h3", title));
      paras.forEach(function (p) { b.appendChild(txt("p", p)); });
      if (conf) b.appendChild(txt("p", conf, "small"));
      if (factors && factors.length) ev.push({ section: title, factors: factors });
      box.appendChild(b);
      return b;
    }
    function fmajor(k) { return (H.meta.aspects[k]); }

    box.appendChild(txt("h2", T2.h2));
    box.appendChild(txt("p", T2.intro, "small"));

    var sun = chart.planets.sun;
    // 1 КТО Я
    (function () {
      var paras = [H.sun_sign[sun.sign]];
      var f = ["Sun " + sun.sign];
      if (timed) {
        var h = houseOf(sun.longitude, chart.houses.cusps);
        if (h) { paras.push(H.house_domain[String(h)] + "."); f.push("Sun house " + h); }
      }
      block(T2.s1, paras, "s1", f, null);
    })();
    // 2 СИЛЬНЫЕ СТОРОНЫ
    (function () {
      var paras = [H.section_phrases.s2_intro];
      var f = [];
      var good = aspectsOf(chart, ["sun", "moon", "mercury", "venus", "mars", "saturn", "jupiter"], ["trine", "sextile"]).slice(0, 3);
      good.forEach(function (a) {
        paras.push(H.section_phrases.s2_aspect
          .replace("{a}", bodyName(a.a)).replace("{b}", bodyName(a.b))
          .replace("{type}", fmajor(a.type)).replace("{flavor}", H.aspect_flavor[a.type]));
        f.push(a.a + "-" + a.b + " " + a.type);
      });
      paras.push(H.section_phrases.s2_jupiter
        .replace("{sign}", hr().meta.signs_gen[chart.planets.jupiter.sign])
        .replace("{domain_j}", H.domain_jupiter[chart.planets.jupiter.sign]));
      f.push("Jupiter " + chart.planets.jupiter.sign);
      if (!good.length) paras.push("Гармоничных связей личных планет немного — сильные стороны этой карты скорее в устойчивости её ядерных положений, чем в «лёгких» аспектах.");
      block(T2.s2, paras, "s2", f, null);
    })();
    // 3 ПРОТИВОРЕЧИЯ
    (function () {
      var hard = aspectsOf(chart, ["sun", "moon", "mercury", "venus", "mars"], ["square", "opposition"]).slice(0, 3);
      if (!hard.length) { block(T2.s3, [T2.no_tension], "s3", [], null); return; }
      var paras = [H.section_phrases.s3_intro];
      hard.forEach(function (a) {
        paras.push(H.section_phrases.s3_aspect
          .replace("{a}", bodyName(a.a)).replace("{b}", bodyName(a.b))
          .replace("{type}", fmajor(a.type)).replace("{flavor}", H.aspect_flavor[a.type]));
      });
      block(T2.s3, paras, "s3", hard.map(function (a) { return a.a + "-" + a.b + " " + a.type; }), null);
    })();
    // 4 ЭМОЦИИ
    (function () {
      var moon = chart.planets.moon;
      if (!moon || moon.suppressed) {
        block(T2.s4, ["Луна требует времени рождения — без него этот раздел честно пуст (см. примечание в начале)."], "s4", [], null);
        return;
      }
      var paras = [H.moon_sign[moon.sign]];
      var f = ["Moon " + moon.sign];
      if (timed) {
        var h = houseOf(moon.longitude, chart.houses.cusps);
        if (h) { paras.push(H.section_phrases.s4_house.replace("{n}", h).replace("{domain}", H.house_domain[String(h)].replace("сфера: ", ""))); f.push("Moon house " + h); }
      }
      var ma = aspectsOf(chart, ["moon"], null)[0];
      if (ma) {
        var other = ma.a === "moon" ? ma.b : ma.a;
        paras.push("Луна и " + bodyName(other) + " (" + fmajor(ma.type) + ") " + H.aspect_flavor[ma.type] + ".");
        f.push("Moon-" + other + " " + ma.type);
      }
      block(T2.s4, paras, "s4", f, null);
    })();
    // 5 МЫШЛЕНИЕ
    (function () {
      var m = chart.planets.mercury;
      var paras = [H.mercury_sign[m.sign]];
      var f = ["Mercury " + m.sign];
      if (timed) {
        var h = houseOf(m.longitude, chart.houses.cusps);
        if (h) { paras.push(H.section_phrases.s5_house.replace("{n}", h).replace("{domain}", H.house_domain[String(h)].replace("сфера: ", ""))); f.push("Mercury house " + h); }
      }
      block(T2.s5, paras, "s5", f, null);
    })();
    // 6 ЛЮБОВЬ
    (function () {
      var paras = [H.venus_sign[chart.planets.venus.sign], H.mars_sign[chart.planets.mars.sign]];
      var f = ["Venus " + chart.planets.venus.sign, "Mars " + chart.planets.mars.sign];
      if (timed) {
        var hv = houseOf(chart.planets.venus.longitude, chart.houses.cusps);
        var hm = houseOf(chart.planets.mars.longitude, chart.houses.cusps);
        if (hv) paras.push(H.section_phrases.s6_venus_house.replace("{n}", hv).replace("{domain}", H.house_domain[String(hv)].replace("сфера: ", "")));
        if (hm) paras.push(H.section_phrases.s6_mars_house.replace("{n}", hm).replace("{domain}", H.house_domain[String(hm)].replace("сфера: ", "")));
        if (hv) f.push("Venus house " + hv);
        if (hm) f.push("Mars house " + hm);
      }
      block(T2.s6, paras, "s6", f, null);
    })();
    // 7 РАБОТА
    (function () {
      var paras = [];
      var sat = chart.planets.saturn;
      var f = ["Saturn " + sat.sign];
      if (timed) {
        var h = houseOf(sat.longitude, chart.houses.cusps);
        paras.push(H.section_phrases.s7_saturn
          .replace("{sign}", H.meta.signs_gen[sat.sign]).replace("{n}", h || "—")
          .replace("{domain}", h ? H.house_domain[String(h)].replace("сфера: ", "") : "—"));
        if (h) f.push("Saturn house " + h);
        paras.push(H.section_phrases.s7_mc.replace("{sign}", H.meta.signs_gen[chart.angles.mc.sign]));
        f.push("MC " + chart.angles.mc.sign);
      } else {
        paras.push("Сатурн в знаке " + (H.meta.signs_gen[sat.sign]) + " — " + "зона долгого труда: здесь вы взрослеете годами, и здесь же строится настоящий авторитет. MC и дома требуют времени рождения, поэтому публичная роль в этой карте не разбирается. Важно: астрология не определяет карьерный исход — традиция описывает, где видит нагрузку и потенциал.");
      }
      block(T2.s7, paras, "s7", f, null);
    })();
    // 8 КАК МЕНЯ ВИДЯТ (timed only)
    if (timed) {
      block(T2.s8, [H.asc_style[chart.angles.asc.sign] + "."], "s8", ["ASC " + chart.angles.asc.sign], null);
    }
    // 9 САМОЕ НЕОБЫЧНОЕ
    (function () {
      var found = null;
      var outers = ["uranus", "neptune", "pluto"];
      chart.aspects.forEach(function (a) {
        if (found) return;
        if (a.type !== "conjunction" || a.orb > 6) return;
        var personal = ["sun", "moon", "mercury", "venus", "mars", "asc"];
        if (outers.indexOf(a.a) !== -1 && personal.indexOf(a.b) !== -1) found = a;
        if (outers.indexOf(a.b) !== -1 && personal.indexOf(a.a) !== -1) found = a;
      });
      var paras = [];
      var f = [];
      if (found) {
        paras.push(H.section_phrases.s9_conj
          .replace("{a}", bodyName(found.a)).replace("{b}", bodyName(found.b)).replace("{orb}", found.orb));
        f.push(found.a + "=" + found.b + " " + found.orb + "°");
      }
      ["mercury", "venus", "mars"].forEach(function (k) {
        if (chart.planets[k] && chart.planets[k].retrograde) {
          paras.push(H.section_phrases.s9_retro.replace("{body}", bodyName(k)));
          f.push(k + " R");
        }
      });
      if (!paras.length) paras.push(T2.no_unusual);
      block(T2.s9, paras, "s9", f, null);
    })();

    // 10 ПОЧЕМУ SFERA ТАК ГОВОРИТ
    (function () {
      var b = el("section");
      b.className = "hr-block";
      b.appendChild(txt("h3", T2.s10));
      b.appendChild(txt("p", H.section_phrases.s10_explain, "small"));
      var ul = el("ul");
      ev.forEach(function (e) {
        ul.appendChild(txt("li", H.section_phrases.s10_factor
          .replace("{section}", e.section).replace("{factors}", e.factors.join(", ")), "small"));
      });
      b.appendChild(ul);
      b.appendChild(txt("p", H.section_phrases.s10_note
        .replace("{version}", H.meta.version).replace("{school}", H.meta.school), "small"));
      b.appendChild(txt("p", H.meta.honesty, "small"));
      box.appendChild(b);
    })();

    // honest forecast placeholder + other systems note
    var fx = el("section");
    fx.className = "hr-block";
    fx.appendChild(txt("h3", T2.forecast));
    fx.appendChild(txt("p", T2.forecast_note, "small"));
    fx.appendChild(txt("p", T2.other_systems, "small"));
    box.appendChild(fx);
    if (!timed) box.appendChild(txt("p", T2.time_unknown_note, "small"));

    return box;
  }

  // ---------------------------------------------------------------- rendering

  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function txt(tag, text, cls) { var e = el(tag, cls); e.textContent = text; return e; }
  function chip(text) { return txt("span", text, "chip"); }

  function simpleTable(headers, rows) {
    var tbl = el("table"), trh = el("tr");
    headers.forEach(function (h) { trh.appendChild(txt("th", h)); });
    tbl.appendChild(trh);
    rows.forEach(function (r) {
      var trr = el("tr");
      r.forEach(function (cell) { trr.appendChild(txt("td", cell)); });
      tbl.appendChild(trr);
    });
    return tbl;
  }

  function posStr(v, genitive) {
    var signs = genitive ? dictGet(["names", "signs_gen"]) : dictGet(["names", "signs"]);
    var signName = (signs && v && v.sign && signs[v.sign]) || (v && v.sign) || "";
    return v.deg_in_sign.toFixed(1) + "\u00B0 " + signName + (v.retrograde ? " R" : "");
  }
  function bodyName(k) { var m = dictGet(["names", "bodies"]); return (m && m[k]) || k; }

  /* Localized static reading. The engine's staticReading() stays byte-identical to the
   * differentially verified template; this is a pure presentation mapping over the same
   * chartSummary data. */
  function localizedReading(chart, question) {
    var s = SE.chartSummary(chart);
    var raw = chart.planets;
    var L = [];
    L.push(tr("reading.title"));
    L.push("");
    if (chart.flags.indexOf("BIRTH_TIME_UNKNOWN") !== -1) L.push(tr("reading.unknown_time"));
    L.push(tr("reading.personal_line", {
      sun: posStr(raw.sun, true), moon: raw.moon && raw.moon.suppressed ? tr("result.suppressed_paren", { reason: raw.moon.reason }) : posStr(raw.moon, true),
      mercury: posStr(raw.mercury, true), venus: posStr(raw.venus, true), mars: posStr(raw.mars, true)
    }));
    ["jupiter", "saturn", "uranus", "neptune", "pluto"].forEach(function (b) {
      L.push(tr("reading.outer_line", { name: bodyName(b), pos: posStr(raw[b], true) }));
    });
    if (s.angles) {
      var sysName = dictGet(["names", "house_systems"]);
      L.push(tr("reading.angles_line", {
        asc: posStr(chart.angles.asc, true), mc: posStr(chart.angles.mc, true),
        sys: (sysName && sysName[s.houses.system]) || s.houses.system
      }));
    }
    if (s.aspects.length) {
      L.push("");
      L.push(tr("reading.aspects_h"));
      var an = dictGet(["names", "aspects"]);
      chart.aspects.slice(0, 6).forEach(function (a) {
        L.push("  \u00B7 " + tr("reading.aspect_line", {
          a: bodyName(a.a), b: bodyName(a.b),
          type: (an && an[a.type]) || a.type, orb: a.orb
        }));
      });
    }
    if (question) {
      L.push("");
      L.push(tr("reading.question_received", { q: question }));
    }
    L.push("");
    L.push(tr("reading.provenance_line", { engine: s.engine, tpl: SE.TEMPLATE_VERSION }));
    return L.join("\n");
  }

  function renderChart(birth, cfg, chart, question, placeLabel) {
    var box = el("div");
    var chips = el("div");
    [chip(tr("result.chip_calculated", { id: chart.engine.id, ver: chart.engine.version })),
     chip(tr("result.chip_static")),
     placeLabel ? chipPlace(placeLabel) : null,
     chip(tr("result.chip_local")),
     chip(tr("result.chip_nomemory")),
     chip(tr("result.chip_zodiac", { v: chart.provenance.zodiac })),
     chip(tr("result.chip_houses", { v: tr("names.house_systems." + cfg.house_system) || cfg.house_system }))
    ].forEach(function (c) { if (c) chips.appendChild(c); });
    box.appendChild(chips);

    // HUMAN READING first (EXECUTION_004 addendum): clean prose on top,
    // technical layers expandable underneath. Calculation unchanged.
    var human = buildHumanReading(chart);
    box.appendChild(human);

    var tech = el("details");
    tech.className = "tech";
    var sum = el("summary");
    sum.textContent = (hr() && hr().titles.tech_summary) || "Chart data & technical details";
    tech.appendChild(sum);
    var techBody = el("div");
    tech.appendChild(techBody);

    techBody.appendChild(txt("h2", tr("result.planets")));
    var rows = [];
    SE.BODIES.forEach(function (b) {
      var v = chart.planets[b];
      if (v && v.sign) rows.push([bodyName(b), posStr(v, false),
        v.retrograde ? tr("result.retrograde") : "", v.speed_lon_per_day.toFixed(4) + "\u00B0/" + (LANG === "ru" ? "день" : "day")]);
      else rows.push([bodyName(b), tr("result.suppressed_paren", { reason: (v && v.reason) || "BIRTH_TIME_UNKNOWN" }), "", ""]);
    });
    techBody.appendChild(simpleTable([tr("result.th_body"), tr("result.th_position"), tr("result.th_motion"), tr("result.th_speed")], rows));

    techBody.appendChild(txt("h2", tr("result.angles")));
    if (chart.angles) {
      techBody.appendChild(txt("p", tr("result.asc_mc", { asc: posStr(chart.angles.asc, false), mc: posStr(chart.angles.mc, false) })));
    } else {
      techBody.appendChild(txt("p", tr("result.angles_suppressed")));
    }

    techBody.appendChild(txt("h2", tr("result.nodes")));
    if (chart.nodes && chart.nodes.mean_node) {
      var n = chart.nodes.mean_node;
      techBody.appendChild(simpleTable([tr("result.th_node"), tr("result.th_position"), tr("result.th_motion")], [
        [tr("result.node_mean"), posStr(n, false), tr("result.retrograde")],
        [tr("result.node_true"), tr("result.node_true_v"), ""]
      ]));
    } else {
      techBody.appendChild(txt("p", tr("result.nodes_timed_only")));
    }

    techBody.appendChild(txt("h2", tr("result.cusps")));
    techBody.appendChild(txt("p", tr("result.cusps_note"), "small"));
    if (chart.houses) {
      techBody.appendChild(simpleTable([tr("result.th_house"), tr("result.th_cusp", { sys: tr("names.house_systems." + chart.houses.system) || chart.houses.system })],
        chart.houses.cusps.map(function (c, i) { return [String(i + 1), posStr(c, false)]; })));
    } else {
      techBody.appendChild(txt("p", tr("result.cusps_suppressed")));
    }

    techBody.appendChild(txt("h2", tr("result.aspects")));
    var an = dictGet(["names", "aspects"]);
    var arows = chart.aspects.map(function (a) {
      var phase = a.applying === null ? tr("result.phase_to_angle")
        : (a.applying ? tr("result.phase_applying") : tr("result.phase_separating"));
      return [bodyName(a.a) + " \u2014 " + bodyName(a.b) + ": " + ((an && an[a.type]) || a.type),
        tr("result.th_orb").toLowerCase() + " " + a.orb + "\u00B0", phase];
    });
    techBody.appendChild(arows.length ? simpleTable([tr("result.th_aspect"), tr("result.th_orb"), tr("result.th_phase")], arows)
      : txt("p", tr("result.no_aspects")));

    var readingPre = txt("pre", localizedReading(chart, question));
    techBody.appendChild(txt("h2", tr("result.reading_h")));
    techBody.appendChild(readingPre);
    observeReading(human); // v1 rule: the human-reading layer is the consumed surface

    techBody.appendChild(txt("h2", tr("result.flags_h")));
    var flags = el("p");
    chart.flags.forEach(function (f) { flags.appendChild(chip(f)); });
    techBody.appendChild(flags);

    techBody.appendChild(txt("h2", tr("result.provenance_h")));
    var libs = chart.engine.libraries;
    techBody.appendChild(simpleTable([tr("result.th_field"), tr("result.th_value")], [
      [tr("result.p_engine"), chart.engine.id + " " + chart.engine.version + " (schema " + chart.schema_version + ")"],
      [tr("result.p_poslib"), libs["astronomy-engine"]],
      [tr("result.p_houses"), libs["houses/nodes"]],
      [tr("result.p_tzdb"), libs["tzdb"]],
      [tr("result.p_conventions"), chart.provenance.conventions],
      [tr("result.p_verification"), tr("result.p_verification_v")],
      [tr("result.p_computed"), tr("result.p_computed_v", { ts: chart.provenance.computed_at })]
    ]));

    techBody.appendChild(txt("h2", tr("result.limits_h")));
    var ul = el("ul");
    (dictGet(["result", "limits"]) || []).forEach(function (s) { ul.appendChild(txt("li", s)); });
    techBody.appendChild(ul);

    box.appendChild(tech);

    var share = el("p");
    share.appendChild(txt("span", tr("result.share_note") + " ", "small"));
    var shareBtn = txt("button", tr("result.share_link"), "chip");
    shareBtn.type = "button";
    shareBtn.addEventListener("click", function () {
      var wave = (window.SFERA_TELEMETRY_CONFIG || {}).wave || "001";
      var link = new URL("?src=share&wave=" + encodeURIComponent(wave), document.baseURI).href;
      shareVia(shareBtn, "link", link);
    });
    var copyBtn = txt("button", tr("result.share_text"), "chip");
    copyBtn.type = "button";
    copyBtn.addEventListener("click", function () {
      shareVia(copyBtn, "text", localizedReading(chart, question));
    });
    share.appendChild(shareBtn);
    share.appendChild(document.createTextNode(" "));
    share.appendChild(copyBtn);
    box.appendChild(share);

    box.appendChild(buildFeedback());

    return box;
  }

  function chipPlace(p) {
    var parts = [p.name];
    if (p.admin1 && p.admin1.toLowerCase() !== p.name.toLowerCase()) parts.push(p.admin1);
    if (p.country) parts.push(p.country);
    return chip(parts.join(", "));
  }

  function shareVia(button, target, text) {
    var done = function () { var old = button.textContent; button.textContent = tr("result.copied");
      setTimeout(function () { button.textContent = old; }, 1500); };
    var isLink = target === "link";
    if (isLink && navigator.share) {
      T.shareTool(target, "webshare");
      navigator.share({ title: "SFERA Lab", url: text }).catch(function () {});
      done();
      return;
    }
    T.shareTool(target, "clipboard");
    copyText(button, text, done);
  }

  function copyText(button, text, doneFn) {
    var done = doneFn || function () { var old = button.textContent; button.textContent = tr("result.copied");
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
    err.setAttribute("role", "alert");
    err.appendChild(txt("strong", title));
    err.appendChild(txt("p", message));
    box.appendChild(err);
  }

  // ---------------------------------------------------------------- honest reading_consumed (v1)

  function observeReading(readingNode) {
    var seen = false;
    function mark(how) { if (seen) return; seen = true; T.markReadingSeen(how); }
    try {
      if ("IntersectionObserver" in window) {
        var visibleMs = 0, last = null;
        var io = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting && e.intersectionRatio >= 0.4) {
              if (last === null) last = Date.now();
            } else if (last !== null) {
              visibleMs += Date.now() - last; last = null;
              if (visibleMs >= 3000) mark("scroll");
            }
          });
        }, { threshold: [0.4] });
        io.observe(readingNode);
        var iv = setInterval(function () {
          if (seen) { clearInterval(iv); return; }
          if (last !== null) {
            visibleMs += Date.now() - last; last = Date.now();
            if (visibleMs >= 3000) { mark("scroll"); clearInterval(iv); }
          }
        }, 500);
      }
    } catch (e) { /* observer unavailable: dwell rule still applies */ }
    // dwell rule: 20 s of visible foreground time after render
    var dwell = 0;
    var dv = setInterval(function () {
      if (seen) { clearInterval(dv); return; }
      if (document.visibilityState === "visible") {
        dwell += 1;
        if (dwell >= 20) { mark("dwell"); clearInterval(dv); }
      }
    }, 1000);
  }

  // ---------------------------------------------------------------- feedback instrument (≤5 questions)

  function buildFeedback() {
    var box = el("div");
    box.className = "feedback";
    box.appendChild(txt("h2", tr("result.feedback_h")));
    box.appendChild(txt("p", tr("result.feedback_intro"), "small"));
    var form = el("form");
    form.id = "feedback-form";

    function radioGroup(name, label, opts) {
      var wrap = el("fieldset");
      wrap.appendChild(txt("legend", label));
      wrap.style.border = "0";
      opts.forEach(function (o, i) {
        var lab = el("label");
        lab.className = "fb-opt";
        var r = document.createElement("input");
        r.type = "radio"; r.name = name; r.value = String(i);
        r.style.width = "auto"; r.style.marginRight = ".4rem";
        lab.appendChild(r);
        lab.appendChild(document.createTextNode(" " + o));
        wrap.appendChild(lab);
      });
      return wrap;
    }
    function textArea(name, label, ph) {
      var wrap = el("div");
      var ta = document.createElement("textarea");
      ta.name = name; ta.maxLength = 500; ta.placeholder = ph || "";
      ta.rows = 2;
      wrap.appendChild(txt("label", label));
      wrap.appendChild(ta);
      return wrap;
    }
    form.appendChild(radioGroup("a1", tr("result.f1"), dictGet(["result", "f1_opts"]) || []));
    form.appendChild(textArea("a2", tr("result.f2"), tr("result.f2_ph")));
    form.appendChild(textArea("a3", tr("result.f3"), tr("result.f3_ph")));
    form.appendChild(radioGroup("a4", tr("result.f4"), dictGet(["result", "f4_opts"]) || []));
    form.appendChild(textArea("a5", tr("result.f5"), tr("result.f5_ph")));

    var note = txt("p", "", "small");
    var send = txt("button", tr("result.f_send"));
    send.type = "submit";
    var skip = txt("button", tr("result.f_skip"), "chip");
    skip.type = "button";
    skip.addEventListener("click", function () { box.textContent = ""; });
    form.appendChild(send);
    form.appendChild(document.createTextNode(" "));
    form.appendChild(skip);
    form.appendChild(note);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!T.consented()) {
        note.textContent = tr("result.f_consent_off");
        return;
      }
      var fd = new FormData(form);
      T.feedback({ a1: fd.get("a1") || "", a2: fd.get("a2") || "", a3: fd.get("a3") || "",
        a4: fd.get("a4") || "", a5: fd.get("a5") || "" });
      T.flush();
      box.textContent = "";
      box.appendChild(txt("p", tr("result.f_sent")));
    });
    box.appendChild(form);
    return box;
  }

  // ---------------------------------------------------------------- city picker (accessible combobox)

  var picker = { input: null, list: null, status: null, open: false, options: [], active: -1, place: null, deb: null };

  function fmtPlacePrimary(p) {
    var parts = [p.name];
    if (p.admin1 && p.admin1.toLowerCase() !== p.name.toLowerCase()) parts.push(p.admin1);
    if (p.country) parts.push(p.country);
    return parts.join(", ");
  }
  function fmtPlaceSecondary(p) {
    var bits = [];
    if (p.tz) bits.push(p.tz);
    if (p.population >= 1000) bits.push(tr("place_search.population_k", { n: Math.round(p.population / 1000) }));
    bits.push(p.source === "open-meteo" ? tr("place_search.label_remote") : tr("place_search.label_local"));
    return bits.join(" · ");
  }

  function closeList() {
    picker.open = false; picker.active = -1;
    if (picker.list) { picker.list.textContent = ""; picker.list.hidden = true; }
    if (picker.input) picker.input.setAttribute("aria-expanded", "false");
  }

  function renderOptions(list, meta) {
    picker.options = list || [];
    picker.list.textContent = "";
    if (!picker.options.length) {
      var li = txt("li", (meta && meta.net === false) ? tr("place_search.network_error") : tr("place_search.not_found"), "city-empty");
      li.setAttribute("aria-disabled", "true");
      picker.list.appendChild(li);
      picker.list.hidden = false;
      picker.input.setAttribute("aria-expanded", "true");
      picker.open = true;
      return;
    }
    picker.options.forEach(function (p, i) {
      var li = el("li");
      li.setAttribute("role", "option");
      li.id = "city-opt-" + i;
      li.className = "city-opt";
      li.appendChild(txt("div", fmtPlacePrimary(p), "city-name"));
      li.appendChild(txt("div", fmtPlaceSecondary(p), "city-sub"));
      li.addEventListener("mousedown", function (ev) { ev.preventDefault(); pickPlace(p); });
      picker.list.appendChild(li);
    });
    picker.list.hidden = false;
    picker.input.setAttribute("aria-expanded", "true");
    picker.open = true;
    picker.active = -1;
  }

  function pickPlace(p) {
    picker.place = p;
    picker.input.value = fmtPlacePrimary(p);
    document.getElementById("lat").value = p.lat;
    document.getElementById("lon").value = p.lon;
    if (p.tz) document.getElementById("tz").value = p.tz;
    closeList();
  }

  function runSearch(q) {
    if (q.trim().length < 2) { closeList(); return; }
    picker.list.hidden = false;
    picker.list.textContent = "";
    var li = txt("li", tr("place_search.searching"), "city-empty");
    picker.list.appendChild(li);
    picker.input.setAttribute("aria-expanded", "true");
    P.search(q, cities, LANG).then(function (res) {
      if (!res.results.length) {
        renderOptions([], { net: res.ok });
        if (!res.ok && picker.status) picker.status.textContent = tr("place_search.network_error");
        return;
      }
      if (picker.status) picker.status.textContent = "";
      renderOptions(res.results, { net: res.ok });
    });
  }

  function wireCityPicker() {
    var input = document.getElementById("city");
    var list = document.getElementById("city-list");
    var status = document.getElementById("city-status");
    var unknownBtn = document.getElementById("unknown-time");
    var timeInput = document.getElementById("time");

    if (unknownBtn && timeInput) {
      unknownBtn.addEventListener("click", function () {
        timeInput.value = "";
        status && (status.textContent = tr("time_education.unknown_applied"));
      });
    }
    if (!input || !list || !P) return;
    picker.input = input; picker.list = list; picker.status = status;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", "city-list");
    input.setAttribute("aria-autocomplete", "list");
    list.setAttribute("role", "listbox");
    if (status) status.setAttribute("aria-live", "polite");

    input.addEventListener("input", function () {
      picker.place = null; // typed text invalidates a previous structured pick
      if (picker.deb) clearTimeout(picker.deb);
      var q = input.value;
      picker.deb = setTimeout(function () { runSearch(q); }, 280);
    });
    input.addEventListener("keydown", function (ev) {
      if (!picker.open) return;
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        var dir = ev.key === "ArrowDown" ? 1 : -1;
        picker.active = Math.min(Math.max(picker.active + dir, 0), picker.options.length - 1);
        Array.prototype.forEach.call(picker.list.children, function (li, i) {
          li.setAttribute("aria-selected", i === picker.active ? "true" : "false");
        });
        var act = picker.list.children[picker.active];
        if (act) { act.id = "city-opt-" + picker.active; input.setAttribute("aria-activedescendant", act.id); }
      } else if (ev.key === "Enter") {
        if (picker.active >= 0 && picker.options[picker.active]) { ev.preventDefault(); pickPlace(picker.options[picker.active]); }
        // Enter with no active option: form submits; validation requires coords or a pick
      } else if (ev.key === "Escape") {
        closeList();
      }
    });
    input.addEventListener("blur", function () { setTimeout(closeList, 150); });
  }

  // ---------------------------------------------------------------- boot

  document.addEventListener("DOMContentLoaded", function () {
    T.trackTrafficIn();
    T.trackPageContext();

    var consent = document.getElementById("consent");
    if (consent && T.consentRecord) consent.checked = T.consentRecord.consent;
    if (consent) consent.addEventListener("change", function () { T.setConsent(consent.checked); });

    var form = document.getElementById("chart-form");
    var result = document.getElementById("result");
    if (!form) return;

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      result.textContent = "";
      closeList();
      var fd = new FormData(form);
      var parsed;
      try { parsed = validate(fd, picker.place); }
      catch (e) {
        var msg = (e && e.validation) ? (tr(e.key) || e.key) : tr("errors.invalid_input");
        showError(result, tr("errors.check_form"), msg);
        return;
      }
      T.track("birth_start", { btk: !!parsed.birth.time, hs: parsed.houses });
      var chart;
      try {
        chart = SE.computeChart(parsed.birth, { house_system: parsed.houses });
      } catch (e) {
        var cls = (e && e.message === "NONEXISTENT_LOCAL_TIME_DST_GAP") ? "DST_GAP"
          : (e && e.message === "INVALID_DATE_OR_TIME") ? "INVALID_DATE_OR_TIME" : "OTHER_ENGINE";
        T.track("calculation_error", { err_class: cls });
        if (e && e.message === "NONEXISTENT_LOCAL_TIME_DST_GAP") {
          showError(result, tr("errors.dst_gap_title"), tr("errors.dst_gap"));
        } else if (e && e.message === "INVALID_DATE_OR_TIME") {
          showError(result, tr("errors.invalid_dt_title"), tr("errors.invalid_dt"));
        } else {
          showError(result, tr("errors.calc_fail_title"), tr("errors.calc_fail"));
        }
        return;
      }
      T.track("calc_complete", { ok: true, hs: parsed.houses, fl: chart.flags });
      T.markRendered();
      result.appendChild(renderChart(parsed.birth, { house_system: parsed.houses }, chart, parsed.question, parsed.placeLabel));
      result.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
})();
