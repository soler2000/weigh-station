from datetime import datetime
from typing import Optional

from sqlalchemy import String, Integer, Float, Boolean, ForeignKey, DateTime
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

class Base(DeclarativeBase):
    pass

class Variant(Base):
    __tablename__ = "variants"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    min_g: Mapped[float] = mapped_column(Float)   # grams
    max_g: Mapped[float] = mapped_column(Float)   # grams
    unit: Mapped[str] = mapped_column(String(8), default="g")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)

class Calibration(Base):
    __tablename__ = "calibration"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    zero_offset: Mapped[int] = mapped_column(Integer)   # raw counts
    scale_factor: Mapped[float] = mapped_column(Float)  # counts per gram
    notes: Mapped[Optional[str]] = mapped_column(String(200))

class WeighEvent(Base):
    __tablename__ = "weigh_events"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    variant_id: Mapped[int] = mapped_column(ForeignKey("variants.id"))
    serial: Mapped[str] = mapped_column(String(64))
    gross_g: Mapped[float] = mapped_column(Float)
    net_g: Mapped[float] = mapped_column(Float)
    in_range: Mapped[bool] = mapped_column(Boolean)
    raw_avg: Mapped[int] = mapped_column(Integer)

    variant: Mapped[Variant] = relationship()