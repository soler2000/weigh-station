# Weigh Station

Raspberry Pi + HX711 bench station for component weighing with 4 product variants, barcode serial capture, pass/fail UI (green/red), calibration, and CSV export.

## Features
- 4 variants (editable in **Settings**) with independent min/max.
- Big live weight readout (0.1 g), screen background **green** in-range / **red** out-of-range.
- USB barcode scanner (HID) for serials.
- Calibration (Tare + Known mass) web UI.
- Drift minimization: median+EMA filtering, stability gating, **auto-tare on idle**.
- CSV export.

## Hardware
- 4x half-bridge load cells → Load Cell Combinator → **HX711** (A/128) → Raspberry Pi GPIO.
- Keep HX711 at **10 Hz** for stability (default).

## Setup
```bash
sudo apt update && sudo apt install -y python3-venv git
git clone https://github.com/<your-org>/weigh-station.git
cd weigh-station
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000