"""Throwaway: find out where the per-country fuel price table lives now."""
import re
import sys
from urllib.parse import quote

sys.path.insert(0, "scripts")
import fetch_data as fd  # noqa: E402

import logging
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s", stream=sys.stdout)

ART = "Gasoline_and_diesel_usage_and_pricing"


def raw(title: str) -> str:
    return fd.http_get(f"https://en.wikipedia.org/wiki/{title}?action=raw").text


print("=" * 70)
print("WIKITEXT of", ART)
text = raw(ART)
print("length:", len(text))
print("table starts ('{|'):", text.count("{|"))
for pattern in ("Gasoline prices", "Diesel prices", "Main article", "See also",
                "globalpetrolprices", "{|", "== "):
    print(f"\n--- lines containing {pattern!r} ---")
    for i, line in enumerate(text.splitlines()):
        if pattern in line:
            print(f"  {i}: {line[:300]}")

print("=" * 70)
print("EXTRA SEARCHES")
for query in [
    'insource:/US\\$\\/L/',
    'insource:"price of gasoline" insource:"price of diesel" list',
    "gasoline prices per litre country table",
    "list of countries by fuel price",
    'intitle:prices gasoline diesel',
    'insource:"Pump price" gasoline diesel',
]:
    try:
        print(f"\n{query!r}:")
        url = (f"{fd.WIKI_API}?action=query&list=search&format=json"
               f"&srlimit=10&srsearch={quote(query)}")
        for hit in fd.http_get(url).json()["query"]["search"]:
            print("   -", hit["title"])
    except Exception as exc:
        print("   failed:", exc)

print("=" * 70)
print("REDIRECTS / links out of the article")
for m in re.finditer(r"\[\[([^\]|]{3,60})", text):
    title = m.group(1)
    if re.search(r"price|fuel|petrol|gasoline|diesel", title, re.I):
        print("   -", title)
