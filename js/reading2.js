/* SFERA Lab — Human Reading v0.2 synthesis (EXECUTION_005).
 *
 * Pipeline (founder addendum Part 12, deterministic mode D):
 *   verified chart (sfera_engine.js, untouched)
 *     → interpretation atoms (authored KB: i18n/reading2-ru.json)
 *     → section composition with contradiction graph + importance ranking
 *     → grounded prose (every paragraph records its factors)
 *     → L1 quick portrait / L2 deep reading / L3 evidence+technical layers
 *
 * HARD RULES: no chart recalculation; no invented positions/aspects; no personal
 * history inferences; planet/house/aspect vocabulary stays OUT of the L1/L2 prose
 * (it lives in the evidence layer); nothing here talks to the network.
 */
(function (root) {
  "use strict";

  var SIGN_ENERGY = { Aries: "fire", Leo: "fire", Sagittarius: "fire", Taurus: "earth", Virgo: "earth", Capricorn: "earth", Gemini: "air", Libra: "air", Aquarius: "air", Cancer: "water", Scorpio: "water", Pisces: "water" };
  var OUTER = ["uranus", "neptune", "pluto"];
  var PERSONAL = ["sun", "moon", "mercury", "venus", "mars"];

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  var _ui = null; // set by build(); TT resolves titles/meta against its dict
  function TT(path) {
    var cur = _ui.t;
    path.split(".").forEach(function (k) { cur = cur[k]; });
    return cur === undefined ? path : cur;
  }
  function dot(s) { s = String(s || "").trim(); if (!s) return s; return /[.!?…]$/.test(s) ? s : s + "."; }

  function build(chart, KB, ui) {
    _ui = ui;
    var root_ = ui.el("div");
    root_.className = "human-reading hr2";
    var timed = !!(chart.angles && chart.houses);
    var ev = []; // {section, factors:[]} — evidence trail
    var usedDynamics = {};
    var usedGeneric = { hard: false, soft: false };

    function P(factors) { return { f: factors || [] }; } // paragraph marker
    function sec(title, paras, secId, factors) {
      var b = ui.el("section"); b.className = "hr-block";
      b.appendChild(ui.txt("h3", title));
      paras.forEach(function (p) { b.appendChild(ui.txt("p", p)); });
      if (factors && factors.length) {
        var d = ui.el("details"); d.className = "hr-ev";
        var s = ui.el("summary"); s.textContent = TT("titles.evidence_btn"); d.appendChild(s);
        var ul = ui.el("ul");
        factors.forEach(function (f) { ul.appendChild(ui.txt("li", f, "small")); });
        d.appendChild(ul);
        d.appendChild(ui.txt("p", TT("meta.school") + " · " + KB.meta.version, "small"));
        b.appendChild(d);
        ev.push({ section: title, factors: factors });
      }
      root_.appendChild(b);
      return b;
    }

    // ---------- atoms ----------
    var sun = chart.planets.sun, moon = chart.planets.moon, merc = chart.planets.mercury,
        venus = chart.planets.venus, mars = chart.planets.mars;
    var sunE = SIGN_ENERGY[sun.sign], moonE = moon.sign ? SIGN_ENERGY[moon.sign] : null;
    var ascE = chart.angles ? SIGN_ENERGY[chart.angles.asc.sign] : null;
    var moonSup = !moon.sign;

    function elemPair(a, b) {
      if (!a || !b || a === b) return a;
      var x = [a, b].sort().join("_");
      return x; // e.g. "earth_water"
    }
    function mismatchKey(a, b) {
      if (!a || !b) return null;
      return a === b ? a + "_" + a : [a, b].sort().join("_");
    }
    function mismatchText(a, b) { // KB keys are author-order; try both directions
      if (!a || !b) return null;
      if (a === b) return KB.mismatch[a + "_" + a] || null;
      return KB.mismatch[a + "_" + b] || KB.mismatch[b + "_" + a] || null;
    }
    var usedMismatch = {};
    function mismatchOnce(a, b) { // same tension text must not repeat across sections
      var key = mismatchKey(a, b);
      if (!key || usedMismatch[key]) return null;
      var txt = mismatchText(a, b);
      if (txt) usedMismatch[key] = true;
      return txt;
    }

    function dyn(id) {
      var generic = id.indexOf("generic_") === 0;
      if (!generic && usedDynamics[id]) return null;
      var body = KB.dynamics[id];
      if (!body) return null;
      if (!generic) usedDynamics[id] = true;
      return body;
    }

    function aspectBetween(a, b) {
      return chart.aspects.find(function (x) {
        return (x.a === a && x.b === b) || (x.a === b && x.b === a);
      }) || null;
    }
    function aspectsOf(planet, types) {
      return chart.aspects.filter(function (x) {
        return (x.a === planet || x.b === planet) && (!types || types.indexOf(x.type) !== -1);
      }).sort(function (p, q) { return p.orb - q.orb; });
    }
    function dynForAspect(a, b, type) {
      var hard = (type === "square" || type === "opposition");
      var soft = (type === "trine" || type === "sextile");
      var pair = [a, b].sort().join("_");
      var id = (hard ? "hard_" : soft ? "soft_" : "conj_") + pair;
      var body = dyn(id);
      if (!body) {
        if (hard === true && !usedGeneric.hard) { usedGeneric.hard = true; body = KB.dynamics.generic_hard; }
        else if (soft === true && !usedGeneric.soft) { usedGeneric.soft = true; body = KB.dynamics.generic_soft; }
        if (body) usedDynamics["generic:" + a + b] = true;
      }
      if (!body) return null;
      var d = aspectBetween(a, b);
      return { body: dot(body), factors: [capName(a) + " — " + capName(b) + (d ? " (орб " + d.orb + "°)" : "")] };
    }
    function signRu(sign) { return (KB.meta.signs_gen && KB.meta.signs_gen[sign]) || sign; }
    function capName(k) {
      var names = { sun: "Солнце", moon: "Луна", mercury: "Меркурий", venus: "Венера", mars: "Марс",
        jupiter: "Юпитер", saturn: "Сатурн", uranus: "Уран", neptune: "Нептун", pluto: "Плутон",
        asc: "Асцендент", mc: "MC" };
      return names[k] || k;
    }

    // element dominance over the five personal points + asc
    function elementCounts() {
      var c = { fire: 0, earth: 0, air: 0, water: 0 };
      [sun, moon, merc, venus, mars].forEach(function (p) { if (p && p.sign) c[SIGN_ENERGY[p.sign]]++; });
      if (chart.angles) c[SIGN_ENERGY[chart.angles.asc.sign]]++;
      return c;
    }
    var ec = elementCounts();
    var domSorted = Object.keys(ec).sort(function (a, b) { return ec[b] - ec[a]; });
    var domE = domSorted[0];
    var domOk = ec[domE] >= 3 && ec[domE] > ec[domSorted[1]];
    var lackE = Object.keys(ec).sort(function (a, b) { return ec[a] - ec[b]; })[0];

    // specials: outer conjunctions to personal points / angles (tightest first)
    function specials() {
      var out = [];
      chart.aspects.forEach(function (a) {
        if (a.type !== "conjunction" || a.orb > 6) return;
        var pair = [a.a, a.b];
        var outerSide = pair.indexOf(pair.filter(function (k) { return OUTER.indexOf(k) !== -1; })[0]);
        if (outerSide === -1) return;
        var personalSide = pair[1 - outerSide];
        if (PERSONAL.indexOf(personalSide) === -1 && personalSide !== "asc") return;
        var id = "conj_" + personalSide + "_" + pair[outerSide];
        if (KB.dynamics[id]) out.push({ id: id, orb: a.orb, factors: [capName(a.a) + " соединение " + capName(a.b) + " (орб " + a.orb + "°)"] });
      });
      return out.sort(function (x, y) { return x.orb - y.orb; });
    }
    var specialList = specials();

    // ---------- L1: Коротко о вас ----------
    var l1 = [];
    var l1f = ["Солнце в " + signRu(sun.sign)];
    l1.push(cap(KB.sun[sun.sign].core));
    if (!moonSup) {
      l1.push("Внутри вы устроены чувствительнее, чем может казаться: " + KB.moon[moon.sign].need);
      l1f.push("Луна в " + signRu(moon.sign));
    }
    if (moonSup) {
      l1.push("Как вы думаете и решаете: " + KB.mercury[merc.sign].mind);
      l1f.push("Меркурий в " + merc.sign);
    }
    if (ascE) {
      var maskText = String(KB.asc[chart.angles.asc.sign].mask).split(": ").slice(1).join(": ");
      l1.push("Со стороны вас чаще всего читают иначе — как " + maskText + ". Это не маска, просто наружный слой устроен по своим правилам.");
      l1f.push("Асцендент в " + signRu(chart.angles.asc.sign));
      if (!moonSup && moonE !== ascE) {
        var mmL1 = mismatchOnce(moonE, ascE);
        if (mmL1) {
          l1.push(mmL1.body || mmL1);
          l1f.push("Луна/Асцендент в разных стихиях (" + moonE + " vs " + ascE + ")");
        }
      }
    }
    l1.push("Что вас двигает: " + String(KB.mars[mars.sign].drive).replace(/^вас двигает\s*/, ""));
    l1f.push("Марс в " + signRu(mars.sign));
    l1.push(cap(KB.venus[venus.sign].attract));
    l1f.push("Венера в " + signRu(venus.sign));
    if (specialList.length) {
      l1.push(dot(KB.dynamics[specialList[0].id]));
      l1f.push(specialList[0].factors[0]);
    }
    l1.push("Всё, что выше, — сжатый пересказ. Глубокий разбор по темам — ниже, а каждая строка остаётся привязанной к карте (раскрывается кнопкой «Почему SFERA так говорит»).");

    root_.appendChild(ui.txt("h2", TT("titles.main_h")));
    root_.appendChild(ui.txt("p", TT("titles.lead"), "small"));
    var l1sec = ui.el("section"); l1sec.className = "hr-block";
    l1sec.appendChild(ui.txt("h3", TT("titles.l1_h")));
    l1.forEach(function (s) { l1sec.appendChild(ui.txt("p", dot(s))); });
    root_.appendChild(l1sec);
    ev.push({ section: TT("titles.l1_h"), factors: l1f });

    // L1 evidence is intentionally NOT expanded by default; single section-level details:
    (function () {
      var d = ui.el("details"); d.className = "hr-ev";
      var s = ui.el("summary"); s.textContent = TT("titles.evidence_btn"); d.appendChild(s);
      var ul = ui.el("ul");
      l1f.forEach(function (f) { ul.appendChild(ui.txt("li", f, "small")); });
      d.appendChild(ul);
      d.appendChild(ui.txt("p", KB.meta.school + " · " + KB.meta.version, "small"));
      l1sec.appendChild(d);
    })();

    // L2 toggle
    var l2wrap = ui.el("div"); l2wrap.hidden = true;
    var l2btn = ui.txt("button", TT("titles.l2_btn"), "chip");
    l2btn.type = "button";
    l2btn.addEventListener("click", function () {
      l2wrap.hidden = !l2wrap.hidden;
      l2btn.textContent = l2wrap.hidden ? TT("titles.l2_btn") : TT("titles.l2_btn") + " ▲";
    });
    root_.appendChild(l2btn);
    root_.appendChild(l2wrap);

    function l2sec(title, build_) {
      var b = ui.el("section"); b.className = "hr-block";
      b.appendChild(ui.txt("h3", title));
      l2wrap.appendChild(b);
      var factors = [];
      function p(text, f) { b.appendChild(ui.txt("p", dot(text))); if (f) factors.push(f); }
      build_(p, b, factors);
      if (factors.length) {
        var d = ui.el("details"); d.className = "hr-ev";
        var s = ui.el("summary"); s.textContent = TT("titles.evidence_btn"); d.appendChild(s);
        var ul = ui.el("ul");
        factors.forEach(function (f) { ul.appendChild(ui.txt("li", f, "small")); });
        d.appendChild(ul);
        b.appendChild(d);
        ev.push({ section: title, factors: factors });
      }
      return b;
    }

    // ---------- L2 sections ----------
    // Какой вы внутри
    l2sec(TT("titles.s_inside"), function (p, _b, factors) {
      if (moonSup) { p(TT("titles.time_unknown")); return; }
      p(cap(KB.moon[moon.sign].need), "Луна в " + signRu(moon.sign) + " — потребность");
      p(cap(KB.moon[moon.sign].storm), "Луна в " + signRu(moon.sign) + " — реакция на боль");
      var mAsp = aspectsOf("moon").filter(function (x) { return ["square", "opposition"].indexOf(x.type) !== -1; })[0]
        || aspectsOf("moon").filter(function (x) { return ["conjunction"].indexOf(x.type) !== -1 && OUTER.concat(["saturn"]).indexOf(x.a === "moon" ? x.b : x.a) !== -1; })[0];
      if (mAsp) {
        var other = mAsp.a === "moon" ? mAsp.b : mAsp.a;
        var dbody = dynForAspect("moon", other, mAsp.type);
        if (dbody && other !== "sun") { p(dbody.body); dbody.factors.forEach(function (f) { factors.push(f); }); }
      }
      p("Восстанавливает вас при этом довольно простое: " + KB.moon[moon.sign].soothe, "Луна в " + signRu(moon.sign) + " — восстановление");
    });

    // Как вы выглядите для других
    if (ascE) l2sec(TT("titles.s_seen"), function (p, _b, factors) {
      var maskText = String(KB.asc[chart.angles.asc.sign].mask).split(": ").slice(1).join(": ");
      p(cap(maskText) + ".", "Асцендент в " + signRu(chart.angles.asc.sign));
      p(KB.asc[chart.angles.asc.sign].inside_note, "Асцендент — что не видно");
      if (!moonSup && moonE !== ascE) {
        var mm = mismatchOnce(moonE, ascE);
        if (mm) p(mm.body || mm, "Стихия Луны (" + moonE + ") и Асцендента (" + ascE + ") различаются");
      }
    });

    // Как вы думаете
    l2sec(TT("titles.s_think"), function (p, _b, factors) {
      p(cap(KB.mercury[merc.sign].mind), "Меркурий в " + signRu(merc.sign) + " — стиль мышления");
      p(cap(KB.mercury[merc.sign].decide), "Меркурий в " + signRu(merc.sign) + " — решения");
      var mMars = dynForAspect("mercury", "mars", (aspectBetween("mercury", "mars") || {}).type);
      var mSat = dynForAspect("mercury", "saturn", (aspectBetween("mercury", "saturn") || {}).type);
      var picked = (aspectBetween("mercury", "mars") && ["square", "opposition", "conjunction"].indexOf(aspectBetween("mercury", "mars").type) !== -1) ? mMars : mSat;
      if (picked) { p(picked.body); picked.factors.forEach(function (f) { factors.push(f); }); }
      else p(cap(KB.mercury[merc.sign].talk), "Меркурий в " + signRu(merc.sign) + " — общение");
    });

    // Что вас двигает
    l2sec(TT("titles.s_drive"), function (p, _b, factors) {
      p(cap(String(KB.mars[mars.sign].drive).replace(/^вас двигает\s*/, "")), "Марс в " + signRu(mars.sign) + " — мотивация");
      p(cap(KB.mars[mars.sign].anger), "Марс в " + signRu(mars.sign) + " — гнев");
      p(cap(KB.mars[mars.sign].stamina), "Марс в " + signRu(mars.sign) + " — выносливость");
      p("Про ответственность: " + KB.saturn_work[chart.planets.saturn.sign] + ".", "Сатурн в " + signRu(chart.planets.saturn.sign));
    });

    // Любовь и близость
    l2sec(TT("titles.s_love"), function (p, _b, factors) {
      p(cap(KB.venus[venus.sign].attract), "Венера в " + signRu(venus.sign) + " — влечение");
      p(cap(KB.venus[venus.sign].care), "Венера в " + signRu(venus.sign) + " — забота");
      p(cap(KB.venus[venus.sign].friction), "Венера в " + signRu(venus.sign) + " — трудное место");
      var vm = aspectBetween("venus", "mars");
      if (vm && vm.type !== "trine" && vm.type !== "sextile") {
        var dbody = dynForAspect("venus", "mars", vm.type);
        if (dbody) { p(dbody.body); dbody.factors.forEach(function (f) { factors.push(f); }); }
      }
    });

    // Сильные стороны
    l2sec(TT("titles.s_strong"), function (p, _b, factors) {
      if (domOk) p(KB.elements["dominant_" + domE], "доминирующая стихия: " + domE + " (" + ec[domE] + " из 6 опорных точек)");
      else p(KB.elements.balanced, "стихии распределены ровно: " + ec.fire + "/" + ec.earth + "/" + ec.air + "/" + ec.water);
      if (ec[lackE] === 0) p(KB.elements["lacking_" + lackE], "почти отсутствующая стихия: " + lackE);
      var softs = chart.aspects.filter(function (x) { return x.type === "trine" || x.type === "sextile"; })
        .filter(function (x) { var a = PERSONAL.indexOf(x.a) !== -1, b = PERSONAL.indexOf(x.b) !== -1; return a && b; })
        .sort(function (m, n) { return m.orb - n.orb; }).slice(0, 2);
      softs.forEach(function (a) {
        var dbody = dynForAspect(a.a, a.b, a.type);
        if (dbody) { p(dbody.body); dbody.factors.forEach(function (f) { factors.push(f); }); }
      });
      if (!softs.length) {
        p("Отдельно стоят ваши устойчивые места: то, что у вас устроено последовательно, работает как ресурс — " +
          KB.sun[sun.sign].core + " При этом вы умеете на это опираться, когда вокруг всё качается.", "ядро карты без напряжённых связей");
      }
    });

    // Что может мешать
    l2sec(TT("titles.s_hinder"), function (p, _b, factors) {
      p(cap(KB.sun[sun.sign].cost), "Солнце в " + signRu(sun.sign) + " — цена");
      var hards = chart.aspects.filter(function (x) { return x.type === "square" || x.type === "opposition"; })
        .filter(function (x) { var a = PERSONAL.indexOf(x.a) !== -1 || x.a === "asc", b = PERSONAL.indexOf(x.b) !== -1 || x.b === "asc"; return a && b; })
        .sort(function (m, n) { return m.orb - n.orb; });
      var taken = 0;
      hards.forEach(function (a) {
        if (taken >= 1) return;
        var dbody = dynForAspect(a.a, a.b, a.type);
        if (dbody && !dbody._used) { p(dbody.body + " Это не приговор — просто ваш рабочий узел: он же даёт вам энергию, когда вы с ним справляетесь."); dbody.factors.forEach(function (f) { factors.push(f); }); taken++; }
      });
      if (!taken) p("В давящей ситуации вашим узлом становится вот это: " + KB.mars[mars.sign].anger + " Зная это про себя, вы успеваете выбрать реакцию, а не получить её автоматически.", "Марс в " + signRu(mars.sign) + " — гнев под давлением");
    });

    // Внутренние противоречия
    l2sec(TT("titles.s_conflict"), function (p, _b, factors) {
      var sm = aspectBetween("sun", "moon");
      var smHard = sm && (sm.type === "square" || sm.type === "opposition");
      var mmSM = mismatchOnce(sunE, moonE);
      if (smHard || (sunE !== moonE && mmSM)) {
        p(mmSM ? (mmSM.body || mmSM) : dot(KB.dynamics.hard_sun_moon),
          "Стихии Солнца (" + sunE + ") и Луны (" + (moonSup ? "n/a" : moonE) + ") различаются");
      }
      var dsm = smHard ? dyn("hard_sun_moon") : null;
      if (dsm) { p(dot(dsm), "Солнце — Луна, напряжённый аспект (орб " + sm.orb + "°)"); }
      var extra = chart.aspects.filter(function (x) { return x.type === "square" || x.type === "opposition"; })
        .filter(function (x) { var pair = [x.a, x.b].sort().join("_"); return ["moon_venus", "sun_mars", "venus_mars", "mercury_moon", "moon_mars"].indexOf(pair) !== -1; })
        .sort(function (m, n) { return m.orb - n.orb; });
      var used = 0;
      extra.forEach(function (a) {
        if (used >= 1) return;
        var dbody = dynForAspect(a.a, a.b, a.type);
        if (dbody) { p(dbody.body); dbody.factors.forEach(function (f) { factors.push(f); }); used++; }
      });
      if (!smHard && !(sunE !== moonE && mmSM) && !used) {
        p("Ваша карта устроена скорее согласованно: внутренние споры у вас редки, а главные ростовые напряжения описаны в соседнем разделе.", "нет выраженных внутренних оппозиций в личных точках");
      }
    });

    // Работа и амбиции
    l2sec(TT("titles.s_work"), function (p, _b, factors) {
      p(cap(KB.saturn_work[chart.planets.saturn.sign]) + ".", "Сатурн в " + signRu(chart.planets.saturn.sign) + " — стиль ответственности");
      p(cap(KB.mars[mars.sign].stamina) + " В связке с тем, что " + KB.sun[sun.sign].core + ", ваш рабочий почерк получается узнаваемым: не самым шумным, но своим.", "Марс в " + signRu(mars.sign) + " + Солнце в " + sun.sign);
      p("Важно: карта описывает стиль, а не должность и не доход. Ни один текст здесь не является обещанием результата.", "граница интерпретации");
    });

    // Что в вас особенного
    l2sec(TT("titles.s_special"), function (p, _b, factors) {
      p(KB.special_intro || "Штрихи, которые встречаются реже среднего.", "");
      var usedSpecial = 0;
      specialList.slice(0, 3).forEach(function (sp) {
        var body = KB.dynamics[sp.id];
        if (body && usedSpecial < 3) { p(dot(body)); sp.factors.forEach(function (f) { factors.push(f); }); usedSpecial++; }
      });
      var tight = chart.aspects.slice().sort(function (a, b) { return a.orb - b.orb; })[0];
      if (tight && tight.orb <= 1.5 && usedSpecial < 3) {
        var dbody = dynForAspect(tight.a, tight.b, tight.type);
        if (dbody && !dbody._used) { p("Самая плотная связь в вашей карте выглядит так: " + dbody.body); dbody.factors.forEach(function (f) { factors.push(f); }); }
      }
      if (!usedSpecial) p("Ярких редких конфигураций в этой карте нет — портрет выше и есть самое главное. Это честный результат, а не пропущенный раздел.", "");
    });

    root_.appendChild(ui.txt("p", TT("titles.disclaimer"), "small"));
    if (!timed) root_.appendChild(ui.txt("p", TT("titles.time_unknown"), "small"));

    root_._evidence = ev;
    return root_;
  }

  root.SFERA_READING2 = { build: build };
})(window);
