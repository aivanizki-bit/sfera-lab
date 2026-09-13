/* SFERA Lab — global birth-place resolution (EXECUTION_004 hot patch, defect 2).
 *
 * Replaces the exact-name-match-into-a-tiny-list architecture that could not resolve
 * ordinary world localities (founder live-QA incident: Тюмень). Architecture (CHOICE C,
 * hybrid — decision recorded in the EXECUTION_004 report):
 *
 *   1. bundled local list (instant, offline, ~dozens of common cities);
 *   2. Open-Meteo Geocoding API (https://geocoding-api.open-meteo.com) — keyless, free,
 *      CORS `*`, GeoNames-derived (CC-BY 4.0), returns IANA timezone identity directly
 *      (never inferred from a current UTC offset — the engine's tzdb layer handles
 *      historic offsets/DST/LMT for the resolved identity);
 *   3. Cyrillic→Latin transliteration fallback query (GeoNames Russian alternate-name
 *      coverage has gaps: «Кагул» misses Cahul; translit "Kagul" hits it);
 *   4. manual lat/lon/IANA-tz entry stays in the form as the final fallback.
 *
 * PRIVACY (disclosed on /privacy): a place search sends ONLY the typed name string to
 * Open-Meteo as a GET query. No date, no time, no chart data, no telemetry identifiers
 * are attached; requests carry no credentials. Failing network degrades gracefully to
 * local/manual paths.
 */
(function (root) {
  "use strict";

  var API = "https://geocoding-api.open-meteo.com/v1/search";

  var CYR = { "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n",
    "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "kh",
    "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch", "ъ": "", "ы": "y", "ь": "",
    "э": "e", "ю": "yu", "я": "ya", "і": "i", "ї": "yi", "є": "ye", "ґ": "g" };

  function translit(s) {
    return String(s).split("").map(function (ch) {
      var low = ch.toLowerCase(), tr = CYR[low];
      if (tr === undefined) return ch;
      if (ch === low) return tr; // lowercase source
      return tr.charAt(0).toUpperCase() + tr.slice(1); // keep initial caps readable
    }).join("");
  }

  function hasCyrillic(s) { return /[\u0400-\u04FF]/.test(s); }

  function norm(s) {
    return String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  }

  function fetchJSON(url, signal) {
    return fetch(url, { signal: signal, credentials: "omit", mode: "cors" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }

  function remoteURL(query, lang, signal) {
    return API + "?name=" + encodeURIComponent(query) + "&count=10&format=json" +
      "&language=" + encodeURIComponent(lang === "ru" ? "ru" : "en");
  }

  function mapRemote(r, matchName) {
    return {
      id: "om-" + r.id,
      name: r.name,
      // `_match` = canonical (en) name used ONLY for ranking vs the typed query;
      // `name`/`country`/`admin1` stay in the UI display language.
      _match: matchName || r.name,
      admin1: r.admin1 || "",
      country: r.country || "",
      lat: Math.round(r.latitude * 10000) / 10000,
      lon: Math.round(r.longitude * 10000) / 10000,
      tz: r.timezone || "",
      population: r.population || 0,
      source: "open-meteo"
    };
  }

  function mapLocal(c) {
    return {
      id: "local-" + norm(c.name) + "-" + c.country_code,
      name: c.name, _match: c.name, admin1: c.region || "", country: c.country || c.country_code || "",
      lat: c.lat, lon: c.lon, tz: c.tz, population: c.population || 0, source: "local"
    };
  }

  function editDistLE1(a, b) {
    if (a === b) return true;
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    var i = 0, j = 0, edited = false;
    while (i < la && j < lb) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (edited) return false;
      edited = true;
      if (la > lb) i++;
      else if (la < lb) j++;
      else { i++; j++; }
    }
    return true;
  }

  function rank(q, list) {
    var nq = norm(q);
    var nqLat = norm(translit(q));
    var nqFold = foldLatin(q);
    function tier(p) {
      var names = [norm(p.name)];
      if (p._match) names.push(norm(p._match));
      var best = 3;
      names.forEach(function (n) {
        var nFold = foldLatin(n);
        if (n === nq || n === nqLat) best = Math.min(best, 0);
        else if ((nq.length >= 4 && editDistLE1(n, nq)) || (nqLat.length >= 4 && editDistLE1(n, nqLat)))
          best = Math.min(best, 1); // one-letter variant of the same name («Кагул»↔GeoNames «Кахул»)
        else if (n.indexOf(nq) === 0 || n.indexOf(nqLat) === 0) best = Math.min(best, 1);
        else if (n.indexOf(nq) !== -1 || n.indexOf(nqLat) !== -1) best = Math.min(best, 2);
        else if (nqFold.length >= 3 && nFold.indexOf(nqFold.slice(0, 3)) === 0) best = Math.min(best, 2);
      });
      return best;
    }
    var sorted = list.slice().sort(function (a, b) {
      var t = tier(a) - tier(b);
      if (t !== 0) return t;
      return (b.population || 0) - (a.population || 0);
    });
    return promoteProminent(sorted, nqFold);
  }

  /* Prominence disambiguation (documented in the EXECUTION_004 report): a populated
   * place ≥100k whose latin-folded name shares the query's first three latin letters
   * outranks an unknown/unpopulated same-spelling hamlet (typing "München" must not
   * silently present two unpopulated hamlets while Munich sits below the fold). All
   * options stay listed — nothing is hidden, order only. */
  function promoteProminent(sorted, nqFold) {
    if (!sorted.length || (sorted[0].population || 0) >= 10000 || nqFold.length < 3) return sorted;
    for (var i = 1; i < sorted.length; i++) {
      var c = sorted[i];
      if ((c.population || 0) >= 100000 &&
          foldLatin(c._match || c.name).indexOf(nqFold.slice(0, 3)) === 0) {
        sorted.splice(i, 1);
        sorted.unshift(c);
        break;
      }
    }
    return sorted;
  }

  // diacritic-insensitive latin fold for ranking keys only (display names untouched)
  function foldLatin(s) {
    return norm(translit(String(s)))
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  }

  function dedupe(list) {
    var seen = {}, out = [];
    list.forEach(function (p) {
      var key = norm(p.name) + "|" + p.country + "|" + (p.admin1 || "") + "|" + p.lat + "," + p.lon;
      if (!seen[key]) { seen[key] = 1; out.push(p); }
    });
    return out;
  }

  var cache = {};

  /* Two concerns, two parallel requests (merged by GeoNames id):
   *   - language=en results provide the canonical match name used for RANKING;
   *   - language=<UI> results provide DISPLAY names in the visitor's language.
   * Cyrillic queries additionally fire a transliterated en query (GeoNames Russian
   * alternate-name coverage has gaps: «Кагул» misses Cahul; "Kagul" hits it).
   * Any single request may fail without sinking the whole search. */
  function search(query, localCities, lang) {
    var q = String(query || "").trim().slice(0, 80);
    if (q.length < 2) return Promise.resolve({ ok: true, results: [], stale: false });

    var key = norm(q) + "|" + lang;
    if (cache[key]) return Promise.resolve({ ok: true, results: cache[key], stale: false });

    var local = rank(q, (localCities || []).map(mapLocal)).slice(0, 5);

    var tasks = [
      fetchJSON(remoteURL(q, "en")).catch(function () { return null; }),   // 0: ranking
      fetchJSON(remoteURL(q, lang)).catch(function () { return null; })    // 1: display
    ];
    if (hasCyrillic(q)) {
      var t = translit(q);
      if (norm(t) !== norm(q)) {
        tasks.push(fetchJSON(remoteURL(t, "en")).catch(function () { return null; }));  // 2: ranking
        tasks.push(fetchJSON(remoteURL(t, lang)).catch(function () { return null; }));  // 3: display
      }
    }
    return Promise.all(tasks).then(function (rs) {
      var rankList = [], display = {};
      rs.forEach(function (r, i) {
        if (!r || !r.results) return;
        var isDisplay = (i === 1 || i === 3);
        r.results.forEach(function (x) {
          if (isDisplay) { display["om-" + x.id] = x; return; }
          rankList.push(mapRemote(x));
        });
      });
      rankList.forEach(function (p) {
        var d = display[p.id];
        if (d) { p.name = d.name; p.country = d.country || p.country; p.admin1 = d.admin1 || p.admin1; }
      });
      var netOk = rs.some(function (r) { return !!r; });
      var results = rank(q, dedupe(rankList.concat(local))).slice(0, 8);
      if (netOk) cache[key] = results;
      return { ok: netOk, results: results, local: local, stale: false };
    });
  }

  root.SFERA_PLACES = {
    search: search,
    translit: translit,
    _internals: { norm: norm, rank: rank, dedupe: dedupe, mapRemote: mapRemote, mapLocal: mapLocal }
  };
})(window);
