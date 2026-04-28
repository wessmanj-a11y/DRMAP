import json
from pathlib import Path
from datetime import datetime, timezone

import joblib
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, precision_score, recall_score
from sklearn.model_selection import train_test_split


TRAINING_FILE = Path("history/training-data.json")
MODEL_FILE = Path("history/ml-risk-model.joblib")
METADATA_FILE = Path("history/ml-risk-metadata.json")

FEATURES = [
    "customersOut",
    "percentCustomersOut",
    "incidents",
    "maxSingleOutage",
    "weatherAlerts",
    "weatherRisk",
    "roadClosures",
    "roadClosureRisk",
    "trend6h",
    "trend12h",
    "trend24h",
    "trendVelocity",
    "sevenDayPeak",
]

TARGET = "worsened"
MIN_ROWS = 200
MIN_POSITIVES = 10


def write_metadata(payload):
    METADATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    METADATA_FILE.write_text(json.dumps(payload, indent=2))


def main():
    if not TRAINING_FILE.exists():
        write_metadata({
            "ok": False,
            "reason": "training-data.json does not exist yet",
            "updated": datetime.now(timezone.utc).isoformat()
        })
        print("Not enough data: training-data.json missing")
        return

    raw = json.loads(TRAINING_FILE.read_text())
    rows = raw.get("rows", [])

    if len(rows) < MIN_ROWS:
        write_metadata({
            "ok": False,
            "reason": f"not enough rows yet: {len(rows)} / {MIN_ROWS}",
            "rows": len(rows),
            "updated": datetime.now(timezone.utc).isoformat()
        })
        print(f"Not enough data: {len(rows)} rows")
        return

    df = pd.DataFrame(rows)

    for col in FEATURES + [TARGET]:
        if col not in df.columns:
            df[col] = 0

    df = df[FEATURES + [TARGET]].fillna(0)

    positives = int(df[TARGET].sum())

    if positives < MIN_POSITIVES:
        write_metadata({
            "ok": False,
            "reason": f"not enough worsening examples yet: {positives} / {MIN_POSITIVES}",
            "rows": len(df),
            "positiveExamples": positives,
            "updated": datetime.now(timezone.utc).isoformat()
        })
        print(f"Not enough positive examples: {positives}")
        return

    X = df[FEATURES]
    y = df[TARGET].astype(int)

    X_train, X_test, y_train, y_test = train_test_split(
        X,
        y,
        test_size=0.25,
        random_state=42,
        stratify=y
    )

    model = RandomForestClassifier(
        n_estimators=200,
        max_depth=8,
        min_samples_leaf=5,
        random_state=42,
        class_weight="balanced"
    )

    model.fit(X_train, y_train)

    preds = model.predict(X_test)

    metadata = {
        "ok": True,
        "updated": datetime.now(timezone.utc).isoformat(),
        "rows": len(df),
        "positiveExamples": positives,
        "features": FEATURES,
        "target": TARGET,
        "metrics": {
            "accuracy": round(float(accuracy_score(y_test, preds)), 4),
            "precision": round(float(precision_score(y_test, preds, zero_division=0)), 4),
            "recall": round(float(recall_score(y_test, preds, zero_division=0)), 4)
        },
        "featureImportance": sorted(
            [
                {"feature": f, "importance": round(float(i), 5)}
                for f, i in zip(FEATURES, model.feature_importances_)
            ],
            key=lambda x: x["importance"],
            reverse=True
        )
    }

    MODEL_FILE.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, MODEL_FILE)
    write_metadata(metadata)

    print(f"Trained ML model on {len(df)} rows")
    print(metadata["metrics"])


if __name__ == "__main__":
    main()
