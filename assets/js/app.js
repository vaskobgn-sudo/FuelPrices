/* Fuel affordability table.
   Reads data/fuel_prices.json and renders it as a sortable table (wide
   screens) and a stack of cards (narrow screens) from the same state. */

(function () {
  "use strict";

  var DATA_URL = "data/fuel_prices.json";

  var COLUMNS = [
    { key: "country", label: "Държава", type: "text" },
    { key: "min_wage_eur_month", label: "Мин. заплата", unit: "€/мес.", type: "number", digits: 0, money: true },
    { key: "petrol_eur_l", label: "Бензин", unit: "€/л", type: "number", digits: 2, money: true },
    { key: "diesel_eur_l", label: "Дизел", unit: "€/л", type: "number", digits: 2, money: true },
    { key: "petrol_litres", label: "Литри бензин", unit: "л", type: "number", digits: 0, bar: true },
    { key: "diesel_litres", label: "Литри дизел", unit: "л", type: "number", digits: 0, bar: true }
  ];

  var state = { rows: [], sortKey: "country", sortDir: "asc", query: "" };

  var el = {
    status: document.getElementById("status"),
    empty: document.getElementById("empty"),
    table: document.getElementById("table"),
    headRow: document.getElementById("head-row"),
    body: document.getElementById("body"),
    cards: document.getElementById("cards"),
    stats: document.getElementById("stats"),
    updated: document.getElementById("updated"),
    search: document.getElementById("search"),
    sortSelect: document.getElementById("sort-select"),
    sortDir: document.getElementById("sort-dir"),
    sortDirIcon: document.getElementById("sort-dir-icon"),
    footerSources: document.getElementById("footer-sources")
  };

  var collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

  function fmtNumber(value, digits) {
    return new Intl.NumberFormat("bg-BG", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(value);
  }

  function formatCell(column, value) {
    if (value === null || value === undefined || value === "") return "—";
    if (column.type === "text") return String(value);
    return fmtNumber(value, column.digits) + (column.money ? " €" : "");
  }

  function flagEmoji(code) {
    if (!code || code.length !== 2 || code === "XK") return "";
    var chars = code.toUpperCase().split("").map(function (c) {
      return 0x1f1e6 + c.charCodeAt(0) - 65;
    });
    return String.fromCodePoint.apply(String, chars);
  }

  /* Diacritic-insensitive haystack for the search box. */
  function foldText(text) {
    var lowered = String(text).toLowerCase();
    return lowered.normalize ? lowered.normalize("NFD").replace(/[\u0300-\u036f]/g, "") : lowered;
  }

  function columnByKey(key) {
    for (var i = 0; i < COLUMNS.length; i++) {
      if (COLUMNS[i].key === key) return COLUMNS[i];
    }
    return COLUMNS[0];
  }

  function visibleRows() {
    var query = foldText(state.query.trim());
    var rows = state.rows.filter(function (row) {
      return !query || foldText(row.country).indexOf(query) !== -1;
    });

    var column = columnByKey(state.sortKey);
    var direction = state.sortDir === "asc" ? 1 : -1;

    return rows.sort(function (a, b) {
      var left = a[column.key];
      var right = b[column.key];

      // Rows without a value always sink to the bottom, in both directions.
      var leftMissing = left === null || left === undefined || left === "";
      var rightMissing = right === null || right === undefined || right === "";
      if (leftMissing || rightMissing) {
        if (leftMissing && rightMissing) return collator.compare(a.country, b.country);
        return leftMissing ? 1 : -1;
      }

      var result = column.type === "text"
        ? collator.compare(left, right)
        : left - right;

      // Ties fall back to the country name so the order stays stable.
      return result !== 0 ? result * direction : collator.compare(a.country, b.country);
    });
  }

  function maxLitres(rows) {
    return rows.reduce(function (max, row) {
      return Math.max(max, row.petrol_litres || 0, row.diesel_litres || 0);
    }, 0);
  }

  /* ---------- rendering ---------- */

  function buildHead() {
    COLUMNS.forEach(function (column) {
      var th = document.createElement("th");
      th.scope = "col";

      var button = document.createElement("button");
      button.type = "button";
      button.className = "th-button";

      var label = document.createElement("span");
      label.textContent = column.unit ? column.label + " (" + column.unit + ")" : column.label;

      var arrow = document.createElement("span");
      arrow.className = "th-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "↑";

      button.appendChild(label);
      button.appendChild(arrow);
      button.addEventListener("click", function () { toggleSort(column.key); });

      th.appendChild(button);
      th.dataset.key = column.key;
      el.headRow.appendChild(th);
    });
  }

  function paintSortIndicators() {
    var arrowUp = state.sortDir === "asc";

    Array.prototype.forEach.call(el.headRow.children, function (th) {
      var arrow = th.querySelector(".th-arrow");
      if (th.dataset.key === state.sortKey) {
        th.setAttribute("aria-sort", arrowUp ? "ascending" : "descending");
        arrow.textContent = arrowUp ? "↑" : "↓";
      } else {
        th.removeAttribute("aria-sort");
        arrow.textContent = "↑";
      }
    });

    el.sortSelect.value = state.sortKey;
    el.sortDirIcon.textContent = arrowUp ? "↑" : "↓";
    el.sortDir.setAttribute("title", arrowUp ? "Възходящо" : "Низходящо");
  }

  function renderTable(rows, scale) {
    el.body.textContent = "";

    rows.forEach(function (row) {
      var tr = document.createElement("tr");

      COLUMNS.forEach(function (column) {
        var td = document.createElement("td");
        var value = row[column.key];

        if (column.key === "country") {
          td.className = "country";
          var flag = flagEmoji(row.code);
          if (flag) {
            var span = document.createElement("span");
            span.className = "flag";
            span.setAttribute("aria-hidden", "true");
            span.textContent = flag;
            td.appendChild(span);
          }
          td.appendChild(document.createTextNode(row.country));
          tr.appendChild(td);
          return;
        }

        td.textContent = formatCell(column, value);
        if (value === null || value === undefined) td.className = "muted";
        else if (column.bar) td.className = "litres";

        if (column.bar && value && scale > 0) {
          var bar = document.createElement("span");
          bar.className = "cell-bar";
          bar.style.width = Math.max(2, (value / scale) * 100) + "%";
          td.appendChild(bar);
        }

        tr.appendChild(td);
      });

      el.body.appendChild(tr);
    });
  }

  function renderCards(rows, scale) {
    el.cards.textContent = "";

    rows.forEach(function (row) {
      var li = document.createElement("li");
      li.className = "card";

      var head = document.createElement("div");
      head.className = "card-head";

      var flag = flagEmoji(row.code);
      if (flag) {
        var flagEl = document.createElement("span");
        flagEl.className = "card-flag";
        flagEl.setAttribute("aria-hidden", "true");
        flagEl.textContent = flag;
        head.appendChild(flagEl);
      }

      var name = document.createElement("span");
      name.className = "card-name";
      name.textContent = row.country;
      head.appendChild(name);

      var wage = document.createElement("span");
      wage.className = "card-wage";

      var wageLabel = document.createElement("span");
      wageLabel.className = "card-wage-label";
      wageLabel.textContent = "Мин. заплата";

      var wageValue = document.createElement("span");
      wageValue.className = "card-wage-value";
      wageValue.textContent = formatCell(columnByKey("min_wage_eur_month"), row.min_wage_eur_month);

      wage.appendChild(wageLabel);
      wage.appendChild(wageValue);
      head.appendChild(wage);

      li.appendChild(head);

      var grid = document.createElement("div");
      grid.className = "card-grid";

      COLUMNS.slice(2).forEach(function (column) {
        var value = row[column.key];

        var metric = document.createElement("div");
        metric.className = "metric" + (column.bar ? " is-litres" : "");

        var label = document.createElement("p");
        label.className = "metric-label";
        label.textContent = column.label;

        var text = document.createElement("p");
        text.className = "metric-value";
        text.textContent = formatCell(column, value) + (column.bar && value ? " л" : "");

        metric.appendChild(label);
        metric.appendChild(text);

        if (column.bar && value && scale > 0) {
          var track = document.createElement("div");
          track.className = "metric-bar";
          var fill = document.createElement("span");
          fill.style.width = Math.max(2, (value / scale) * 100) + "%";
          track.appendChild(fill);
          metric.appendChild(track);
        }

        grid.appendChild(metric);
      });

      li.appendChild(grid);
      el.cards.appendChild(li);
    });
  }

  function render() {
    var rows = visibleRows();
    var scale = maxLitres(state.rows);

    paintSortIndicators();
    renderTable(rows, scale);
    renderCards(rows, scale);

    el.empty.hidden = rows.length > 0;
  }

  function toggleSort(key) {
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = key;
      // Names read best A→Z; for the numeric columns the big values are
      // the interesting ones, so those start high→low.
      state.sortDir = columnByKey(key).type === "text" ? "asc" : "desc";
    }
    render();
  }

  /* ---------- summary ---------- */

  function renderStats() {
    var rows = state.rows.filter(function (row) { return row.petrol_litres; });
    if (!rows.length) return;

    var sorted = rows.slice().sort(function (a, b) { return b.petrol_litres - a.petrol_litres; });
    var best = sorted[0];
    var worst = sorted[sorted.length - 1];

    var tiles = [
      {
        label: "Държави в сравнението",
        value: fmtNumber(state.rows.length, 0),
        note: "с налични заплата и цени"
      },
      {
        label: "Най-много гориво",
        value: flagEmoji(best.code) + " " + best.country,
        note: fmtNumber(best.petrol_litres, 0) + " л бензин на минимална заплата"
      },
      {
        label: "Най-малко гориво",
        value: flagEmoji(worst.code) + " " + worst.country,
        note: fmtNumber(worst.petrol_litres, 0) + " л бензин на минимална заплата"
      }
    ];

    tiles.forEach(function (tile) {
      var box = document.createElement("div");
      box.className = "stat";

      var label = document.createElement("p");
      label.className = "stat-label";
      label.textContent = tile.label;

      var value = document.createElement("p");
      value.className = "stat-value";
      value.textContent = tile.value;

      var note = document.createElement("p");
      note.className = "stat-note";
      note.textContent = tile.note;

      box.appendChild(label);
      box.appendChild(value);
      box.appendChild(note);
      el.stats.appendChild(box);
    });

    el.stats.hidden = false;
  }

  function renderMeta(data) {
    if (data.generated_at) {
      var when = new Date(data.generated_at);
      var text = isNaN(when.getTime())
        ? data.generated_at
        : new Intl.DateTimeFormat("bg-BG", {
            day: "numeric", month: "long", year: "numeric",
            hour: "2-digit", minute: "2-digit"
          }).format(when);

      el.updated.innerHTML = "";
      el.updated.appendChild(document.createTextNode("Обновено на "));
      var strong = document.createElement("strong");
      strong.textContent = text;
      el.updated.appendChild(strong);

      if (data.fx && data.fx.usd_per_eur) {
        el.updated.appendChild(document.createTextNode(
          " · курс 1 € = " + fmtNumber(data.fx.usd_per_eur, 4) + " $"
          + (data.fx.date ? " (" + data.fx.date + ")" : "")
        ));
      }
      el.updated.hidden = false;
    }

    var sources = data.sources || {};
    var links = [
      { href: sources.minimum_wage, text: "Минимални заплати (Wikipedia)" },
      { href: sources.fuel_prices, text: "Цени на горива (Wikipedia)" },
      { href: sources.exchange_rates, text: "Frankfurter API" }
    ].filter(function (link) { return !!link.href; });

    if (!links.length) return;

    el.footerSources.appendChild(document.createTextNode("Източници: "));
    links.forEach(function (link, index) {
      if (index) el.footerSources.appendChild(document.createTextNode(" · "));
      var anchor = document.createElement("a");
      anchor.href = link.href;
      anchor.textContent = link.text;
      anchor.rel = "noopener noreferrer";
      anchor.target = "_blank";
      el.footerSources.appendChild(anchor);
    });
  }

  /* ---------- boot ---------- */

  function buildSortSelect() {
    COLUMNS.forEach(function (column) {
      var option = document.createElement("option");
      option.value = column.key;
      option.textContent = column.unit ? column.label + " (" + column.unit + ")" : column.label;
      el.sortSelect.appendChild(option);
    });

    el.sortSelect.addEventListener("change", function () {
      state.sortKey = el.sortSelect.value;
      state.sortDir = columnByKey(state.sortKey).type === "text" ? "asc" : "desc";
      render();
    });

    el.sortDir.addEventListener("click", function () {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      render();
    });
  }

  function showError(message) {
    el.status.className = "status error";
    el.status.textContent = message;
    el.status.hidden = false;
  }

  function start(data) {
    if (!data || !Array.isArray(data.countries) || !data.countries.length) {
      showError("Файлът с данни е празен. Изчакайте първото автоматично обновяване.");
      return;
    }

    state.rows = data.countries;
    el.status.hidden = true;
    el.table.hidden = false;

    buildHead();
    buildSortSelect();
    renderMeta(data);
    renderStats();
    render();

    el.search.addEventListener("input", function () {
      state.query = el.search.value;
      render();
    });
  }

  fetch(DATA_URL, { cache: "no-cache" })
    .then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    })
    .then(start)
    .catch(function (error) {
      showError("Данните не можаха да бъдат заредени (" + error.message + "). "
        + "Ако отваряте файла директно от диска, стартирайте локален сървър: python3 -m http.server");
    });
})();
