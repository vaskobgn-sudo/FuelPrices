# Горива и минимални заплати

Уеб приложение, което сравнява **колко литра бензин и дизел се купуват с една
месечна минимална заплата** в различни държави. Всички суми са преизчислени в
евро, за да са сравними.

| Част | Технология |
| --- | --- |
| Събиране на данни | Python скрипт (Wikipedia scraping + Frankfurter API) |
| Автоматизация | GitHub Actions, веднъж дневно |
| Интерфейс | чист HTML / CSS / JavaScript, без зависимости |

## Структура

```
index.html                     страницата
assets/css/styles.css          оформление (mobile-first)
assets/js/app.js               зареждане на данните, сортиране, търсене
data/fuel_prices.json          генерираните данни (обновяват се автоматично)
scripts/fetch_data.py          скрейпърът
scripts/test_parser.py         офлайн тестове на парсера
.github/workflows/update-data.yml   дневната автоматизация
```

## Източници на данни

* [List of countries by minimum wage](https://en.wikipedia.org/wiki/List_of_countries_by_minimum_wage) — минимални заплати
* [Gasoline and diesel usage and pricing](https://en.wikipedia.org/wiki/Gasoline_and_diesel_usage_and_pricing) — цени на горива
* [Frankfurter API](https://api.frankfurter.dev) — валутни курсове (данни на ЕЦБ)

## Как работи скрейпърът

1. Тегли курсовете от Frankfurter с база EUR.
2. Сваля двете страници от Wikipedia и намира подходящите таблици.
3. **Открива колоните по текста на заглавията им**, а не по номер — Wikipedia
   сменя структурата на таблиците често, а така скриптът я преживява. Предпочита
   номинални стойности пред PPP и цени за литър пред цени за галон (галоните се
   преизчисляват автоматично).
4. Нормализира заплатите до **месечна** стойност (годишните се делят на 12,
   почасовите се умножават по работната седмица) и всичко се конвертира в евро.
5. Свързва двете таблици по име на държава, като изравнява различните изписвания
   (`Czech Republic` / `Czechia`, `Türkiye` / `Turkey`, `Ivory Coast` /
   `Côte d'Ivoire` и т.н.).
6. Отхвърля неправдоподобни стойности (заплата над 20 000 €/месец, цена на гориво
   над 10 €/литър) — те почти винаги са грешка в разчитането, а не реални данни.
7. Записва `data/fuel_prices.json`.

В резултата влизат само държави, за които има **и** минимална заплата, **и** цена
на гориво.

### Формат на JSON файла

```jsonc
{
  "generated_at": "2026-08-02T04:21:07Z",
  "base_currency": "EUR",
  "fx": { "date": "2026-08-01", "usd_per_eur": 1.0842 },
  "sources": { "minimum_wage": "...", "fuel_prices": "...", "exchange_rates": "..." },
  "stats": { "countries": 120, "median_petrol_litres": 611.4 },
  "countries": [
    {
      "country": "Bulgaria",
      "code": "BG",                  // ISO 3166-1 alpha-2, за знамето
      "min_wage_eur_month": 501.82,
      "petrol_eur_l": 1.254,
      "diesel_eur_l": 1.286,
      "petrol_litres": 400.2,        // литри бензин за една минимална заплата
      "diesel_litres": 390.2,
      "wage_basis": "annual",        // от каква колона идва заплатата
      "wage_effective": "1 January 2025",
      "fuel_price_date": "2025-06-30"
    }
  ]
}
```

## Локално пускане

```bash
pip install -r scripts/requirements.txt

python scripts/test_parser.py                  # офлайн тестове, без мрежа
python scripts/fetch_data.py                   # записва data/fuel_prices.json

python3 -m http.server 8000                    # после отворете http://localhost:8000
```

Страницата чете JSON файла през `fetch()`, затова трябва да се отвори през
сървър, а не с двоен клик върху `index.html`.

## Автоматично обновяване

`.github/workflows/update-data.yml` се изпълнява всеки ден в 04:20 UTC: пуска
тестовете, стартира скрейпъра и комитва `data/fuel_prices.json`, ако има промяна.
Може да се пусне и ръчно от раздела **Actions → Update fuel price data → Run
workflow**.

Cron се изпълнява само от основния клон на репото. Ако работният клон бъде слят
в друг основен клон, workflow-ът трябва да присъства там.

## Публикуване

Проектът е статичен — става за GitHub Pages без промени:
**Settings → Pages → Source: Deploy from a branch**, и се избира клонът и папката
`/ (root)`.

## Интерфейс

* Таблицата по подразбиране е подредена по държава (азбучен ред).
* Всяка друга колона се сортира възходящо/низходящо с клик върху заглавието ѝ.
  Заглавията са бутони, така че работят и с клавиатура.
* На тесни екрани таблицата се превръща в карти, а сортирането става през
  падащото меню и бутона за посока.
* Търсачката филтрира по име на държава.
