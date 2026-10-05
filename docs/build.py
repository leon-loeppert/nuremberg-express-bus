"""Build docs/index.html from template.html, the screenshots and the budget data.

    python docs/build.py
"""

import html
import json
from pathlib import Path

DOCS = Path(__file__).parent

# (image, title, intro, [(x %, y %, callout text)])  - pin positions relative to the 1440×900 screenshot
SHOTS = [
    ("01-live.jpg", "Live: what runs now",
     "Every bus, tram and U-Bahn moves along the streets in real time, coloured by delay. VAG's own live map shows only rail. Every finished trip is recorded as delay data.",
     [(11, 17, "Vehicles on the road and punctuality right now"),
      (11, 38, "Most delayed lines; click one to show only that line"),
      (62, 45, "Each vehicle follows its line on the street; the dot shows its delay")]),
    ("02-express-check.jpg", "Express check: the answer in one place",
     "The tool searches the city for express corridors, prices them in drivers and funds them from bus service that duplicates rail.",
     [(12, 11, "The verdict: three express lines, no new drivers, and who gains or loses"),
      (12, 39, "One click opens the whole package in the planner"),
      (12, 64, "The package: express lines (+) and the cuts that pay for them (−)"),
      (59, 47, "Proposed express lines follow real streets")]),
    ("03-region.jpg", "Drill into a problem area",
     "Under-served regions are whole neighbourhoods built from adjacent cells, named after the district. Selecting one shows its lines, stops and suggestions with their driver cost.",
     [(12, 18, "Region: residents and how well it is served"),
      (12, 27, "The lines serving it; click a chip to highlight that line"),
      (12, 40, "Suggestions with driver cost and passenger effect, plus 'Add to plan'"),
      (60, 40, "Red cells: the under-served region on the map")]),
    ("05-draw.jpg", "Add your own line by clicking stops",
     "Choose 'Add express line', click stations on the map in order, and set frequency and hours. The draft is routed along the streets immediately.",
     [(49, 3, "Drawing mode"),
      (12, 47, "The stops you clicked, in order; remove any with ×"),
      (55, 47, "The draft line, routed on real streets"),
      (17, 59, "Add it to the scenario: the budget reacts instantly")]),
    ("06-over-budget.jpg", "Every change has a price in drivers",
     "After adding three express lines the inventory shows 106 %: 15 drivers are missing, and the daily curve shows exactly when.",
     [(74, 11, "Capacity in use jumps to 106 %"),
      (97.5, 21, "The red part of the bar: 15 drivers missing"),
      (80, 31, "The scenario curve hits the limit in the morning peak"),
      (1.8, 26, "Each change shows its own cost: −5 drivers, −69 h")]),
    ("07-balanced.jpg", "Free drivers until the budget is back at 100 %",
     "Thinning bus lines that run next to rail frees drivers one by one. Each card shows what it frees; the inventory animates back to 100 %.",
     [(95, 8, "Animated feedback: +11 drivers"),
      (74, 11, "Back within budget: 272 / 272"),
      (1.8, 69, "The cuts and what each one frees"),
      (63, 55, "Thinned lines are marked on the map")]),
    ("08-evaluation.jpg", "Replay last week with and without the changes",
     "One click re-plans every zone-to-zone trip for 28 Sep – 4 Oct and compares travel time, waits, delays and drivers. 'Show all KPIs' opens the full table.",
     [(88, 52, "Run the week-long evaluation"),
      (88, 67, "Key KPIs before and after; ✓ better, ▲ worse")]),
]


def shot_html(i: int, img: str, title: str, intro: str, pins: list) -> str:
    pin_tags = "".join(f'<span class="pin" style="left:{x}%;top:{y}%">{k + 1}</span>' for k, (x, y, _) in enumerate(pins))
    items = "".join(f'<li><b class="k">{k + 1}</b><span>{html.escape(t)}</span></li>' for k, (_, _, t) in enumerate(pins))
    return f"""
  <section class="shot">
    <div class="head"><span class="num">{i}</span><div><h3>{html.escape(title)}</h3><p>{html.escape(intro)}</p></div></div>
    <div class="frame"><img src="img/{img}" alt="{html.escape(title)}" loading="lazy" />{pin_tags}</div>
    <ul class="pins">{items}</ul>
  </section>"""


def main() -> None:
    data = json.loads((DOCS / "data" / "budget_steps.json").read_text())
    shots = "".join(shot_html(i + 1, *s) for i, s in enumerate(SHOTS))
    page = (DOCS / "template.html").read_text().replace("__SHOTS__", shots).replace("__DATA__", json.dumps(data, ensure_ascii=False))
    (DOCS / "index.html").write_text(page)
    print("wrote", DOCS / "index.html")


if __name__ == "__main__":
    main()
