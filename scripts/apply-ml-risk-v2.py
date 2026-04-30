import json
from pathlib import Path
from datetime import datetime, timezone

import joblib
import pandas as pd

OUTAGES_FILE = Path("outages.json")
MODEL_FILE = Path("history/ml-risk-model.joblib")
METADATA_FILE = Path("history/ml-risk-metadata.json")

FEATURES = [
    "customersOut",
    "percentCustomersOut",
    "incidents",
    "maxSingleOutage",
    "weatherAlerts",
    "weatherRisk",
    "forecastWindMax6h",
    "forecastWindMax12h",
    "forecastPrecipChanceMax12h",
    "forecastStormRisk",
    "roadClosures",
    "roadClosureRisk",
    "trend6h",
    "trend12h",
    "trend24h",
    "trendVelocity",
    "sevenDayPeak",
]

def band(prob):
    if prob >= 0.75:
        return "High"
    if prob >= 0.50:
        return "Elevated"
    if prob >= 0.25:
        return "Watch"
    return "Low"

def num(v):
    try:
        return float(v or 0)
    except Exception:
        return 0.0

def main():
    if not OUTAGES_FILE.exists():
        return

    payload = json.loads(OUTAGES_FILE.read_text())

    if not MODEL_FILE.exists() or not METADATA_FILE.exists():
        payload["mlRisk"] = {"ok": False, "reason": "ML model not trained yet", "updated": datetime.now(timezone.utc).isoformat()}
        OUTAGES_FILE.write_text(json.dumps(payload, indent=2))
        return

    metadata = json.loads(METADATA_FILE.read_text())
    if not metadata.get("ok"):
        payload["mlRisk"] = {"ok": False, "reason": metadata.get("reason", "ML model metadata says not ready"), "updated": datetime.now(timezone.utc).isoformat()}
        OUTAGES_FILE.write_text(json.dumps(payload, indent=2))
        return

    model = joblib.load(MODEL_FILE)
    rows = payload.get("outages", [])
    if not rows:
        return

    df = pd.DataFrame(rows)
    for col in FEATURES:
        if col not in df.columns:
            df[col] = 0

    X = df[FEATURES].fillna(0)
    probs = model.predict_proba(X)[:, 1]

    for row, prob in zip(rows, probs):
        p = round(float(prob), 4)
        row["mlRiskProbability"] = p
        row["mlRiskScore"] = round(p * 100)
        row["mlRiskBand"] = band(p)
        rules = num(row.get("predictedRisk"))
        row["blendedPredictedRisk"] = round((rules * 0.6) + ((p * 100) * 0.4))

    payload["mlRisk"] = {
        "ok": True,
        "updated": datetime.now(timezone.utc).isoformat(),
        "modelUpdated": metadata.get("updated"),
        "rowsScored": len(rows),
        "features": FEATURES,
        "note": "ML blend updated with forecast weather"
    }

    OUTAGES_FILE.write_text(json.dumps(payload, indent=2))

if __name__ == "__main__":
    main()
