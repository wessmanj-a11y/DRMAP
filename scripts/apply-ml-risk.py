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
    "incidents",
    "maxSingleOutage",
    "currentSeverity",
    "predictedRisk",
    "restorationDifficulty",
    "weatherAlerts",
    "weatherRisk",
    "roadClosures",
    "roadClosureRisk",
    "trend24h",
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
        print("No outages.json found")
        return

    payload = json.loads(OUTAGES_FILE.read_text())

    if not MODEL_FILE.exists() or not METADATA_FILE.exists():
        payload["mlRisk"] = {
            "ok": False,
            "reason": "ML model not trained yet",
            "updated": datetime.now(timezone.utc).isoformat()
        }
        OUTAGES_FILE.write_text(json.dumps(payload, indent=2))
        print("ML model not ready yet")
        return

    metadata = json.loads(METADATA_FILE.read_text())

    if not metadata.get("ok"):
        payload["mlRisk"] = {
            "ok": False,
            "reason": metadata.get("reason", "ML model metadata says not ready"),
            "updated": datetime.now(timezone.utc).isoformat()
        }
        OUTAGES_FILE.write_text(json.dumps(payload, indent=2))
        print("ML metadata not ready")
        return

    model = joblib.load(MODEL_FILE)

    rows = payload.get("outages", [])

    if not rows:
        payload["mlRisk"] = {
            "ok": False,
            "reason": "No county outage rows to score",
            "updated": datetime.now(timezone.utc).isoformat()
        }
        OUTAGES_FILE.write_text(json.dumps(payload, indent=2))
        print("No rows to score")
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

        # Keep your rule score, but add a blended score too
        rules = num(row.get("predictedRisk"))
        blended = round((rules * 0.7) + ((p * 100) * 0.3))
        row["blendedPredictedRisk"] = blended

    payload["mlRisk"] = {
        "ok": True,
        "updated": datetime.now(timezone.utc).isoformat(),
        "modelUpdated": metadata.get("updated"),
        "rowsScored": len(rows),
        "features": FEATURES,
        "note": "ML is blended conservatively: 70% rules, 30% ML"
    }

    OUTAGES_FILE.write_text(json.dumps(payload, indent=2))

    print(f"Scored {len(rows)} counties with ML risk")


if __name__ == "__main__":
    main()
