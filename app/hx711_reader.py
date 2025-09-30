"""Scale reader for Brecknell B140 over RS-232."""
import os
import re
import threading
import time
from collections import deque
from datetime import datetime
from statistics import median, pstdev
from typing import Any

import serial


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return bool(default)
    value = value.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return bool(default)


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except (TypeError, ValueError):
        return float(default)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return int(default)


class ADCNotReadyError(RuntimeError):
    """Raised when the serial scale does not provide fresh data in time."""


class ScaleReader:
    """
    Threaded reader for the Brecknell B140 scale connected via RS-232.

    The scale continuously streams ASCII frames such as:
        ``ST,GS,  0.000kg`` or ``US,NT,+12.34 g``

    We parse the numeric value, normalise to grams, and expose filtered
    readings with a stability hint. The interface matches the previous HX711
    implementation so the rest of the application can remain unchanged.
    """

    _LINE_SPLIT_RE = re.compile(r"[,\s]+")
    _NUMBER_PATTERN = r"[-+]?(?:\d+(?:\.\d+)?|\.\d+)"
    _NUMBER_RE = re.compile(_NUMBER_PATTERN)
    _NUMBER_WITH_UNIT_RE = re.compile(
        rf"({_NUMBER_PATTERN})\s*(KG|KGS?|KILOGRAMS?|LB|LBS?|POUNDS?|OZ|OZS?|OUNCES?|G|GRAMS?)",
        re.IGNORECASE,
    )
    _NET_VALUE_RE = re.compile(
        rf"\bNET(?:\s+WEIGHT)?\b[:=\s]*({_NUMBER_PATTERN})(?:\s*(KG|KGS?|KILOGRAMS?|LB|LBS?|POUNDS?|OZ|OZS?|OUNCES?|G|GRAMS?))?",
        re.IGNORECASE,
    )
    _VERBOSE_FIELD_RE = re.compile(
        r"\b(DATE|TIME|GROSS|TARE|MERCHANDISE|PIECE|TOTAL|COUNT|ITEM)\b",
        re.IGNORECASE,
    )

    def __init__(
        self,
        *,
        serial_port: str | None = None,
        baudrate: int | None = None,
        native_counts_per_gram: float | None = None,
        alpha: float = 0.2,
        window: int = 10,
        display_precision: float = 0.1,
    ) -> None:
        self.serial_port = serial_port or os.getenv("SCALE_PORT", "/dev/ttyUSB0")
        self.baudrate = baudrate or _env_int("SCALE_BAUD", 9600)
        self.timeout = _env_float("SCALE_TIMEOUT", 0.5)
        self.native_counts_per_gram = (
            native_counts_per_gram or _env_float("SCALE_NATIVE_COUNTS_PER_GRAM", 1000.0)
        )

        self.bytesize = self._coerce_bytesize(os.getenv("SCALE_BYTESIZE"))
        self.parity = self._coerce_parity(os.getenv("SCALE_PARITY"))
        self.stopbits = self._coerce_stopbits(os.getenv("SCALE_STOPBITS"))
        self.xonxoff = _env_bool("SCALE_XONXOFF", False)
        self.rtscts = _env_bool("SCALE_RTSCTS", False)
        self.dsrdtr = _env_bool("SCALE_DSRDTR", False)
        self.set_dtr = _env_bool("SCALE_FORCE_DTR", True)
        self.set_rts = _env_bool("SCALE_FORCE_RTS", True)

        self.frame_terminator = self._coerce_terminator(
            os.getenv("SCALE_FRAME_TERMINATOR", "\\r"),
        )
        self.frame_max_bytes = _env_int("SCALE_FRAME_MAX_BYTES", 64)
        if self.frame_max_bytes <= 0:
            self.frame_max_bytes = 64

        self.alpha = alpha
        self.window = deque(maxlen=window)
        self.display_precision = display_precision

        self._serial: serial.Serial | None = None
        self._serial_lock = threading.Lock()
        self._state_lock = threading.RLock()

        self._zero_offset = 0
        self._scale_factor = float(self.native_counts_per_gram)
        self._scale_sign = 1

        self.ema: float | None = None
        self.running = False
        self.latest = dict(g=0.0, stable=False, raw=0)

        self._last_raw_counts: int | None = None
        self._last_update_ts: float = 0.0
        self._raw_log: deque[dict[str, Any]] = deque(maxlen=2000)
        self._last_data_ts: float | None = None

    # ------------------------------------------------------------------
    # Calibration helpers (maintain HX711-compatible API)
    def set_calibration(self, zero_offset: int, scale_factor: float) -> None:
        with self._state_lock:
            self._zero_offset = int(zero_offset)
            self._scale_sign = 1 if scale_factor >= 0 else -1
            self._scale_factor = float(abs(scale_factor) if abs(scale_factor) > 1e-9 else 1.0)

    def get_calibration(self) -> dict:
        with self._state_lock:
            return dict(
                zero_offset=self._zero_offset,
                scale_factor=self._scale_factor,
                scale_sign=self._scale_sign,
            )

    # ------------------------------------------------------------------
    def start(self, hz: int | None = None) -> None:
        if self.running:
            return
        self.running = True
        threading.Thread(target=self._loop, name="ScaleReader", daemon=True).start()

    def stop(self) -> None:
        self.running = False
        with self._serial_lock:
            if self._serial and self._serial.is_open:
                try:
                    self._serial.close()
                except Exception:
                    pass
            self._serial = None

    # ------------------------------------------------------------------
    def read_latest(self) -> dict:
        with self._state_lock:
            return dict(self.latest)

    def read_raw_avg(self, n: int = 12) -> int:
        with self._state_lock:
            raw = self._last_raw_counts
            ts = self._last_update_ts
        if raw is None or (time.time() - ts) > 1.0:
            raise ADCNotReadyError("Scale did not provide fresh data")
        return int(raw)

    def get_serial_log(self, limit: int = 200) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), self._raw_log.maxlen or 2000))
        with self._state_lock:
            items = list(self._raw_log)[-limit:]
        result: list[dict[str, Any]] = []
        for item in items:
            ts = float(item.get("ts", 0.0) or 0.0)
            ts_iso = None
            if ts:
                ts_iso = datetime.fromtimestamp(ts).isoformat(timespec="milliseconds")
            result.append(
                dict(
                    ts=ts_iso,
                    raw=str(item.get("raw", "")),
                    parsed=bool(item.get("parsed", False)),
                    grams=item.get("grams"),
                    raw_counts=item.get("raw_counts"),
                    stable_hint=item.get("stable_hint"),
                    event=item.get("event"),
                )
            )
        return result

    # ------------------------------------------------------------------
    def _loop(self) -> None:
        backoff = 1.0
        while self.running:
            if not self._ensure_serial():
                time.sleep(backoff)
                backoff = min(backoff * 2.0, 10.0)
                continue

            backoff = 1.0
            try:
                line = self._serial.read_until(
                    expected=self.frame_terminator,
                    size=self.frame_max_bytes,
                )
                if not line:
                    self._emit_idle_event()
                    continue
                try:
                    text = line.decode("ascii", errors="ignore").strip()
                except Exception:
                    continue
                if not text:
                    self._emit_idle_event()
                    continue
                self._note_data_received()
                log_entry: dict[str, Any] = {"ts": time.time(), "raw": text}
                parsed = self._parse_line(text)
                if parsed is None:
                    log_entry["parsed"] = False
                else:
                    grams, raw_counts, stable_hint = parsed
                    log_entry.update(
                        parsed=True,
                        grams=grams,
                        raw_counts=raw_counts,
                        stable_hint=stable_hint,
                    )
                    self._update(raw_counts, stable_hint)
                self._append_log(log_entry)
            except serial.SerialException as exc:
                self._append_log({"event": f"Serial exception: {exc}", "ts": time.time()})
                self._reset_serial()
                time.sleep(backoff)
                backoff = min(backoff * 2.0, 10.0)
            except Exception as exc:
                self._append_log({"event": f"Parse error: {exc}", "ts": time.time()})
                continue

    def _ensure_serial(self) -> bool:
        with self._serial_lock:
            if self._serial and self._serial.is_open:
                return True
            try:
                self._serial = serial.Serial(
                    self.serial_port,
                    baudrate=self.baudrate,
                    timeout=self.timeout,
                    bytesize=self.bytesize,
                    parity=self.parity,
                    stopbits=self.stopbits,
                    xonxoff=self.xonxoff,
                    rtscts=self.rtscts,
                    dsrdtr=self.dsrdtr,
                )
                self._serial.reset_input_buffer()
                if self.set_dtr:
                    try:
                        self._serial.dtr = True
                    except Exception:
                        pass
                if self.set_rts:
                    try:
                        self._serial.rts = True
                    except Exception:
                        pass
                self._append_log(
                    {
                        "event": f"Opened {self.serial_port} @ {self.baudrate} baud",
                        "ts": time.time(),
                    }
                )
                return True
            except serial.SerialException as exc:
                self._serial = None
                self._append_log({"event": f"Serial open failed: {exc}", "ts": time.time()})
                return False

    def _reset_serial(self) -> None:
        with self._serial_lock:
            if self._serial:
                try:
                    self._serial.close()
                except Exception:
                    pass
            self._serial = None
            self._append_log({"event": "Serial connection closed", "ts": time.time()})

    # ------------------------------------------------------------------
    def _emit_idle_event(self) -> None:
        now = time.time()
        if self._last_data_ts is None:
            self._last_data_ts = now
            return
        if (now - self._last_data_ts) < max(self.timeout, 0.5):
            return
        self._append_log(
            {
                "event": f"No serial data for {now - self._last_data_ts:.1f}s",
                "ts": now,
            }
        )
        self._last_data_ts = now

    def _parse_line(self, text: str) -> tuple[float, int, bool | None] | None:
        """Return (grams, raw_counts, stable_hint) if line parsed; else None."""
        tokens = [tok.strip() for tok in self._LINE_SPLIT_RE.split(text) if tok.strip()]
        if not tokens:
            return None

        upper_tokens = [tok.upper() for tok in tokens]

        stable_hint: bool | None = None
        for tok in upper_tokens:
            if tok in {"US", "UN", "UNSTABLE"}:
                stable_hint = False
                break
            if tok in {"ST", "STABLE"}:
                stable_hint = True

        grams = self._extract_grams(text, tokens)
        if grams is None:
            return None

        raw_counts = int(round(grams * self.native_counts_per_gram))
        return grams, raw_counts, stable_hint

    def _extract_grams(self, text: str, tokens: list[str]) -> float | None:
        """Attempt to extract a numeric weight in grams from the raw text."""

        def _apply_unit(value: float, unit: str) -> float:
            unit = unit.lower()
            if unit.startswith("kg") or "kilogram" in unit:
                return value * 1000.0
            if unit.startswith("lb") or "pound" in unit:
                return value * 453.59237
            if unit.startswith("oz") or "ounce" in unit:
                return value * 28.349523125
            return value

        # 0) If this is a "Net" line from the verbose printout, only use that value.
        net_match = self._NET_VALUE_RE.search(text)
        if net_match:
            try:
                value = float(net_match.group(1))
            except (TypeError, ValueError):
                pass
            else:
                unit = net_match.group(2)
                if unit:
                    return _apply_unit(value, unit)
                # Default verbose printouts are configured in kilograms; fall back to kg.
                return _apply_unit(value, "kg")

        # If the frame includes other verbose ticket fields (Gross, Tare, etc.) but no
        # usable Net value, ignore it so we do not treat those as live weights.
        if self._VERBOSE_FIELD_RE.search(text):
            return None

        # 1) Prefer explicit number+unit pair anywhere in the text.
        match = self._NUMBER_WITH_UNIT_RE.search(text)
        if match:
            try:
                value = float(match.group(1))
                unit = match.group(2)
            except (TypeError, ValueError):
                pass
            else:
                return _apply_unit(value, unit)

        # 2) Look for tokens that embed units (e.g. "1.23Kg", "2lb").
        for token in tokens:
            lower = token.lower()
            for unit in ("kg", "kilogram", "lb", "pound", "oz", "ounce", "g", "gram"):
                idx = lower.find(unit)
                if idx == -1:
                    continue
                number_part = token[:idx] if idx > 0 else token[idx + len(unit) :]
                match = self._NUMBER_RE.search(number_part)
                if not match and idx > 0:
                    continue
                if not match and idx == 0:
                    match = self._NUMBER_RE.search(token[idx + len(unit) :])
                if not match:
                    continue
                try:
                    value = float(match.group())
                except ValueError:
                    continue
                return _apply_unit(value, unit)

        # 3) If the unit is in its own token, use neighbouring numeric token.
        upper_tokens = [tok.upper() for tok in tokens]
        for idx, tok in enumerate(upper_tokens):
            if tok not in {"KG", "KGS", "KILOGRAM", "KILOGRAMS", "LB", "LBS", "POUND", "POUNDS", "OZ", "OZS", "OUNCE", "OUNCES", "G", "GRAM", "GRAMS"}:
                continue
            unit_token = tokens[idx]
            neighbours = []
            if idx > 0:
                neighbours.append(tokens[idx - 1])
            if idx + 1 < len(tokens):
                neighbours.append(tokens[idx + 1])
            for neighbour in neighbours:
                match = self._NUMBER_RE.search(neighbour)
                if not match:
                    continue
                try:
                    value = float(match.group())
                except ValueError:
                    continue
                return _apply_unit(value, unit_token)

        # 4) Fall back to the first reasonable numeric token.
        for token in tokens:
            match = self._NUMBER_RE.search(token)
            if not match:
                continue
            try:
                value = float(match.group())
            except ValueError:
                continue
            # Skip obviously non-weight numbers (timestamps etc.).
            if abs(value) > 1e6:
                continue
            return value

        return None

    def _update(self, raw_counts: int, stable_hint: bool | None) -> None:
        with self._state_lock:
            zero_offset = self._zero_offset
            scale_factor = self._scale_factor
            scale_sign = self._scale_sign

        grams = scale_sign * (raw_counts - zero_offset) / scale_factor

        self.window.append(grams)
        med = median(self.window) if self.window else grams
        self.ema = med if self.ema is None else (self.alpha * med + (1 - self.alpha) * self.ema)

        computed_stable = (
            len(self.window) >= max(5, self.window.maxlen // 2)
            and pstdev(self.window) < 0.05
        )
        stable = stable_hint if stable_hint is not None else computed_stable

        value_for_display = self.ema if self.ema is not None else grams
        precision = self.display_precision if self.display_precision > 0 else 0.1
        g_display = round(round(value_for_display / precision) * precision, 3)

        with self._state_lock:
            self.latest = dict(g=g_display, stable=stable, raw=int(raw_counts))
            self._last_raw_counts = int(raw_counts)
            self._last_update_ts = time.time()
            self._last_data_ts = self._last_update_ts

    def _append_log(self, entry: dict[str, Any]) -> None:
        item = dict(entry)
        item.setdefault("ts", time.time())
        with self._state_lock:
            self._raw_log.append(item)

    # ------------------------------------------------------------------
    def _note_data_received(self) -> None:
        now = time.time()
        with self._state_lock:
            self._last_data_ts = now

    # ------------------------------------------------------------------
    @staticmethod
    def _coerce_bytesize(value: str | None) -> int:
        if not value:
            return serial.EIGHTBITS
        value = value.strip()
        mapping = {
            "5": serial.FIVEBITS,
            "6": serial.SIXBITS,
            "7": serial.SEVENBITS,
            "8": serial.EIGHTBITS,
        }
        return mapping.get(value, serial.EIGHTBITS)

    @staticmethod
    def _coerce_parity(value: str | None) -> str:
        if not value:
            return serial.PARITY_NONE
        value = value.strip().lower()
        mapping = {
            "n": serial.PARITY_NONE,
            "none": serial.PARITY_NONE,
            "e": serial.PARITY_EVEN,
            "even": serial.PARITY_EVEN,
            "o": serial.PARITY_ODD,
            "odd": serial.PARITY_ODD,
            "m": serial.PARITY_MARK,
            "mark": serial.PARITY_MARK,
            "s": serial.PARITY_SPACE,
            "space": serial.PARITY_SPACE,
        }
        return mapping.get(value, serial.PARITY_NONE)

    @staticmethod
    def _coerce_stopbits(value: str | None) -> float:
        if not value:
            return serial.STOPBITS_ONE
        value = value.strip().lower()
        mapping = {
            "1": serial.STOPBITS_ONE,
            "1.5": serial.STOPBITS_ONE_POINT_FIVE,
            "1.5bits": serial.STOPBITS_ONE_POINT_FIVE,
            "2": serial.STOPBITS_TWO,
        }
        return mapping.get(value, serial.STOPBITS_ONE)

    @staticmethod
    def _coerce_terminator(value: str) -> bytes:
        decoded = value.encode("utf-8", errors="ignore").decode("unicode_escape")
        if not decoded:
            decoded = "\r"
        return decoded.encode("utf-8", errors="ignore")
