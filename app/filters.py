import os
from collections import deque
from statistics import median

BYPASS = os.getenv("DRIFT_FILTER_BYPASS","0") == "1"

class DriftFilter:
    def __init__(self, median_n=5, ema_alpha=0.12, zero_gate_g=3.0, zero_var_g=0.8,
                 zero_rate_gps=0.05, sample_hz=10):
        if BYPASS:
            return
        if median_n % 2 == 0: median_n += 1
        self.buf = deque(maxlen=median_n)
        self.ema = None
        self.alpha = ema_alpha
        self.zero_gate = float(zero_gate_g)
        self.zero_var  = float(zero_var_g)
        self.zero_rate = float(zero_rate_gps)
        self.sample_hz = sample_hz
        self.offset = 0.0
        self.recent = deque(maxlen=max(10, int(sample_hz*1.5)))

    def update(self, g):
        if BYPASS:
            return float(g)
        g = float(g) - self.offset
        self.buf.append(g)
        m = median(self.buf)
        self.ema = m if self.ema is None else (self.alpha*m + (1.0-self.alpha)*self.ema)
        y = self.ema
        self.recent.append(y)
        if len(self.recent) >= self.recent.maxlen:
            span = max(self.recent) - min(self.recent)
            if abs(y) < self.zero_gate and span < self.zero_var:
                step = self.zero_rate * (-1.0 if y>0 else (1.0 if y<0 else 0.0))
                self.offset += step
                y -= step
        return y

    def reset(self):
        if BYPASS:
            return
        self.buf.clear(); self.ema=None; self.recent.clear(); self.offset=0.0
