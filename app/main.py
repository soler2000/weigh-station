import asyncio, csv, io, os
from typing import List, Optional, Set
from pathlib import Path
from datetime import date, datetime, timedelta, time
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query, Request, Path as FPath
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import create_engine, select, func, case
from sqlalchemy.orm import sessionmaker
from app.models import Base, Variant, Calibration, WeighEvent
from app.hx711_reader import ScaleReader, ADCNotReadyError
from app.filters import DriftFilter  # added for drift filter
DRIFT_FILTER = DriftFilter()  # singleton drift filter
# --- Paths (absolute so systemd WorkingDirectory issues don't blank the page)
BASE_DIR = Path(__file__).resolve().parent
ROOT_DIR = BASE_DIR.parent
DATA_DIR = ROOT_DIR / "data"
STATIC_DIR = BASE_DIR / "static"
DATA_DIR.mkdir(parents=True, exist_ok=True)
# --- App & DB
engine = create_engine(f"sqlite:///{DATA_DIR}/weigh.db", future=True, connect_args={"check_same_thread": False})
Session = sessionmaker(engine, expire_on_commit=False, future=True)
Base.metadata.create_all(engine)


def _ensure_schema_migrations() -> None:
    """Perform lightweight, idempotent schema migrations for SQLite deployments."""

    required_columns = {
        "moulding_serial": "TEXT",
        "contract": "TEXT",
        "order_number": "TEXT",
        "colour": "TEXT",
        "notes": "TEXT",
    }

    with engine.begin() as conn:
        existing = {
            row[1]
            for row in conn.exec_driver_sql("PRAGMA table_info(weigh_events)").fetchall()
        }
        for column, ddl in required_columns.items():
            if column not in existing:
                conn.exec_driver_sql(
                    f"ALTER TABLE weigh_events ADD COLUMN {column} {ddl}"
                )


_ensure_schema_migrations()


app = FastAPI(title="Weigh Station")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
# --- Pydantic DTOs
class VariantIn(BaseModel):
    name: str = Field(..., max_length=64)
    min_g: float
    max_g: float
    unit: str = "g"
    enabled: bool = True
class VariantOut(VariantIn):
    id: int
class WeighEventOut(BaseModel):
    id: int
    ts: str
    variant_id: int
    moulding_serial: Optional[str] = None
    serial: str
    contract: Optional[str] = None
    order_number: Optional[str] = None
    operator: Optional[str] = None
    colour: Optional[str] = None
    notes: Optional[str] = None
    gross_g: float
    net_g: float
    in_range: bool
# --- Scale reader boot
reader = ScaleReader()  # pin names via env: DATA_PIN, CLOCK_PIN
with Session() as s:
    calib = s.execute(select(Calibration).order_by(Calibration.id.desc())).scalar()
    if calib:
        reader.set_calibration(calib.zero_offset, calib.scale_factor)
    else:
        reader.set_calibration(0, 1.0)
reader.start(hz=10)
# --- Seed 4 variants if empty (placeholders; adjust in UI)
with Session() as s:
    if s.query(Variant).count() == 0:
        s.add_all([
            Variant(name="Variant A", min_g=95.0, max_g=105.0),
            Variant(name="Variant B", min_g=145.0, max_g=155.0),
            Variant(name="Variant C", min_g=48.0,  max_g=52.0),
            Variant(name="Variant D", min_g=10.0,  max_g=12.0),
        ])
        s.commit()
# --- Web pages
@app.get("/", response_class=HTMLResponse)
def index():
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8")
@app.get("/settings", response_class=HTMLResponse)
def settings():
    return (STATIC_DIR / "settings.html").read_text(encoding="utf-8")

@app.get("/production", response_class=HTMLResponse)
def production_output_page():
    return (STATIC_DIR / "production.html").read_text(encoding="utf-8")

@app.get("/export", response_class=HTMLResponse)
def export_page():
    return (STATIC_DIR / "export.html").read_text(encoding="utf-8")


@app.get("/serial-log", response_class=HTMLResponse)
def serial_log_page():
    return (STATIC_DIR / "serial-log.html").read_text(encoding="utf-8")
# --- Variant CRUD
@app.get("/api/variants", response_model=List[VariantOut])
def list_variants():
    with Session() as s:
        vs = s.query(Variant).order_by(Variant.id.asc()).all()
        return [VariantOut(id=v.id, name=v.name, min_g=v.min_g, max_g=v.max_g, unit=v.unit, enabled=v.enabled) for v in vs]
@app.post("/api/variants", response_model=VariantOut)
def create_variant(v: VariantIn):
    with Session() as s:
        row = Variant(name=v.name, min_g=v.min_g, max_g=v.max_g, unit=v.unit, enabled=v.enabled)
        s.add(row); s.commit(); s.refresh(row)
        return VariantOut(id=row.id, **v.model_dump())
@app.put("/api/variants/{variant_id}", response_model=VariantOut)
def update_variant(variant_id: int = FPath(..., ge=1), v: VariantIn = ...):
    with Session() as s:
        row = s.get(Variant, variant_id)
        if not row: raise HTTPException(404, "Variant not found")
        for k, val in v.model_dump().items(): setattr(row, k, val)
        s.commit(); s.refresh(row)
        return VariantOut(id=row.id, name=row.name, min_g=row.min_g, max_g=row.max_g, unit=row.unit, enabled=row.enabled)
@app.delete("/api/variants/{variant_id}")
def delete_variant(variant_id: int = FPath(..., ge=1)):
    with Session() as s:
        row = s.get(Variant, variant_id)
        if not row: raise HTTPException(404, "Variant not found")
        s.delete(row); s.commit()
    return {"ok": True}
# --- Calibration
@app.post("/api/calibrate/tare")
def tare():
    try:
        raw = reader.read_raw_avg(12)
    except ADCNotReadyError as exc:
        raise HTTPException(503, "Scale is busy; please try again.") from exc
    calib = reader.get_calibration()
    signed_scale = calib["scale_factor"] * calib.get("scale_sign", 1)
    with Session() as s:
        c = Calibration(zero_offset=raw, scale_factor=signed_scale, notes="tare")
        s.add(c); s.commit()
    reader.set_calibration(raw, signed_scale)
    return {"zero_offset": raw}
@app.post("/api/calibrate/with-known")
def calibrate_with_known(known_g: float = Query(..., gt=0.0)):
    try:
        raw = reader.read_raw_avg(12)
    except ADCNotReadyError as exc:
        raise HTTPException(503, "Scale is busy; please try again.") from exc
    calib = reader.get_calibration()
    counts = raw - calib["zero_offset"]
    if abs(counts) < 10:
        raise HTTPException(400, "Detected weight change is too small; place the known mass on the platform before calibrating.")
    k = counts / known_g  # counts per gram
    with Session() as s:
        c = Calibration(zero_offset=calib["zero_offset"], scale_factor=k, notes=f"M={known_g}g")
        s.add(c); s.commit()
    reader.set_calibration(calib["zero_offset"], k)
    return {"scale_factor": k}
# --- Live weight over WebSocket
@app.websocket("/ws/weight")
async def ws_weight(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            await asyncio.sleep(0.1)  # ~10 Hz UI refresh
            await ws.send_json(reader.read_latest())
    except WebSocketDisconnect:
        pass
    except Exception:
        await ws.close()
# --- Commit a weighing (now enforces non-blank + unique serial)
@app.post("/api/weigh/commit", response_model=WeighEventOut)
def commit(
    variant_id: int,
    serial: str = Query(...),
    operator: Optional[str] = Query(default=None),
    moulding_serial: Optional[str] = Query(default=None),
    contract: Optional[str] = Query(default=None),
    order_number: Optional[str] = Query(default=None),
    colour: Optional[str] = Query(default=None),
    notes: Optional[str] = Query(default=None),
):
    serial = (serial or "").strip()
    if not serial:
        raise HTTPException(400, "Serial cannot be blank.")
    operator_clean = (operator or "").strip() or None

    def _clean(value: Optional[str], *, preserve_newlines: bool = False) -> Optional[str]:
        if value is None:
            return None
        if preserve_newlines:
            cleaned = value.strip()
        else:
            cleaned = value.strip()
        return cleaned or None

    moulding_clean = _clean(moulding_serial)
    contract_clean = _clean(contract)
    order_clean = _clean(order_number)
    colour_clean = _clean(colour)
    notes_clean = _clean(notes, preserve_newlines=True)
    with Session() as s:
        # Enforce global uniqueness of serial across all variants
        dup = s.query(WeighEvent).filter(WeighEvent.serial == serial).first()
        if dup:
            raise HTTPException(409, "Serial already used.")
        v = s.get(Variant, variant_id)
        if not v:
            raise HTTPException(404, "Variant not found")
        latest = reader.read_latest()
        g = float(latest.get("g", 0.0))
        in_range = (v.min_g <= g <= v.max_g)
        net_g = float(DRIFT_FILTER.update(g))
        raw_avg = int(latest.get("raw", 0))
        evt = WeighEvent(
            variant_id=variant_id,
            moulding_serial=moulding_clean,
            serial=serial,
            contract=contract_clean,
            order_number=order_clean,
            operator=operator_clean,
            colour=colour_clean,
            notes=notes_clean,
            gross_g=g,
            net_g=net_g,
            in_range=in_range,
            raw_avg=raw_avg,
        )
        s.add(evt); s.commit(); s.refresh(evt)
        return WeighEventOut(
            id=evt.id,
            ts=evt.ts.isoformat(),
            variant_id=evt.variant_id,
            moulding_serial=evt.moulding_serial,
            serial=evt.serial,
            contract=evt.contract,
            order_number=evt.order_number,
            operator=evt.operator,
            colour=evt.colour,
            notes=evt.notes,
            gross_g=evt.gross_g,
            net_g=evt.net_g,
            in_range=evt.in_range,
        )
# --- Stats (pass/fail counters, optional by variant)
@app.get("/api/stats")
def stats(
    variant_id: Optional[int] = None,
    moulding_serial: Optional[str] = Query(default=None),
):
    today = datetime.utcnow().date()
    start_dt = datetime.combine(today, time.min)
    end_dt = start_dt + timedelta(days=1)
    pass_case = func.sum(case((WeighEvent.in_range.is_(True), 1), else_=0))
    fail_case = func.sum(case((WeighEvent.in_range.is_(False), 1), else_=0))
    with Session() as s:
        filters = [WeighEvent.ts >= start_dt, WeighEvent.ts < end_dt]
        if variant_id:
            filters.append(WeighEvent.variant_id == variant_id)
        serial_filter = (moulding_serial or "").strip()
        if serial_filter:
            filters.append(WeighEvent.moulding_serial == serial_filter)
        row = (
            s.query(
                pass_case.label("pass_count"),
                fail_case.label("fail_count"),
            )
            .filter(*filters)
            .one()
        )
        pass_count = int(row.pass_count or 0)
        fail_count = int(row.fail_count or 0)
        return {"pass": pass_count, "fail": fail_count, "total": pass_count + fail_count}

@app.get("/api/operators", response_model=List[str])
def list_operators():
    with Session() as s:
        rows = (
            s.query(WeighEvent.operator)
            .filter(WeighEvent.operator.isnot(None), WeighEvent.operator != "")
            .distinct()
            .order_by(WeighEvent.operator.asc())
            .all()
        )
    cleaned: List[str] = []
    seen: Set[str] = set()
    for row in rows:
        name = (row[0] or "").strip()
        if name and name not in seen:
            seen.add(name)
            cleaned.append(name)
    return cleaned

@app.get("/api/production/output")
def production_output(
    interval: str = Query("day", pattern="^(day|hour)$"),
    start: Optional[str] = Query(None, description="Start date (YYYY-MM-DD)"),
    end: Optional[str] = Query(None, description="End date (YYYY-MM-DD)"),
    variant_id: Optional[int] = Query(None, ge=1),
):
    interval = (interval or "day").lower()
    if interval not in {"day", "hour"}:
        raise HTTPException(400, "interval must be 'day' or 'hour'")

    def parse_iso_date(value: Optional[str], label: str):
        if value in (None, ""):
            return None
        try:
            return datetime.strptime(value, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(400, f"{label} must be YYYY-MM-DD")

    start_date = parse_iso_date(start, "start")
    end_date = parse_iso_date(end, "end")
    today = datetime.utcnow().date()
    if end_date is None:
        end_date = today
    if start_date is None:
        start_date = end_date - timedelta(days=6)
    if start_date > end_date:
        raise HTTPException(400, "start must be on or before end")

    start_dt = datetime.combine(start_date, time.min)
    end_dt = datetime.combine(end_date + timedelta(days=1), time.min)

    bucket_labels: List[str] = []
    if interval == "day":
        max_days = 180
        day_count = (end_date - start_date).days + 1
        if day_count > max_days:
            raise HTTPException(400, f"Date range too large for daily view (max {max_days} days).")
        current = start_date
        while current <= end_date:
            bucket_labels.append(current.isoformat())
            current += timedelta(days=1)
        bucket_format = "%Y-%m-%d"
    else:
        max_hours = 31 * 24  # ~1 month of hourly buckets
        total_hours = int((end_dt - start_dt).total_seconds() // 3600)
        if total_hours > max_hours:
            raise HTTPException(400, f"Date range too large for hourly view (max {max_hours} hours).")
        current_dt = start_dt
        bucket_format = "%Y-%m-%d %H:00"
        while current_dt < end_dt:
            bucket_labels.append(current_dt.strftime(bucket_format))
            current_dt += timedelta(hours=1)

    bucket_col = func.strftime(bucket_format, WeighEvent.ts)
    pass_sum = func.sum(case((WeighEvent.in_range.is_(True), 1), else_=0))
    fail_sum = func.sum(case((WeighEvent.in_range.is_(False), 1), else_=0))

    with Session() as s:
        variant_meta = None
        if variant_id is not None:
            variant = s.get(Variant, int(variant_id))
            if not variant:
                raise HTTPException(404, "Variant not found")
            variant_meta = {"id": variant.id, "name": variant.name}

        q = s.query(
            bucket_col.label("bucket"),
            pass_sum.label("pass_count"),
            fail_sum.label("fail_count"),
        ).filter(WeighEvent.ts >= start_dt, WeighEvent.ts < end_dt)

        if variant_id is not None:
            q = q.filter(WeighEvent.variant_id == variant_id)

        rows = q.group_by(bucket_col).order_by(bucket_col).all()

    bucket_map = {row.bucket: row for row in rows}
    data = []
    total_pass = 0
    total_fail = 0
    for label in bucket_labels:
        row = bucket_map.get(label)
        p = int(row.pass_count) if row and row.pass_count is not None else 0
        f = int(row.fail_count) if row and row.fail_count is not None else 0
        data.append({"label": label, "pass": p, "fail": f})
        total_pass += p
        total_fail += f

    return {
        "interval": interval,
        "start": start_date.isoformat(),
        "end": end_date.isoformat(),
        "bucket_count": len(bucket_labels),
        "variant": variant_meta,
        "buckets": data,
        "totals": {
            "pass": total_pass,
            "fail": total_fail,
            "total": total_pass + total_fail,
        },
    }
# --- CSV export
@app.get("/export.csv")
def export_csv(
    request: Request,
    frm: Optional[str] = Query(default=None, alias="from"),
    to: Optional[str] = None,
    variant: Optional[int] = None,
    operator: Optional[str] = None,
):
    # Minimal filtering; extend as needed
    frm = frm or request.query_params.get("frm")
    operator = (operator or "").strip() or None

    def parse_dt(value: Optional[str], is_start: bool) -> Optional[datetime]:
        if not value:
            return None
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            try:
                d = date.fromisoformat(value)
            except ValueError:
                raise HTTPException(400, "Invalid date format. Use YYYY-MM-DD or ISO 8601 timestamps.")
            return datetime.combine(d, time.min if is_start else time.max)

    start_dt = parse_dt(frm, True)
    end_dt = parse_dt(to, False)
    if start_dt and end_dt and end_dt < start_dt:
        raise HTTPException(400, '"to" must be on or after "from".')
    output = io.StringIO()
    w = csv.writer(output)
    w.writerow(
        [
            "ts",
            "variant_id",
            "moulding_serial",
            "serial",
            "contract",
            "order_number",
            "operator",
            "colour",
            "notes",
            "gross_g",
            "net_g",
            "in_range",
            "raw_avg",
        ]
    )
    with Session() as s:
        q = s.query(WeighEvent)
        if variant: q = q.filter(WeighEvent.variant_id == variant)
        if operator: q = q.filter(WeighEvent.operator == operator)
        if start_dt: q = q.filter(WeighEvent.ts >= start_dt)
        if end_dt: q = q.filter(WeighEvent.ts <= end_dt)
        for r in q.order_by(WeighEvent.ts.asc()).all():
            w.writerow(
                [
                    r.ts.isoformat(),
                    r.variant_id,
                    r.moulding_serial or "",
                    r.serial,
                    r.contract or "",
                    r.order_number or "",
                    r.operator or "",
                    r.colour or "",
                    (r.notes or "").replace("\r", " ").replace("\n", " "),
                    r.gross_g,
                    r.net_g,
                    r.in_range,
                    r.raw_avg,
                ]
            )
    output.seek(0)
    return StreamingResponse(output, media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=weigh_export.csv"})
# Debug: latest reading (for polling fallback / quick checks)
@app.get("/api/debug/latest")
def debug_latest():
    return reader.read_latest()


@app.get("/api/scale/serial-log")
def api_serial_log(limit: int = Query(200, ge=1, le=2000)):
    return {"lines": reader.get_serial_log(limit=limit)}
# --- Health
@app.get("/api/health")
def health():
    return {"status": "ok"}
# --- Admin: delete data (use with care)
@app.post("/api/admin/delete-events")
def delete_all_events(confirm: str = Query(..., description='Type "DELETE" to confirm')):
    if confirm != "DELETE":
        raise HTTPException(400, 'Confirmation failed. Pass ?confirm=DELETE to proceed.')
    with Session() as s:
        s.query(WeighEvent).delete()
        s.commit()
    return {"ok": True, "deleted": "weigh_events"}
@app.post("/api/admin/factory-reset")
def factory_reset(confirm: str = Query(..., description='Type "RESET" to confirm')):
    if confirm != "RESET":
        raise HTTPException(400, 'Confirmation failed. Pass ?confirm=RESET to proceed.')
    with Session() as s:
        s.query(WeighEvent).delete()
        s.query(Calibration).delete()
        s.query(Variant).delete()
        s.commit()
        # Reseed 4 defaults so the UI has something to select
        s.add_all([
            Variant(name="Variant A", min_g=95.0, max_g=105.0),
            Variant(name="Variant B", min_g=145.0, max_g=155.0),
            Variant(name="Variant C", min_g=48.0,  max_g=52.0),
            Variant(name="Variant D", min_g=10.0,  max_g=12.0),
        ])
        s.commit()
    return {"ok": True, "reset": True}
# --- Stats Page
@app.get("/stats", response_class=HTMLResponse)
def stats_page():
    return (STATIC_DIR / "stats.html").read_text(encoding="utf-8")
# --- Stats summary (histogram + Cp/Cpk etc.)
from statistics import mean, stdev
from math import erf, sqrt
def _ncdf(x: float) -> float:
    # standard normal CDF
    return 0.5 * (1.0 + erf(x / sqrt(2.0)))
@app.get("/api/stats/summary")
def stats_summary(
    variant_id: int,
    bins: int = 20,
    frm: Optional[str] = None,
    to: Optional[str] = None,
    moulding_serial: Optional[str] = None,
):
    # fetch variant & measurements
    with Session() as s:
        v = s.get(Variant, variant_id)
        if not v:
            raise HTTPException(404, "Variant not found")
        q = s.query(WeighEvent).filter(WeighEvent.variant_id == variant_id)
        serial_filter = (moulding_serial or "").strip()
        if serial_filter:
            q = q.filter(WeighEvent.moulding_serial == serial_filter)
        # (MVP) frm/to are placeholders; extend to parse ISO dates if needed
        rows = q.order_by(WeighEvent.ts.asc()).all()
        xs = [r.net_g for r in rows]
        n = len(xs)
        passes = sum(1 for r in rows if r.in_range)
        fails  = n - passes
        # base stats
        mu = float(mean(xs)) if n else 0.0
        sigma = float(stdev(xs)) if n >= 2 else 0.0  # overall (sample) stdev
        lsl, usl = float(v.min_g), float(v.max_g)
        cp = (usl - lsl) / (6.0 * sigma) if sigma > 0 else None
        z_low  = (mu - lsl) / sigma if sigma > 0 else None
        z_high = (usl - mu) / sigma if sigma > 0 else None
        cpk = min(z_low, z_high) / 3.0 if (z_low is not None and z_high is not None) else None
        ppm_l = _ncdf((lsl - mu) / sigma) * 1e6 if sigma > 0 else None
        ppm_u = (1.0 - _ncdf((usl - mu) / sigma)) * 1e6 if sigma > 0 else None
        ppm_total = (ppm_l or 0.0) + (ppm_u or 0.0) if sigma > 0 else None
        # histogram
        if n:
            xmin = min(xs); xmax = max(xs)
            if xmin == xmax:  # widen trivial range a bit
                xmin -= 0.5; xmax += 0.5
            b = max(3, min(100, int(bins)))
            width = (xmax - xmin) / b
            edges = [xmin + i * width for i in range(b + 1)]
            counts = [0] * b
            for x in xs:
                idx = int((x - xmin) / width)
                if idx == b: idx = b - 1
                counts[idx] += 1
        else:
            edges, counts = [], []
        return {
            "variant": {"id": v.id, "name": v.name, "lsl": lsl, "usl": usl, "unit": v.unit},
            "n": n, "pass": passes, "fail": fails,
            "mean": mu, "stdev": sigma,
            "cp": cp, "cpk": cpk,
            "z_low": z_low, "z_high": z_high,
            "ppm_lower": ppm_l, "ppm_upper": ppm_u, "ppm_total": ppm_total,
            "hist": {"edges": edges, "counts": counts}
        }
# ---------- Distribution + Cp/Cpk ----------
from math import sqrt, floor, ceil
def _parse_day(d: str) -> datetime:
    return datetime.strptime(d, "%Y-%m-%d")
@app.get("/api/stats/distribution")
def stats_distribution(
    variant_id: int | None = Query(None),
    frm: str | None = Query(None),
    to: str | None = Query(None),
    moulding_serial: str | None = Query(None),
    bins: int = Query(20, ge=5, le=200),
):
    # Need a single variant for Cp/Cpk (LSL/USL)
    if not variant_id:
        raise HTTPException(400, "variant_id is required for Cp/Cpk")
    with Session() as s:
        v = s.get(Variant, int(variant_id))
        if not v:
            raise HTTPException(404, "Variant not found")
        q = s.query(WeighEvent).filter(WeighEvent.variant_id == int(variant_id))
        if frm:
            q = q.filter(WeighEvent.ts >= _parse_day(frm))
        if to:
            q = q.filter(WeighEvent.ts < (_parse_day(to) + timedelta(days=1)))
        serial_filter = (moulding_serial or "").strip()
        if serial_filter:
            q = q.filter(WeighEvent.moulding_serial == serial_filter)
        rows = q.order_by(WeighEvent.ts.asc()).all()
        vals = [float(r.net_g) for r in rows]
        n = len(vals)
        if n == 0:
            return {
                "count": 0, "mean": None, "stdev": None, "min": None, "max": None,
                "lsl": float(v.min_g), "usl": float(v.max_g),
                "cp": None, "cpk": None,
                "pass": 0, "fail": 0, "yield": None,
                "bins": {"edges": [], "counts": []},
                "control": {"series": [], "center": None, "ucl": None, "lcl": None},
                "unit": v.unit,
            }
        # basic stats
        s1 = sum(vals)
        mean = s1 / n
        s2 = sum((x - mean) ** 2 for x in vals)
        stdev = sqrt(s2 / (n - 1)) if n > 1 else 0.0
        lo = min(vals); hi = max(vals)
        if lo == hi:  # widen a touch so we can draw a bar
            lo -= 0.5; hi += 0.5
        # histogram
        edges = [lo + (hi - lo) * i / bins for i in range(bins + 1)]
        counts = [0] * bins
        for x in vals:
            # last edge goes to last bin
            idx = min(bins - 1, max(0, int((x - lo) / (hi - lo) * bins)))
            counts[idx] += 1
        lsl = float(v.min_g)
        usl = float(v.max_g)
        passed = sum(1 for x in vals if (lsl <= x <= usl))
        failed = n - passed
        yld = (passed / n) if n else None
        # capability
        if stdev and stdev > 0:
            cp = (usl - lsl) / (6.0 * stdev)
            cpu = (usl - mean) / (3.0 * stdev)
            cpl = (mean - lsl) / (3.0 * stdev)
            cpk = min(cpu, cpl)
        else:
            cp = None; cpk = None
        if stdev and stdev > 0:
            ucl = mean + 3.0 * stdev
            lcl = mean - 3.0 * stdev
        else:
            ucl = mean
            lcl = mean
        def rd(x, d=4):
            return None if x is None else (round(x, d))
        def _control_value(row: WeighEvent) -> float | None:
            if row.net_g is not None:
                return rd(float(row.net_g), 4)
            if row.gross_g is not None:
                return rd(float(row.gross_g), 4)
            return None

        control_series = [
            {
                "ts": r.ts.isoformat(),
                "value": _control_value(r),
            }
            for r in rows
        ]
        return {
            "count": n, "mean": rd(mean,4), "stdev": rd(stdev,4),
            "min": rd(min(vals),4), "max": rd(max(vals),4),
            "lsl": rd(lsl,4), "usl": rd(usl,4),
            "cp": rd(cp,3), "cpk": rd(cpk,3),
            "pass": passed, "fail": failed, "yield": rd(yld,4),
            "bins": {"edges": [round(e,4) for e in edges], "counts": counts},
            "control": {
                "series": control_series,
                "center": rd(mean, 4),
                "ucl": rd(ucl, 4),
                "lcl": rd(lcl, 4),
            },
            "unit": v.unit,
        }
