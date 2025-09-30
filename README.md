# Weigh Station

Raspberry Pi + Brecknell B140 bench station for component weighing with 4 product variants, barcode serial capture, pass/fail UI (green/red), calibration trims, and CSV export.

## Features
- 4 variants (editable in **Settings**) with independent min/max.
- Big live weight readout (0.1 g), screen background **green** in-range / **red** out-of-range.
- USB barcode scanner (HID) for serials.
- Calibration (Tare + Known mass) web UI.
- Drift minimization: median+EMA filtering with stability gating.
- CSV export.

## Hardware
- Brecknell Model B140 indicator connected over RS-232 (USB-to-serial adapter on the Pi).
- Default serial port `/dev/ttyUSB0` at 9600 baud; override with `SCALE_PORT` / `SCALE_BAUD` env vars if required.

## Setup
```bash
sudo apt update && sudo apt install -y python3-venv git
git clone https://github.com/<your-org>/weigh-station.git
cd weigh-station
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### Environment variables

| Name | Default | Description |
| --- | --- | --- |
| `SCALE_PORT` | `/dev/ttyUSB0` | Serial device for the B140 indicator. |
| `SCALE_BAUD` | `9600` | Serial baud rate. |
| `SCALE_NATIVE_COUNTS_PER_GRAM` | `1000` | Internal counts-per-gram factor used for calibration math. |
