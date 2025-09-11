# app/hx711_reader.py
import os, threading, time
from collections import deque
from statistics import median, pstdev

import board, digitalio

# NOTE: Temp compensation skipped for MVP. TODO: add DS18B20 support later if needed.

def _get_pin(name: str):
    """Accepts 'D17','GPIO17' etc, returns board pin object."""
    name = (name or "").upper()
    if hasattr(board, name):
        return getattr(board, name)
    if name.startswith("GPIO") and hasattr(board, "D"+name[4:]):
        return getattr(board, "D"+name[4:])
    raise ValueError(f"Unknown pin name: {name}")

class _HX711BitBang:
    """
    Minimal, robust HX711 reader (Channel A @ Gain 128).
    Uses digitalio directly; no external HX711 libs.
    """
    def __init__(self, data_pin_name: str, clock_pin_name: str):
        dp = digitalio.DigitalInOut(_get_pin(data_pin_name))
        cp = digitalio.DigitalInOut(_get_pin(clock_pin_name))
        dp.direction = digitalio.Direction.INPUT
        cp.direction = digitalio.Direction.OUTPUT
        cp.value = False  # idle low
        self.dp, self.cp = dp, cp

    def _ready(self, timeout: float = 1.0) -> bool:
        t0 = time.time()
        # DOUT goes LOW when ready
        while time.time() - t0 < timeout:
            if not self.dp.value:
                return True
            time.sleep(0.0005)
        return False

    def read_raw(self) -> int:
        """Read signed 24-bit value from Channel A, Gain 128."""
        if not self._ready(1.0):
            # Return last-resort 'not ready' sentinel (None) so caller can skip
            return None
        v = 0
        # 24 data bits, MSB first
        for _ in range(24):
            self.cp.value = True
            v = (v << 1) | (1 if self.dp.value else 0)
            self.cp.value = False
        # 1 extra pulse -> set Channel A, Gain 128 for next conversion
        self.cp.value = True
        self.cp.value = False
        # Sign-extend 24-bit two's complement
        if v & (1 << 23):
            v -= (1 << 24)
        return v

    def read_avg(self, n: int = 3) -> int | None:
        """Average N reads; skips if ADC not ready."""
        total = 0
        count = 0
        for _ in range(n):
            r = self.read_raw()
            if r is None:
                continue
            total += r; count += 1
            time.sleep(0.005)
        return (total // count) if count else None

class ScaleReader:
    """
    Threaded reader with median+EMA filtering & stability detection.
    Auto-tare on idle; calibration with sign auto-fix (always show positive grams).
    """
    def __init__(self, alpha=0.2, window=10, display_precision=0.1,
                 auto_tare=True, auto_tare_idle_secs=30, auto_tare_threshold_g=0.1):
        data_pin_name  = os.getenv("DATA_PIN",  "D17")  # match your working pins
        clock_pin_name = os.getenv("CLOCK_PIN", "D27")

        self.adc = _HX711BitBang(data_pin_name, clock_pin_name)

        self.alpha = alpha
        self.window = deque(maxlen=window)  # ~1s if hz≈10
        self.ema = None

        # Calibration (we store sign separately so displayed grams are positive)
        self.zero_offset = 0       # raw counts at zero
        self.scale_factor = 1.0    # counts per gram (absolute)
        self.scale_sign = 1        # +1 or -1

        self.display_precision = display_precision
        self.auto_tare_enabled = auto_tare
        self.auto_tare_idle_secs = auto_tare_idle_secs
        self.auto_tare_threshold_g = auto_tare_threshold_g
        self._idle_start_ts = time.time()

        self.running = False
        self.lock = threading.Lock()
        self.latest = dict(g=0.0, stable=False, raw=0)

    def set_calibration(self, zero_offset: int, scale_factor: float):
        # Store sign & absolute to ensure positive grams on screen
        self.zero_offset = int(zero_offset)
        self.scale_sign = 1 if scale_factor >= 0 else -1
        self.scale_factor = float(abs(scale_factor) if abs(scale_factor) > 1e-9 else 1.0)

    def start(self, hz=10):
        if self.running: return
        self.running = True
        threading.Thread(target=self._loop, args=(hz,), daemon=True).start()

    def stop(self):
        self.running = False

    def _maybe_auto_tare(self, g_now: float, raw_now: int):
        if not self.auto_tare_enabled:
            return
        if abs(g_now) < self.auto_tare_threshold_g:
            if time.time() - self._idle_start_ts >= self.auto_tare_idle_secs:
                # Gentle offset correction (bounded)
                error_counts = raw_now - self.zero_offset
                step = max(-5, min(5, error_counts))
                self.zero_offset += step
                self._idle_start_ts = time.time()
        else:
            self._idle_start_ts = time.time()

    def _loop(self, hz: int):
        period = 1.0 / float(hz)
        # Prime the filters
        for _ in range(max(3, self.window.maxlen // 2)):
            raw = self.adc.read_avg(2)
            if raw is not None:
                self._update(raw)
            time.sleep(period)
        # Main loop
        while self.running:
            raw = self.adc.read_avg(2)
            if raw is not None:
                self._update(raw)
            time.sleep(period)

    def _update(self, raw: int):
        # Convert counts -> grams, forcing positive grams using scale_sign
        grams = self.scale_sign * (raw - self.zero_offset) / self.scale_factor

        # median-of-window prefilter
        self.window.append(grams)
        med = median(self.window) if self.window else grams
        # EMA
        self.ema = med if self.ema is None else (self.alpha * med + (1 - self.alpha) * self.ema)
        # stability over window
        stable = (len(self.window) >= max(5, self.window.maxlen // 2) and pstdev(self.window) < 0.05)

        # optional idle auto-tare
        self._maybe_auto_tare(self.ema, raw)

        with self.lock:
            self.latest = dict(
                g=round(self.ema, 1),  # 0.1 g display
                stable=stable,
                raw=int(raw)
            )

    def read_latest(self) -> dict:
        with self.lock:
            return dict(self.latest)

    # helpers for calibration endpoints
    def read_raw_avg(self, n=12) -> int:
        r = self.adc.read_avg(n)
        if r is None:
            # not ready; try once more lightly
            r = self.adc.read_avg(max(3, n//2))
        if r is None:
            # last resort
            return 0
        return int(r)