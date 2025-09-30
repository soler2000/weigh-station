"""Scale reader for Brecknell B140 over RS-232."""
import os
import re
import threading
import time
from collections import deque
from statistics import median, pstdev

import serial


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
    _NUMBER_RE = re.compile(r"[-+]?\d+(?:\.\d+)?")

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
        self.native_counts_per_gram = (
            native_counts_per_gram or _env_float("SCALE_NATIVE_COUNTS_PER_GRAM", 1000.0)
        )

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
                line = self._serial.readline()
                if not line:
                    continue
                try:
                    text = line.decode("ascii", errors="ignore").strip()
                except Exception:
                    continue
                if not text:
                    continue
                parsed = self._parse_line(text)
                if parsed is None:
                    continue
                _, raw_counts, stable_hint = parsed
                self._update(raw_counts, stable_hint)
            except serial.SerialException:
                self._reset_serial()
                time.sleep(backoff)
                backoff = min(backoff * 2.0, 10.0)
            except Exception:
                # Skip malformed frames, but keep running.
                continue

    def _ensure_serial(self) -> bool:
        with self._serial_lock:
            if self._serial and self._serial.is_open:
                return True
            try:
                self._serial = serial.Serial(
                    self.serial_port,
                    baudrate=self.baudrate,
                    timeout=0.5,
                )
                self._serial.reset_input_buffer()
                return True
            except serial.SerialException:
                self._serial = None
                return False

    def _reset_serial(self) -> None:
        with self._serial_lock:
            if self._serial:
                try:
                    self._serial.close()
                except Exception:
                    pass
            self._serial = None

    # ------------------------------------------------------------------
    def _parse_line(self, text: str) -> tuple[float, int, bool | None] | None:
        """Return (grams, raw_counts, stable_hint) if line parsed; else None."""
        tokens = [tok.strip().upper() for tok in self._LINE_SPLIT_RE.split(text) if tok.strip()]
        if not tokens:
            return None

        stable_hint: bool | None = None
        for tok in tokens:
            if tok in {"US", "UN", "UNSTABLE"}:
                stable_hint = False
                break
            if tok in {"ST", "STABLE"}:
                stable_hint = True

        match = self._NUMBER_RE.search(text.replace(" ", ""))
        if not match:
            return None
        try:
            value = float(match.group())
        except ValueError:
            return None

        lower = text.lower()
        if "kg" in lower:
            grams = value * 1000.0
        elif "lb" in lower:
            grams = value * 453.59237
        elif "oz" in lower:
            grams = value * 28.349523125
        else:
            grams = value

        raw_counts = int(round(grams * self.native_counts_per_gram))
        return grams, raw_counts, stable_hint

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
