# CLAUDE.md

Hackathon project (Fraunhofer IIS Track 1): optimise timetables, routes, driver rotas and vehicles
so Nuremberg can run extra express buses with little or no additional driver staff.

- Python 3.13, venv in `.venv/` (activate before running anything).
- Package code lives in `src/expressbus/`; demo UI in `app/streamlit_app.py`.
- Optimisation: OR-Tools (CP-SAT) / PuLP. Data: GTFS via gtfs-kit, pandas.
- Raw data goes in `data/raw/` (not committed).
- Tests: `pytest`. Lint: `ruff check .`
