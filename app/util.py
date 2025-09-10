from typing import Iterable
from statistics import median, pstdev

def median_of(values: Iterable[float]) -> float:
    data = list(values)
    return median(data) if data else 0.0

def stdev_of(values: Iterable[float]) -> float:
    data = list(values)
    return pstdev(data) if len(data) >= 2 else float("inf")