import asyncio, csv, io, os
from typing import List, Optional
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query, Path as FPath
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.models import Base, Variant, Calibration, WeighEvent
from app.hx711_reader import ScaleReader

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
    serial: str
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
    raw = reader.read_raw_avg(12)
    with Session() as s:
        c = Calibration(zero_offset=raw, scale_factor=reader.scale_factor, notes="tare")
        s.add(c); s.commit()
    reader.set_calibration(raw, reader.scale_factor)
    return {"zero_offset": raw}

@app.post("/api/calibrate/with-known")
def calibrate_with_known(known_g: float = Query(..., gt=0.0)):
    raw = reader.read_raw_avg(12)
    counts = raw - reader.zero_offset
    if counts == 0:
        raise HTTPException(400, "Place the known mass on the platform before calibrating.")
    k = counts / known_g  # counts per gram
    with Session() as s:
        c = Calibration(zero_offset=reader.zero_offset, scale_factor=k, notes=f"M={known_g}g")
        s.add(c); s.commit()
    reader.set_calibration(reader.zero_offset, k)
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
def commit(variant_id: int, serial: str = Query(...)):
    serial = (serial or "").strip()
    if not serial:
        raise HTTPException(400, "Serial cannot be blank.")
    with Session() as s:
        # Enforce global uniqueness of serial across all variants
        dup = s.query(WeighEvent).filter(WeighEvent.serial == serial).first()
        if dup:
            raise HTTPException(409, "Serial already used.")
        v = s.get(Variant, variant_id)
        if not v:
            raise HTTPException(404, "Variant not found")
        latest = reader.read_latest()
        g = float(latest["g"])
        in_range = (v.min_g <= g <= v.max_g)
        evt = WeighEvent(variant_id=variant_id, serial=serial,
                         gross_g=g, net_g=g, in_range=in_range, raw_avg=int(latest["raw"]))
        s.add(evt); s.commit(); s.refresh(evt)
        return WeighEventOut(
            id=evt.id, ts=evt.ts.isoformat(), variant_id=evt.variant_id,
            serial=evt.serial, gross_g=evt.gross_g, net_g=evt.net_g, in_range=evt.in_range
        )

# --- Stats (pass/fail counters, optional by variant)
@app.get("/api/stats")
def stats(variant_id: Optional[int] = None):
    with Session() as s:
        q = s.query(WeighEvent)
        if variant_id:
            q = q.filter(WeighEvent.variant_id == variant_id)
        pass_count = q.filter(WeighEvent.in_range.is_(True)).count()
        fail_count = q.filter(WeighEvent.in_range.is_(False)).count()
        return {"pass": pass_count, "fail": fail_count, "total": pass_count + fail_count}

# --- CSV export
@app.get("/export.csv")
def export_csv(frm: Optional[str] = None, to: Optional[str] = None, variant: Optional[int] = None):
    # Minimal filtering; extend as needed
    output = io.StringIO()
    w = csv.writer(output)
    w.writerow(["ts", "variant_id", "serial", "gross_g", "net_g", "in_range"])
    with Session() as s:
        q = s.query(WeighEvent)
        if variant: q = q.filter(WeighEvent.variant_id == variant)
        for r in q.order_by(WeighEvent.ts.asc()).all():
            w.writerow([r.ts.isoformat(), r.variant_id, r.serial, r.gross_g, r.net_g, r.in_range])
    output.seek(0)
    return StreamingResponse(output, media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=weigh_export.csv"})

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