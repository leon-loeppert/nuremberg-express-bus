# CLAUDE.md

Hackathon project (Fraunhofer IIS Track 1): optimise timetables, routes, driver rotas and vehicles
so Nuremberg can run extra express buses with little or no additional driver staff.

- Python 3.13, venv in `.venv/` (activate before running anything).
- Package code lives in `src/expressbus/`; demo UI in `app/streamlit_app.py`.
- Optimisation: OR-Tools (CP-SAT) / PuLP. Data: GTFS via gtfs-kit, pandas.
- Raw data goes in `data/raw/` (not committed).
- Tests: `pytest`. Lint: `ruff check .`
- Live map: `uvicorn app.livemap.server:app --reload --reload-dir app --reload-dir src` (port 8000).
  Data client in `src/expressbus/data/vag.py`, poller in `src/expressbus/live/tracker.py`,
  frontend is plain Leaflet in `app/livemap/static/`.
- Visual checks: Playwright + Chromium are installed in the venv (headless screenshots).
