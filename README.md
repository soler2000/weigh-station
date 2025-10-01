# Weigh Station

Raspberry Pi + Brecknell B140 bench station for component weighing with 4 product variants, barcode serial capture, pass/fail UI (green/red), calibration trims, and CSV export.

## Features
- 4 variants (editable in **Settings**) with independent min/max.
- Big live weight readout (0.1 g), screen background **green** in-range / **red** out-of-range.
- USB barcode scanner (HID) for serials.
- Capture moulding serial, final serial, contract, order number, operator, colour, and notes for every weigh.
- Calibration (Tare + Known mass) web UI.
- Drift minimization: median+EMA filtering with stability gating.
- CSV export.
- Serial log page for live RS-232 frame debugging when troubleshooting scale connectivity.

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
| `SCALE_TIMEOUT` | `0.5` | Read timeout in seconds before the reader logs a lack-of-data event. |
| `SCALE_BYTESIZE` | `8` | Data bits (`5`–`8`). |
| `SCALE_PARITY` | `none` | Parity (`none`, `even`, `odd`, `mark`, `space`). |
| `SCALE_STOPBITS` | `1` | Stop bits (`1`, `1.5`, `2`). |
| `SCALE_XONXOFF` | `false` | Enable software flow control. |
| `SCALE_RTSCTS` | `false` | Enable RTS/CTS hardware flow control. |
| `SCALE_DSRDTR` | `false` | Enable DSR/DTR hardware flow control. |
| `SCALE_FORCE_DTR` | `true` | Force DTR high after opening the port (some adapters require this for streaming). |
| `SCALE_FORCE_RTS` | `true` | Force RTS high after opening the port. |
| `SCALE_NATIVE_COUNTS_PER_GRAM` | `1000` | Internal counts-per-gram factor used for weight conversion math. |
| `SCALE_KG_TO_GRAMS` | `1000` | Multiplier applied to values reported in kilograms by the B140 indicator (supports decimals for fractional scaling). |
| `SCALE_NET_UNIT` | `auto` | Default unit when a Net line omits an explicit unit (`auto`, `kg`, `g`, `lb`, or `oz`). |
| `SCALE_FRAME_TERMINATOR` | `\r` | Frame terminator (escape sequences like `\r\n` are supported). |
| `SCALE_FRAME_MAX_BYTES` | `64` | Max bytes to accumulate while waiting for a terminator. |
