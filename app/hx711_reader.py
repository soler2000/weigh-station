import os, threading, time
from collections import deque
from statistics import median, pstdev

import board, digitalio
from adafruit_hx711.hx711 import HX711
from adafruit_hx711.analog_in import AnalogIn

# NOTE: Temp compensation skipped for MVP. TODO: add DS18B20 support later if needed.

def _get_pin(name: str):
    """
    Convert a string like 'D5' or 'GPIO5' or 'D17' to a board pin.
    Defaults to board.D5 / board.D6 if not found.
    """
    name = name.upper()
    if hasattr(board, name):
        return getattr(board, name)
    # Common fallbacks: 'GPIO17' -> 'D17'
    if name.startswith("GPIO") and hasattr(board, "D"+name[4:]):
        return getattr(board, "D"+name[4:])
    return getattr(board, "D5")

class ScaleReader:
    """
    Reads a single HX711 (A/128) connected to a 4-load-cell platform combined into 1 full bridge.
    Uses median-of-N + EMA filtering and stability detection.
    Designed for ~10 Hz sampling (hardware RATE=10 Hz on HX711 board).
    """
    def __init__(self, alpha=0.2, window=10, display_precision=0.1,
                 auto_tare=True, auto_tare_idle_secs=30, auto_tare_threshold_g=0.1):
        # GPIO pins via env (DATA_PIN, CLOCK_PIN), defaults D5/D6
        data_pin_name  = os.getenv("DATA_PIN",  "D5")
        clock_pin_name = os.getenv("CLOCK_PIN", "D6")
        dp = digitalio.DigitalInOut(_get_pin(data_pin_name))
        dp.direction = digitalio.Direction.INPUT
        cp = digitalio.DigitalInOut(_get_pin(clock_pin_name))
        cp.direction = digitalio.Direction.OUTPUT

        self.hx = HX711(dp, cp)
        self.chan = AnalogIn(self.hx, HX711.CHAN_A_GAIN_128)

        self.alpha = alpha
        self.window = deque(maxlen=window)  # ~1s if hz≈10
        self.ema = None
        self.zero_offset = 0
        self.scale_factor = 1.0  # counts per gram (raw/grams)
        self.display_precision = display_precision

        self.auto_tare_enabled = auto_tare
        self.auto_tare_idle_secs = auto_tare_idle_secs
        self.auto_tare_threshold_g = auto_tare_threshold_g
        self._idle_start_ts = time.time()

        self.running = False
        self.lock = threading.Lock()
        self.latest = dict(g=0.0, stable=False, raw=0)

    # --- calibration params from DB
    def set_calibration(self, zero_offset: int, scale_factor: float):
        self.zero_offset, self.scale_factor = zero_offset, scale_factor

    # --- sampling thread
    def start(self, hz=10):
        if self.running: return
        self.running = True
        threading.Thread(target=self._loop, args=(hz,), daemon=True).start()

    def stop(self):
        self.running = False

    def _raw_read(self) -> int:
        """Return a single raw reading from HX711 channel A (counts)."""
        return int(self.chan.value)

    def _maybe_auto_tare(self, g_now: float, raw_now: int):
        """Gently nudge zero_offset during long idle near zero to counter drift."""
        if not self.auto_tare_enabled:
            return
        if abs(g_now) < self.auto_tare_threshold_g:
            # near zero -> count idle time
            if time.time() - self._idle_start_ts >= self.auto_tare_idle_secs:
                # compute the raw expected by current ema around zero; adjust by a tiny step
                # Small correction step in counts (bounded)
                error_counts = raw_now - self.zero_offset
                step = max(-5, min(5, error_counts))  # up to 5 counts per correction
                self.zero_offset += step
                # reset idle timer to avoid constant adjustments
                self._idle_start_ts = time.time()
        else:
            # not idle/zero: reset
            self._idle_start_ts = time.time()

    def _loop(self, hz: int):
        period = 1.0 / float(hz)
        # prime the filter with a few samples
        for _ in range(3):
            self._update(self._raw_read())
            time.sleep(period)
        # main loop
        while self.running:
            raw = self._raw_read()
            self._update(raw)
            time.sleep(period)

    def _update(self, raw: int):
        # convert counts -> grams
        x = (raw - self.zero_offset) / self.scale_factor
        # median prefilter over deque
        self.window.append(x)
        med = median(self.window) if self.window else x
        # EMA
        self.ema = med if self.ema is None else (self.alpha * med + (1 - self.alpha) * self.ema)
        # stability (stddev of window)
        stable = (len(self.window) >= max(5, self.window.maxlen // 2) and pstdev(self.window) < 0.05)  # 0.05 g

        # optional idle auto-tare
        self._maybe_auto_tare(self.ema, raw)

        with self.lock:
            self.latest = dict(
                g=round(self.ema, 1),  # display at 0.1 g for 0–200 g range
                stable=stable,
                raw=raw
            )

    def read_latest(self) -> dict:
        with self.lock:
            return dict(self.latest)

    # helpers for calibration endpoints
    def read_raw_avg(self, n=12) -> int:
        total = 0
        for _ in range(n):
            total += self._raw_read()
            time.sleep(0.02)
        return total // n