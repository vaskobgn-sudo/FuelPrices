#!/usr/bin/env python3
"""Offline regression tests for the scraper.

These use HTML fixtures shaped like the Wikipedia tables, so they run without
network access and catch parsing regressions before the daily job scrapes for
real. Run with: python scripts/test_parser.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bs4 import BeautifulSoup  # noqa: E402

import fetch_data as fd  # noqa: E402

# Mirrors the live layout of the minimum wage article: a single header row,
# no occurrence of the word "wage" anywhere in it.
WAGE_HTML = """
<table class="wikitable sortable">
<tr>
  <th>Country</th><th>Notes</th>
  <th>Annual Nominal (US$)</th><th>Annual PPP (Int$)</th>
  <th>Work week (hours)</th>
  <th>Hourly Nominal (US$)</th><th>Hourly PPP (Int$)</th>
  <th>% of GDP per capita</th><th>Effective date</th>
</tr>
<tr>
  <td><span class="flagicon"><img alt="Bulgaria"/></span>
      <a href="/wiki/Bulgaria">Bulgaria</a><sup class="reference">[12]</sup></td>
  <td>Gross</td><td>6,624</td><td>13,500</td><td>40</td><td>3.19</td><td>6.49</td>
  <td>45%</td><td>1 January 2025</td>
</tr>
<tr>
  <td><a href="/wiki/Germany">Germany</a></td>
  <td></td><td>25,850</td><td>27,600</td><td>38</td><td>13.60</td><td>14.20</td>
  <td>50%</td><td>1 January 2025</td>
</tr>
<tr>
  <td><a href="/wiki/United_States">United States</a></td>
  <td>Federal</td><td>15,080</td><td>15,080</td><td>40</td><td>7.25</td><td>7.25</td>
  <td>18%</td><td>24 July 2009</td>
</tr>
<tr>
  <td><a href="/wiki/Somalia">Somalia</a></td>
  <td>No minimum wage</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
  <td>—</td><td>—</td>
</tr>
</table>
"""

# A merged-cell variant, to keep the colspan/rowspan grid expansion covered.
WAGE_HTML_MERGED = """
<table class="wikitable sortable">
<tr>
  <th rowspan="2">Country</th>
  <th colspan="2">Annual minimum wage</th>
  <th colspan="2">Hourly minimum wage</th>
  <th rowspan="2">Percentage of GDP per capita</th>
  <th rowspan="2">Workweek hours</th>
  <th rowspan="2">Effective per</th>
</tr>
<tr>
  <th>Nominal<br/>(US$)</th><th>PPP<br/>(Int$)</th>
  <th>Nominal<br/>(US$)</th><th>PPP<br/>(Int$)</th>
</tr>
<tr>
  <td><span class="flagicon"><img alt="Bulgaria"/></span>
      <a href="/wiki/Bulgaria">Bulgaria</a><sup class="reference">[12]</sup></td>
  <td>6,624</td><td>13,500</td><td>3.19</td><td>6.49</td><td>45%</td><td>40</td>
  <td>1 January 2025</td>
</tr>
<tr>
  <td><a href="/wiki/Germany">Germany</a></td>
  <td>25,850</td><td>27,600</td><td>13.60</td><td>14.20</td><td>50%</td><td>38</td>
  <td>1 January 2025</td>
</tr>
<tr>
  <td><a href="/wiki/United_States">United States</a></td>
  <td>15,080</td><td>15,080</td><td>7.25</td><td>7.25</td><td>18%</td><td>40</td>
  <td>24 July 2009</td>
</tr>
<tr>
  <td><a href="/wiki/Somalia">Somalia</a></td>
  <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>No minimum wage</td>
</tr>
</table>
"""

# Mirrors a GlobalPetrolPrices chart page: country links and price labels are
# two parallel lists, not a table.
def gpp_page(fuel: str, prices: dict[str, str]) -> str:
    links = "".join(
        f'<a href="/{c.replace(" ", "-")}/{fuel}_prices/">{c}</a>'
        for c in prices)
    numbers = "".join(f'<span class="pricenumbers">{v}</span>'
                      for v in prices.values())
    return f"""
    <html><body>
      <h1>{fuel.title()} prices, litre, 28-Jul-2026</h1>
      <p>The average price of {fuel} is shown in U.S. Dollar per litre.</p>
      <div id="graphic">
        <div id="outsideLinks">{links}</div>
        <div class="graph">{numbers}</div>
      </div>
    </body></html>
    """


PETROL_HTML = gpp_page("gasoline", {
    "Bulgaria": "1.379", "Germany": "1.850", "United States": "0.900",
    "Hong Kong": "3.100",
})
DIESEL_HTML = gpp_page("diesel", {
    "Bulgaria": "1.415", "Germany": "1.760", "United States": "1.000",
    "Hong Kong": "2.400",
})

RATES = {"EUR": 1.0, "USD": 1.10, "GBP": 0.85}

failures: list[str] = []


def check(label: str, got, want) -> None:
    ok = got == want
    print(f"{'  PASS' if ok else '  FAIL'} {label}: got={got!r}" + ("" if ok else f" want={want!r}"))
    if not ok:
        failures.append(label)


def table(html: str):
    return BeautifulSoup(html, "html.parser").find("table")


def test_wage_table() -> None:
    print("== minimum wage table (live layout) ==")
    headers, rows = fd.split_header(fd.table_to_grid(table(WAGE_HTML)))

    check("headers contain no literal 'wage'", "wage" in " ".join(headers).lower(), False)
    check("country column", fd.find_country_column(headers), 0)
    check("workweek column", fd.find_workweek_column(headers), 4)
    check("effective date column", fd.find_date_column(headers), 8)
    check("data row count", len(rows), 4)

    picked = fd.pick_wage_column(headers)
    check("nominal annual column preferred over PPP and hourly", picked, (2, "annual", "USD"))
    check("GDP percentage column ignored", picked[0] != 7, True)
    check("country cell cleaned of flag and footnote",
          fd.canonical_country(rows[0][0]), ("Bulgaria", "bulgaria"))
    check("thousands separator parsed", fd.parse_number(rows[0][2]), 6624.0)
    check("dash means no value", fd.parse_number(rows[3][2]), None)


def test_wage_table_merged_header() -> None:
    print("== minimum wage table (merged header) ==")
    headers, rows = fd.split_header(fd.table_to_grid(table(WAGE_HTML_MERGED)))

    check("merged headers flattened", headers[1], "Annual minimum wage Nominal (US$)")
    check("country column", fd.find_country_column(headers), 0)
    check("workweek column", fd.find_workweek_column(headers), 6)
    check("effective date column", fd.find_date_column(headers), 7)
    check("data row count", len(rows), 4)
    check("nominal annual column preferred over PPP",
          fd.pick_wage_column(headers), (1, "annual", "USD"))


def test_fuel_page() -> None:
    print("== fuel price page ==")
    soup = BeautifulSoup(PETROL_HTML, "html.parser")

    check("currency and unit read off the page", fd.gpp_unit(soup), ("USD", 1.0))
    check("price date read off the page", fd.gpp_price_date(soup), "28-Jul-2026")

    pairs = fd.gpp_pairs(soup, PETROL_HTML, "gasoline")
    check("countries paired with prices", pairs[:2],
          [("Bulgaria", 1.379), ("Germany", 1.85)])
    check("all rows paired", len(pairs), 4)

    # Same page with the ids renamed, to exercise the markup-level fallback.
    stripped = PETROL_HTML.replace('id="outsideLinks"', 'id="renamed"')
    check("falls back to raw markup when ids change",
          len(fd.gpp_pairs(BeautifulSoup(stripped, "html.parser"), stripped, "gasoline")), 4)

    # The live pages put no class on the price labels at all.
    unclassed = PETROL_HTML.replace('class="pricenumbers"', 'class="barlabel"')
    check("prices found without a class hook",
          fd.gpp_pairs(BeautifulSoup(unclassed, "html.parser"), unclassed, "gasoline")[:2],
          [("Bulgaria", 1.379), ("Germany", 1.85)])

    gallons = PETROL_HTML.replace("litre", "gallon")
    check("gallon pages are converted",
          fd.gpp_unit(BeautifulSoup(gallons, "html.parser")),
          ("USD", fd.LITRES_PER_US_GALLON))


def test_conversions() -> None:
    print("== conversions ==")
    check("USD to EUR", round(fd.to_eur(110.0, "USD", RATES), 2), 100.0)
    check("unknown currency drops the value", fd.to_eur(10.0, "XYZ", RATES), None)
    check("annual to monthly", round(fd.monthly_from(1200, "annual", None), 2), 100.0)
    check("hourly to monthly", round(fd.monthly_from(10, "hourly", 40), 2),
          round(10 * 40 * 52 / 12, 2))
    check("weekly to monthly", round(fd.monthly_from(100, "weekly", None), 2),
          round(100 * 52 / 12, 2))


def test_country_names() -> None:
    print("== country names ==")
    for raw, want in [
        ("Czech Republic", "Czechia"),
        ("Türkiye", "Turkey"),
        ("United States of America", "United States"),
        ("Ivory Coast", "Côte d'Ivoire"),
        ("Korea, South", "South Korea"),
        ("China (mainland)", "China"),
    ]:
        got = fd.canonical_country(raw)
        check(f"alias {raw!r}", got[0] if got else None, want)

    check("header text rejected", fd.canonical_country("Country"), None)
    check("aggregate rows rejected", fd.canonical_country("World"), None)
    check("ISO code for Bulgaria", fd.flag_code("bulgaria"), "BG")
    check("ISO code survives aliasing",
          fd.flag_code(fd.canonical_country("Czech Republic")[1]), "CZ")


def test_numbers() -> None:
    print("== number parsing ==")
    for raw, want in [("6,624", 6624.0), ("$1,234.56", 1234.56), ("1 234", 1234.0),
                      ("—", None), ("N/A", None), ("3.19", 3.19)]:
        check(f"parse {raw!r}", fd.parse_number(raw), want)


class FakeResponse:
    def __init__(self, text: str) -> None:
        self.text = text

    def json(self):
        return json.loads(self.text)


def build_with(pages: dict[str, str]) -> dict:
    """Run build_dataset against canned pages instead of the network."""
    original_get, original_rates = fd.http_get, fd.fetch_eur_rates

    def fake_get(url: str, **_kwargs):
        if url not in pages:
            raise RuntimeError(f"404 for {url}")
        return FakeResponse(pages[url])

    fd.http_get = fake_get
    fd.fetch_eur_rates = lambda: {"date": "2026-08-01", "base": "EUR", "rates": RATES}
    try:
        return fd.build_dataset()
    finally:
        fd.http_get, fd.fetch_eur_rates = original_get, original_rates


def test_end_to_end() -> None:
    print("== end to end ==")
    dataset = build_with({
        fd.WAGE_URL: WAGE_HTML,
        fd.FUEL_URLS["petrol"]: PETROL_HTML,
        fd.FUEL_URLS["diesel"]: DIESEL_HTML,
    })

    check("source recorded", dataset["sources"]["fuel_prices"], fd.FUEL_URLS["petrol"])

    by_name = {c["country"]: c for c in dataset["countries"]}

    check("only countries present in both tables",
          sorted(by_name), ["Bulgaria", "Germany", "United States"])
    check("sorted alphabetically", [c["country"] for c in dataset["countries"]],
          sorted(by_name))
    # 6624 USD/year -> 552 USD/month -> /1.10 = 501.82 EUR
    check("wage converted to monthly EUR", by_name["Bulgaria"]["min_wage_eur_month"], 501.82)
    check("petrol converted to EUR/L", by_name["Bulgaria"]["petrol_eur_l"], 1.254)
    check("diesel converted to EUR/L", by_name["Bulgaria"]["diesel_eur_l"], 1.286)
    check("litres of petrol per wage", by_name["Bulgaria"]["petrol_litres"],
          round(501.82 / 1.254, 1))
    check("ISO code attached", by_name["Bulgaria"]["code"], "BG")
    check("wage basis recorded", by_name["Bulgaria"]["wage_basis"], "annual")
    check("country without a wage is excluded", "Somalia" in by_name, False)
    check("country without a wage row is excluded", "Hong Kong" in by_name, False)
    check("base currency", dataset["base_currency"], "EUR")
    check("country count in stats", dataset["stats"]["countries"], 3)


def main() -> int:
    test_wage_table()
    test_wage_table_merged_header()
    test_fuel_page()
    test_conversions()
    test_country_names()
    test_numbers()
    test_end_to_end()

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: {failures}")
        return 1
    print("All offline checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
