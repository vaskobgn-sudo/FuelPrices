#!/usr/bin/env python3
"""Collect minimum wages and fuel prices, convert both to EUR.

Minimum wages come from Wikipedia and pump prices from GlobalPetrolPrices,
which is the source Wikipedia itself cites now that its own per-country price
table has been removed. Everything is converted to euro through the
Frankfurter API and written as one JSON document for the static front-end.

Both sites reshuffle their markup regularly, so the parsers match on header
text and page structure rather than fixed positions, and every choice the
script makes is logged to make failures diagnosable from CI logs.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import re
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup, Tag

WAGE_URL = "https://en.wikipedia.org/wiki/List_of_countries_by_minimum_wage"
FUEL_URLS = {
    "petrol": "https://www.globalpetrolprices.com/gasoline_prices/",
    "diesel": "https://www.globalpetrolprices.com/diesel_prices/",
}

# Display names picked up while reading the fuel pages, keyed the same way as
# everything else so the two sources can be joined.
FUEL_NAMES: dict[str, str] = {}

FRANKFURTER_URLS = (
    "https://api.frankfurter.dev/v1/latest?base=EUR",
    "https://api.frankfurter.app/latest?base=EUR",
)

USER_AGENT = (
    "FuelPricesBot/1.0 (https://github.com/vaskobgn-sudo/FuelPrices; "
    "open-source fuel affordability dataset) python-requests"
)

LITRES_PER_US_GALLON = 3.785411784
WEEKS_PER_MONTH = 52 / 12
DEFAULT_WORKWEEK_HOURS = 40.0

# Plausibility guards: anything outside these ranges is treated as a parsing
# accident rather than a real figure, and is dropped with a warning.
# The floor sits below the world's lowest real minimum wages (Venezuela's is
# under 1 EUR/month) so that only obvious misreads are discarded.
MIN_MONTHLY_WAGE_EUR = 0.5
MAX_MONTHLY_WAGE_EUR = 20_000.0
MIN_FUEL_EUR_PER_L = 0.02
MAX_FUEL_EUR_PER_L = 10.0

log = logging.getLogger("fuelprices")


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
def http_get(url: str, *, retries: int = 4, timeout: int = 45) -> requests.Response:
    """GET with exponential backoff; raises on the final failure."""
    delay = 2.0
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            response = requests.get(
                url,
                timeout=timeout,
                headers={"User-Agent": USER_AGENT, "Accept-Language": "en"},
            )
            response.raise_for_status()
            return response
        except requests.HTTPError as exc:
            # A missing or forbidden page will not appear on a retry.
            status = exc.response.status_code if exc.response is not None else 0
            if 400 <= status < 500 and status not in (408, 429):
                raise RuntimeError(f"could not fetch {url}: {exc}") from exc
            last = exc
            log.warning("GET %s failed (attempt %d/%d): %s", url, attempt, retries, exc)
            if attempt < retries:
                time.sleep(delay)
                delay *= 2
        except Exception as exc:  # noqa: BLE001 - retried and re-raised below
            last = exc
            log.warning("GET %s failed (attempt %d/%d): %s", url, attempt, retries, exc)
            if attempt < retries:
                time.sleep(delay)
                delay *= 2
    raise RuntimeError(f"could not fetch {url}: {last}")


def fetch_eur_rates() -> dict:
    """Return Frankfurter rates with EUR as the base currency."""
    last: Exception | None = None
    for url in FRANKFURTER_URLS:
        try:
            payload = http_get(url).json()
            rates = {str(k).upper(): float(v) for k, v in payload["rates"].items()}
            rates["EUR"] = 1.0
            log.info("FX rates for %s loaded from %s (%d currencies)",
                     payload.get("date"), url, len(rates))
            return {"date": payload.get("date"), "base": "EUR", "rates": rates}
        except Exception as exc:  # noqa: BLE001 - try the next mirror
            last = exc
            log.warning("Frankfurter endpoint %s failed: %s", url, exc)
    raise RuntimeError(f"could not load exchange rates: {last}")


def to_eur(amount: float, currency: str, rates: dict[str, float]) -> float | None:
    """Convert `amount` of `currency` into EUR using EUR-based rates."""
    rate = rates.get(currency.upper())
    if not rate:
        log.warning("No FX rate for %s; value dropped", currency)
        return None
    return amount / rate


# --------------------------------------------------------------------------
# HTML table parsing
# --------------------------------------------------------------------------
NUMBER_RE = re.compile(r"-?\d[\d,   ]*(?:\.\d+)?")


def clean_cell(cell: Tag) -> str:
    """Text of a table cell without footnotes, sort keys and hidden markup."""
    clone = BeautifulSoup(str(cell), "html.parser")
    for junk in clone.select("sup.reference, style, script, .sortkey, .mw-editsection"):
        junk.decompose()
    for hidden in clone.find_all(style=True):
        if "display:none" in hidden["style"].replace(" ", "").lower():
            hidden.decompose()
    text = clone.get_text(" ", strip=True)
    text = re.sub(r"\[[^\]]*\]", " ", text)  # leftover [1], [note 2]
    return re.sub(r"\s+", " ", text).strip()


def table_to_grid(table: Tag) -> list[list[tuple[str, bool]]]:
    """Flatten a table into a rectangular grid, expanding colspan/rowspan.

    Each cell is a ``(text, is_header)`` pair. Working on an expanded grid
    means merged header cells line up with the data columns underneath them.
    """
    grid: list[dict[int, tuple[str, bool]]] = []
    for row_index, tr in enumerate(table.find_all("tr")):
        while len(grid) <= row_index:
            grid.append({})
        column = 0
        for cell in tr.find_all(["th", "td"], recursive=False):
            while column in grid[row_index]:
                column += 1
            try:
                colspan = max(1, min(int(cell.get("colspan", 1)), 25))
            except (TypeError, ValueError):
                colspan = 1
            try:
                rowspan = max(1, min(int(cell.get("rowspan", 1)), 400))
            except (TypeError, ValueError):
                rowspan = 1
            value = (clean_cell(cell), cell.name == "th")
            for dr in range(rowspan):
                target = row_index + dr
                while len(grid) <= target:
                    grid.append({})
                for dc in range(colspan):
                    grid[target].setdefault(column + dc, value)
            column += colspan

    width = max((max(row) + 1 for row in grid if row), default=0)
    return [[row.get(i, ("", False)) for i in range(width)] for row in grid]


def split_header(grid: list[list[tuple[str, bool]]]) -> tuple[list[str], list[list[str]]]:
    """Split a grid into combined header labels and data rows."""
    header_rows = 0
    for row in grid[:3]:  # Wikipedia headers are at most a few rows deep
        if row and all(is_header for _, is_header in row):
            header_rows += 1
        else:
            break
    if header_rows == 0:
        header_rows = 1

    width = len(grid[0]) if grid else 0
    headers = []
    for column in range(width):
        parts: list[str] = []
        for row in grid[:header_rows]:
            text = row[column][0]
            if text and text not in parts:
                parts.append(text)
        headers.append(" ".join(parts).strip())

    rows = [
        [text for text, _ in row]
        for row in grid[header_rows:]
        if any(text.strip() for text, _ in row)
    ]
    return headers, rows


def parse_number(text: str) -> float | None:
    """First number in a cell, tolerant of currency symbols and separators."""
    if not text:
        return None
    lowered = text.strip().lower()
    if lowered in {"", "-", "—", "–", "n/a", "na", "none", "no", "no minimum wage"}:
        return None
    match = NUMBER_RE.search(text.replace("−", "-"))
    if not match:
        return None
    raw = re.sub(r"[,   ]", "", match.group(0))
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


# --------------------------------------------------------------------------
# Country names
# --------------------------------------------------------------------------
COUNTRY_ALIASES = {
    "usa": "United States",
    "unitedstatesofamerica": "United States",
    "unitedstates": "United States",
    "uk": "United Kingdom",
    "greatbritain": "United Kingdom",
    "unitedkingdomofgreatbritainandnorthernireland": "United Kingdom",
    "russianfederation": "Russia",
    "southkorea": "South Korea",
    "koreasouth": "South Korea",
    "republicofkorea": "South Korea",
    "northkorea": "North Korea",
    "koreanorth": "North Korea",
    "czechrepublic": "Czechia",
    "turkiye": "Turkey",
    "ivorycoast": "Côte d'Ivoire",
    "cotedivoire": "Côte d'Ivoire",
    "burma": "Myanmar",
    "capeverde": "Cabo Verde",
    "easttimor": "Timor-Leste",
    "swaziland": "Eswatini",
    "macedonia": "North Macedonia",
    "republicofnorthmacedonia": "North Macedonia",
    "thenetherlands": "Netherlands",
    "holland": "Netherlands",
    "unitedarabemirates": "United Arab Emirates",
    "uae": "United Arab Emirates",
    "drcongo": "Democratic Republic of the Congo",
    "democraticrepublicofcongo": "Democratic Republic of the Congo",
    "congokinshasa": "Democratic Republic of the Congo",
    "congodemocraticrepublicofthe": "Democratic Republic of the Congo",
    "congobrazzaville": "Republic of the Congo",
    "congo": "Republic of the Congo",
    "republicofthecongo": "Republic of the Congo",
    "vaticancity": "Vatican City",
    "holysee": "Vatican City",
    "hongkongsar": "Hong Kong",
    "hongkongchina": "Hong Kong",
    "macao": "Macau",
    "macausar": "Macau",
    "bosnia": "Bosnia and Herzegovina",
    "bosniaherzegovina": "Bosnia and Herzegovina",
    "trinidadtobago": "Trinidad and Tobago",
    "antiguabarbuda": "Antigua and Barbuda",
    "saintkittsnevis": "Saint Kitts and Nevis",
    "stkittsandnevis": "Saint Kitts and Nevis",
    "stlucia": "Saint Lucia",
    "stvincentandthegrenadines": "Saint Vincent and the Grenadines",
    "saovicenteandthegrenadines": "Saint Vincent and the Grenadines",
    "saotomeandprincipe": "São Tomé and Príncipe",
    "saotomeprincipe": "São Tomé and Príncipe",
    "gambiathe": "Gambia",
    "thegambia": "Gambia",
    "bahamasthe": "Bahamas",
    "thebahamas": "Bahamas",
    "brunei": "Brunei",
    "bruneidarussalam": "Brunei",
    "laos": "Laos",
    "laopeoplesdemocraticrepublic": "Laos",
    "syrianarabrepublic": "Syria",
    "vietnam": "Vietnam",
    "vietnamsocialistrepublicof": "Vietnam",
    "iranislamicrepublicof": "Iran",
    "venezuelabolivarianrepublicof": "Venezuela",
    "boliviaplurinationalstateof": "Bolivia",
    "tanzaniaunitedrepublicof": "Tanzania",
    "moldovarepublicof": "Moldova",
    "palestinianterritories": "Palestine",
    "statepalestine": "Palestine",
    "mainlandchina": "China",
    "peoplesrepublicofchina": "China",
    "chinapeoplesrepublicof": "China",
    "republicofchina": "Taiwan",
    "taiwanchina": "Taiwan",
    "myanmarburma": "Myanmar",
    "unitedstatesvirginislands": "U.S. Virgin Islands",
    "cotedlvoire": "Côte d'Ivoire",
}

ISO2 = {
    "afghanistan": "AF", "albania": "AL", "algeria": "DZ", "andorra": "AD",
    "angola": "AO", "antiguaandbarbuda": "AG", "argentina": "AR", "armenia": "AM",
    "aruba": "AW", "australia": "AU", "austria": "AT", "azerbaijan": "AZ",
    "bahamas": "BS", "bahrain": "BH", "bangladesh": "BD", "barbados": "BB",
    "belarus": "BY", "belgium": "BE", "belize": "BZ", "benin": "BJ",
    "bermuda": "BM", "bhutan": "BT", "bolivia": "BO", "bosniaandherzegovina": "BA",
    "botswana": "BW", "brazil": "BR", "brunei": "BN", "bulgaria": "BG",
    "burkinafaso": "BF", "burundi": "BI", "caboverde": "CV", "cambodia": "KH",
    "cameroon": "CM", "canada": "CA", "caymanislands": "KY",
    "centralafricanrepublic": "CF", "chad": "TD", "chile": "CL", "china": "CN",
    "colombia": "CO", "comoros": "KM", "costarica": "CR", "croatia": "HR",
    "cuba": "CU", "curacao": "CW", "cyprus": "CY", "czechia": "CZ",
    "democraticrepublicofthecongo": "CD", "denmark": "DK", "djibouti": "DJ",
    "dominica": "DM", "dominicanrepublic": "DO", "ecuador": "EC", "egypt": "EG",
    "elsalvador": "SV", "equatorialguinea": "GQ", "eritrea": "ER",
    "estonia": "EE", "eswatini": "SZ", "ethiopia": "ET", "fiji": "FJ",
    "finland": "FI", "france": "FR", "gabon": "GA", "gambia": "GM",
    "georgia": "GE", "germany": "DE", "ghana": "GH", "gibraltar": "GI",
    "greece": "GR", "greenland": "GL", "grenada": "GD", "guatemala": "GT",
    "guernsey": "GG", "guinea": "GN", "guineabissau": "GW", "guyana": "GY",
    "haiti": "HT", "honduras": "HN", "hongkong": "HK", "hungary": "HU",
    "iceland": "IS", "india": "IN", "indonesia": "ID", "iran": "IR",
    "iraq": "IQ", "ireland": "IE", "isleofman": "IM", "israel": "IL",
    "italy": "IT", "cotedivoire": "CI", "jamaica": "JM", "japan": "JP",
    "jersey": "JE", "jordan": "JO", "kazakhstan": "KZ", "kenya": "KE",
    "kiribati": "KI", "kosovo": "XK", "kuwait": "KW", "kyrgyzstan": "KG",
    "laos": "LA", "latvia": "LV", "lebanon": "LB", "lesotho": "LS",
    "liberia": "LR", "libya": "LY", "liechtenstein": "LI", "lithuania": "LT",
    "luxembourg": "LU", "macau": "MO", "madagascar": "MG", "malawi": "MW",
    "malaysia": "MY", "maldives": "MV", "mali": "ML", "malta": "MT",
    "marshallislands": "MH", "mauritania": "MR", "mauritius": "MU",
    "mexico": "MX", "micronesia": "FM", "moldova": "MD", "monaco": "MC",
    "mongolia": "MN", "montenegro": "ME", "morocco": "MA", "mozambique": "MZ",
    "myanmar": "MM", "namibia": "NA", "nauru": "NR", "nepal": "NP",
    "netherlands": "NL", "newzealand": "NZ", "nicaragua": "NI", "niger": "NE",
    "nigeria": "NG", "northkorea": "KP", "northmacedonia": "MK", "norway": "NO",
    "oman": "OM", "pakistan": "PK", "palau": "PW", "palestine": "PS",
    "panama": "PA", "papuanewguinea": "PG", "paraguay": "PY", "peru": "PE",
    "philippines": "PH", "poland": "PL", "portugal": "PT", "puertorico": "PR",
    "qatar": "QA", "republicofthecongo": "CG", "romania": "RO", "russia": "RU",
    "rwanda": "RW", "saintkittsandnevis": "KN", "saintlucia": "LC",
    "saintvincentandthegrenadines": "VC", "samoa": "WS", "sanmarino": "SM",
    "saotomeandprincipe": "ST", "saudiarabia": "SA", "senegal": "SN",
    "serbia": "RS", "seychelles": "SC", "sierraleone": "SL", "singapore": "SG",
    "slovakia": "SK", "slovenia": "SI", "solomonislands": "SB", "somalia": "SO",
    "southafrica": "ZA", "southkorea": "KR", "southsudan": "SS", "spain": "ES",
    "srilanka": "LK", "sudan": "SD", "suriname": "SR", "sweden": "SE",
    "switzerland": "CH", "syria": "SY", "taiwan": "TW", "tajikistan": "TJ",
    "tanzania": "TZ", "thailand": "TH", "timorleste": "TL", "togo": "TG",
    "tonga": "TO", "trinidadandtobago": "TT", "tunisia": "TN", "turkey": "TR",
    "turkmenistan": "TM", "uganda": "UG", "ukraine": "UA",
    "unitedarabemirates": "AE", "unitedkingdom": "GB", "unitedstates": "US",
    "uruguay": "UY", "usvirginislands": "VI", "uzbekistan": "UZ",
    "vanuatu": "VU", "vaticancity": "VA", "venezuela": "VE", "vietnam": "VN",
    "yemen": "YE", "zambia": "ZM", "zimbabwe": "ZW",
}

STRIP_SUFFIXES = re.compile(
    r"\s*\((?:mainland|continental|excluding[^)]*|including[^)]*|[^)]*only)\)\s*$",
    re.IGNORECASE,
)


def normalize_key(name: str) -> str:
    """Diacritic- and punctuation-free lookup key for a country name."""
    decomposed = unicodedata.normalize("NFKD", name)
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    return re.sub(r"[^a-z]", "", ascii_only.lower())


def canonical_country(raw: str) -> tuple[str, str] | None:
    """Return ``(display name, join key)`` for a country cell, or None."""
    name = re.sub(r"\s+", " ", raw).strip(" *†‡.,")
    name = STRIP_SUFFIXES.sub("", name).strip()
    if not name or len(name) < 3 or not re.search(r"[A-Za-z]", name):
        return None
    if normalize_key(name) in {"country", "countryorterritory", "total", "world",
                               "average", "euaverage", "europeanunion"}:
        return None

    key = normalize_key(name)
    if key in COUNTRY_ALIASES:
        name = COUNTRY_ALIASES[key]
        key = normalize_key(name)
    return name, key


def flag_code(key: str) -> str | None:
    return ISO2.get(key)


# --------------------------------------------------------------------------
# Column selection
# --------------------------------------------------------------------------
def detect_currency(header: str) -> str:
    """Currency code implied by a column header (defaults to USD)."""
    lowered = header.lower()
    if "€" in header or re.search(r"\beur\b|euro", lowered):
        return "EUR"
    if "£" in header or re.search(r"\bgbp\b", lowered):
        return "GBP"
    if re.search(r"us\$|\busd\b|u\.s\. dollar|us dollar", lowered):
        return "USD"
    if "$" in header:
        return "USD"
    return "USD"


def find_country_column(headers: list[str]) -> int:
    for index, header in enumerate(headers):
        lowered = header.lower()
        if any(word in lowered for word in ("country", "territory", "nation", "state")):
            return index
    return 0


def pick_wage_column(headers: list[str]) -> tuple[int, str, str] | None:
    """Choose the best minimum-wage column.

    Returns ``(index, period, currency)`` where period is one of
    annual/monthly/weekly/daily/hourly. Nominal columns are strongly
    preferred over purchasing-power-parity ones.
    """
    # (header fragment, period, base score) - checked in order, first hit wins.
    periods = (
        ("monthly", "monthly", 100), ("per month", "monthly", 100),
        ("a month", "monthly", 100), ("annual", "annual", 90),
        ("yearly", "annual", 90), ("per year", "annual", 90),
        ("a year", "annual", 90), ("weekly", "weekly", 60),
        ("per week", "weekly", 60), ("daily", "daily", 50),
        ("per day", "daily", 50), ("hourly", "hourly", 40),
        ("per hour", "hourly", 40), ("an hour", "hourly", 40),
    )
    best: tuple[float, int, str, str] | None = None
    for index, header in enumerate(headers):
        lowered = header.lower()
        if not lowered:
            continue
        period = None
        score = 0.0
        for fragment, name, weight in periods:
            if fragment in lowered:
                period, score = name, float(weight)
                break
        if period is None:
            continue

        if "ppp" in lowered or "purchasing power" in lowered:
            score -= 70
        if "nominal" in lowered:
            score += 15
        if re.search(r"us\$|\busd\b|\$", lowered):
            score += 10
        if "%" in header or "percent" in lowered or "gdp" in lowered:
            continue
        if best is None or score > best[0]:
            best = (score, index, period, detect_currency(header))

    if best is None:
        return None
    _, index, period, currency = best
    return index, period, currency


def find_workweek_column(headers: list[str]) -> int | None:
    for index, header in enumerate(headers):
        lowered = header.lower()
        if "work" in lowered and ("week" in lowered or "hours" in lowered):
            return index
        if "hours per week" in lowered:
            return index
    return None


def find_date_column(headers: list[str]) -> int | None:
    for index, header in enumerate(headers):
        lowered = header.lower()
        if "effective" in lowered or lowered.strip() in {"date", "as of", "year"}:
            return index
    return None


def wikitables(html: str) -> list[Tag]:
    """Every `wikitable` on the page, falling back to all sizeable tables."""
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")
    tagged = [t for t in tables if "wikitable" in " ".join(t.get("class", []))]
    if tagged:
        return tagged
    log.warning("No table carried the 'wikitable' class; falling back to all tables")
    return [t for t in tables if len(t.find_all("tr")) > 3]


def describe_tables(url: str, tables: list[Tag]) -> None:
    """Dump every table's headers so a failed run is fixable from CI logs."""
    log.error("Could not find a usable table on %s. Tables seen:", url)
    for index, table in enumerate(tables):
        try:
            headers, rows = split_header(table_to_grid(table))
        except Exception as exc:  # noqa: BLE001 - diagnostics must not raise
            log.error("  [%d] unreadable: %s", index, exc)
            continue
        log.error("  [%d] %d rows | headers: %s", index, len(rows),
                  " | ".join(h or "?" for h in headers[:12]))


def log_sample_rows(rows: list[list[str]], count: int = 3) -> None:
    for row in rows[:count]:
        log.info("  sample row: %s", " | ".join(cell or "-" for cell in row[:8]))


# --------------------------------------------------------------------------
# Scrapers
# --------------------------------------------------------------------------
def monthly_from(value: float, period: str, workweek_hours: float | None) -> float | None:
    hours = workweek_hours or DEFAULT_WORKWEEK_HOURS
    if period == "monthly":
        return value
    if period == "annual":
        return value / 12
    if period == "weekly":
        return value * WEEKS_PER_MONTH
    if period == "daily":
        return value * WEEKS_PER_MONTH * 5
    if period == "hourly":
        return value * hours * WEEKS_PER_MONTH
    return None


def scrape_minimum_wages(rates: dict[str, float]) -> dict[str, dict]:
    """Country key -> minimum wage record (monthly, EUR)."""
    html = http_get(WAGE_URL).text
    tables = wikitables(html)
    candidates = []
    for table in tables:
        headers, rows = split_header(table_to_grid(table))
        joined = " | ".join(headers).lower()
        # The live table heads its money columns "Annual Nominal (US$)" without
        # ever saying "wage", so identify it by shape: a country column plus a
        # column carrying a pay period.
        if "country" not in joined:
            continue
        column = pick_wage_column(headers)
        if column is None:
            continue
        candidates.append((len(rows), headers, rows, column))

    if not candidates:
        describe_tables(WAGE_URL, tables)
        raise RuntimeError("no usable minimum wage table found on the Wikipedia page")

    _, headers, rows, (wage_index, period, currency) = max(candidates, key=lambda c: c[0])
    country_index = find_country_column(headers)
    workweek_index = find_workweek_column(headers)
    date_index = find_date_column(headers)

    log.info("Minimum wage table: %d rows", len(rows))
    log.info("  country column  [%d] %r", country_index, headers[country_index])
    log.info("  wage column     [%d] %r -> %s, %s", wage_index, headers[wage_index],
             period, currency)
    log.info("  workweek column %s", f"[{workweek_index}] {headers[workweek_index]!r}"
             if workweek_index is not None else "none")
    log_sample_rows(rows)

    result: dict[str, dict] = {}
    skipped = 0
    for row in rows:
        if max(country_index, wage_index) >= len(row):
            continue
        country = canonical_country(row[country_index])
        if country is None:
            continue
        name, key = country

        raw_value = parse_number(row[wage_index])
        if raw_value is None or raw_value <= 0:
            skipped += 1
            continue

        workweek = None
        if workweek_index is not None and workweek_index < len(row):
            workweek = parse_number(row[workweek_index])
            if workweek is not None and not 10 <= workweek <= 80:
                workweek = None

        monthly_local = monthly_from(raw_value, period, workweek)
        if monthly_local is None:
            continue
        monthly_eur = to_eur(monthly_local, currency, rates)
        if monthly_eur is None:
            continue
        if not MIN_MONTHLY_WAGE_EUR <= monthly_eur <= MAX_MONTHLY_WAGE_EUR:
            log.warning("Implausible wage for %s: %.2f EUR/month (raw %r) - dropped",
                        name, monthly_eur, row[wage_index])
            skipped += 1
            continue

        effective = row[date_index].strip() if date_index is not None and date_index < len(row) else ""
        record = {
            "country": name,
            "min_wage_eur_month": round(monthly_eur, 2),
            "wage_basis": period,
            "wage_source_currency": currency,
            "wage_effective": effective or None,
        }
        # Keep the first (usually most general) entry per country.
        result.setdefault(key, record)

    log.info("Parsed %d minimum wages (%d rows skipped)", len(result), skipped)
    return result


def gpp_price_date(soup: BeautifulSoup) -> str | None:
    """The 'dd-Mmm-yyyy' stamp GlobalPetrolPrices prints above its charts."""
    match = re.search(r"\b(\d{1,2}-[A-Za-z]{3}-\d{4})\b", soup.get_text(" ", strip=True)[:4000])
    return match.group(1) if match else None


def gpp_unit(soup: BeautifulSoup) -> tuple[str, float]:
    """Currency and litres-per-unit implied by the page's own wording."""
    text = soup.get_text(" ", strip=True)[:4000].lower()
    currency = "EUR" if ("euro" in text and "dollar" not in text) else "USD"
    if "gallon" in text and "liter" not in text and "litre" not in text:
        return currency, LITRES_PER_US_GALLON
    return currency, 1.0


def gpp_pairs(soup: BeautifulSoup, html: str, fuel: str) -> list[tuple[str, float]]:
    """Country/price pairs from a GlobalPetrolPrices chart page.

    The page renders the ranking as two parallel lists - country links on one
    side, price labels on the other - rather than as a table, so pair them by
    position and fall back to a plain table if the layout ever changes.
    """
    countries = [a.get_text(" ", strip=True)
                 for a in soup.select("#outsideLinks a")]
    if not countries:
        # Same idea, straight off the markup, in case the ids change.
        countries = [m.group(1) for m in re.finditer(
            rf'href="/([^"/]+)/{fuel}_prices/"', html, re.IGNORECASE)]

    prices = [parse_number(node.get_text())
              for node in soup.select(".pricenumbers")]
    if not prices:
        # The bar labels carry no stable class name, so take every standalone
        # price-shaped number inside the chart, in document order.
        chart = soup.find(id="graphic") or soup
        prices = [float(text.replace(",", "."))
                  for text in chart.stripped_strings
                  if re.fullmatch(r"\d{1,2}[.,]\d{2,3}", text)]

    if countries and prices and len(countries) == len(prices):
        return [(c, p) for c, p in zip(countries, prices) if p is not None]

    # Last resort: an ordinary table of country and price.
    for table in soup.find_all("table"):
        headers, rows = split_header(table_to_grid(table))
        country_index = find_country_column(headers)
        pairs = []
        for row in rows:
            if len(row) < 2:
                continue
            value = next((parse_number(cell) for cell in row[country_index + 1:]
                          if parse_number(cell) is not None), None)
            if value is not None:
                pairs.append((row[country_index], value))
        if len(pairs) > 20:
            return pairs

    log.error("Could not pair countries with prices on the %s page: "
              "%d countries, %d prices", fuel, len(countries), len(prices))
    log.error("  first countries: %s", ", ".join(countries[:5]) or "none")
    log.error("  first prices: %s", ", ".join(str(p) for p in prices[:5]) or "none")
    log.error("  element ids seen: %s", ", ".join(sorted({
        str(tag.get("id")) for tag in soup.find_all(id=True)})[:40]) or "none")
    log.error("  classes seen: %s", ", ".join(sorted({
        cls for tag in soup.find_all(class_=True)
        for cls in tag.get("class", [])})[:40]) or "none")
    chart = soup.find(id="graphic")
    if chart is not None:
        log.error("  chart markup: %s", str(chart)[:1500].replace("\n", " "))
    return []


def scrape_fuel_page(url: str, fuel: str, rates: dict[str, float]) -> tuple[dict[str, float], str | None]:
    """Country key -> price in EUR per litre for one fuel."""
    html = http_get(url).text
    soup = BeautifulSoup(html, "html.parser")

    currency, litres_per_unit = gpp_unit(soup)
    date = gpp_price_date(soup)
    pairs = gpp_pairs(soup, html, fuel)
    log.info("%s page: %d entries, priced in %s per %.4f L, dated %s",
             fuel, len(pairs), currency, litres_per_unit, date or "unknown")

    prices: dict[str, float] = {}
    names: dict[str, str] = {}
    for raw_name, value in pairs:
        country = canonical_country(raw_name)
        if country is None or value <= 0:
            continue
        name, key = country
        if key in prices:
            continue
        eur = to_eur(value / litres_per_unit, currency, rates)
        if eur is None:
            continue
        if not MIN_FUEL_EUR_PER_L <= eur <= MAX_FUEL_EUR_PER_L:
            log.warning("Implausible %s price for %s: %.3f EUR/L (raw %r) - dropped",
                        fuel, name, eur, value)
            continue
        prices[key] = round(eur, 3)
        names[key] = name

    log.info("  kept %d %s prices, e.g. %s", len(prices), fuel,
             ", ".join(f"{names[k]} {prices[k]}" for k in list(prices)[:3]) or "none")
    FUEL_NAMES.update(names)
    return prices, date


def scrape_fuel_prices(rates: dict[str, float]) -> dict[str, dict]:
    """Country key -> fuel price record (EUR per litre)."""
    petrol, petrol_date = scrape_fuel_page(FUEL_URLS["petrol"], "gasoline", rates)
    diesel, diesel_date = scrape_fuel_page(FUEL_URLS["diesel"], "diesel", rates)

    if not petrol and not diesel:
        raise RuntimeError("no fuel prices could be read from GlobalPetrolPrices")

    result: dict[str, dict] = {}
    for key in set(petrol) | set(diesel):
        result[key] = {
            "country": FUEL_NAMES.get(key, key),
            "petrol_eur_l": petrol.get(key),
            "diesel_eur_l": diesel.get(key),
            "fuel_price_date": petrol_date or diesel_date,
        }

    log.info("Parsed %d countries with at least one fuel price", len(result))
    return result


# --------------------------------------------------------------------------
def build_dataset() -> dict:
    fx = fetch_eur_rates()
    rates = fx["rates"]

    wages = scrape_minimum_wages(rates)
    fuels = scrape_fuel_prices(rates)

    countries = []
    for key in sorted(set(wages) & set(fuels)):
        wage = wages[key]
        fuel = fuels[key]
        monthly = wage["min_wage_eur_month"]

        entry = {
            "country": wage["country"],
            "code": flag_code(key),
            "min_wage_eur_month": monthly,
            "petrol_eur_l": fuel["petrol_eur_l"],
            "diesel_eur_l": fuel["diesel_eur_l"],
            "petrol_litres": round(monthly / fuel["petrol_eur_l"], 1) if fuel["petrol_eur_l"] else None,
            "diesel_litres": round(monthly / fuel["diesel_eur_l"], 1) if fuel["diesel_eur_l"] else None,
            "wage_basis": wage["wage_basis"],
            "wage_effective": wage["wage_effective"],
            "fuel_price_date": fuel["fuel_price_date"],
        }
        countries.append(entry)

    if not countries:
        raise RuntimeError("no country appears in both the wage and the fuel data")

    missing_wage = sorted(fuels[k]["country"] for k in set(fuels) - set(wages))
    missing_fuel = sorted(wages[k]["country"] for k in set(wages) - set(fuels))
    log.info("Matched %d countries (%d fuel-only, %d wage-only)",
             len(countries), len(missing_wage), len(missing_fuel))
    # Unmatched names are usually a missing alias, so make them visible.
    log.info("  no wage data:  %s", ", ".join(missing_wage[:25]) or "-")
    log.info("  no fuel price: %s", ", ".join(missing_fuel[:25]) or "-")

    petrol_litres = [c["petrol_litres"] for c in countries if c["petrol_litres"]]
    return {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "base_currency": "EUR",
        "fx": {"date": fx["date"], "usd_per_eur": rates.get("USD")},
        "sources": {
            "minimum_wage": WAGE_URL,
            "fuel_prices": FUEL_URLS["petrol"],
            "diesel_prices": FUEL_URLS["diesel"],
            "exchange_rates": FRANKFURTER_URLS[0],
        },
        "stats": {
            "countries": len(countries),
            "median_petrol_litres": round(sorted(petrol_litres)[len(petrol_litres) // 2], 1)
            if petrol_litres else None,
        },
        "countries": countries,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="data/fuel_prices.json",
                        help="path of the JSON file to write")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
        stream=sys.stdout,
    )

    try:
        dataset = build_dataset()
    except Exception as exc:  # noqa: BLE001 - CI needs the reason, not a traceback dump
        log.error("Data collection failed: %s", exc)
        return 1

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(dataset, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    log.info("Wrote %s (%d countries)", output, len(dataset["countries"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
