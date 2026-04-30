# DRMAP Forecast UI Upgrade Patch

## 1. Add Forecast Threat control button
In `index.html`, inside the map controls block, add:

```html
<button id="forecastBtn" class="inactive">Forecast Threat</button>
```

Place it after `weatherBtn`.

---

## 2. Add forecast fields to county model init
Inside `initCounties()` county object:

```javascript
forecastWindMax6h: 0,
forecastWindMax12h: 0,
forecastPrecipChanceMax12h: 0,
forecastStormRisk: 0,
forecastSummary12h: null,
```

---

## 3. During outage ingest, map forecast fields from backend
Inside `processOutages()` within `outageData.outages?.forEach(c => { ... })`:

```javascript
countyData[key].forecastWindMax6h = safeNum(c.forecastWindMax6h);
countyData[key].forecastWindMax12h = safeNum(c.forecastWindMax12h);
countyData[key].forecastPrecipChanceMax12h = safeNum(c.forecastPrecipChanceMax12h);
countyData[key].forecastStormRisk = safeNum(c.forecastStormRisk);
countyData[key].forecastSummary12h = c.forecastSummary12h || null;
countyData[key].blendedPredictedRisk = safeNum(c.blendedPredictedRisk || c.predictedRisk);
```

---

## 4. Update activeValue(mode)

```javascript
function activeValue(c){
  if(mode === "prediction") return c.blendedPredictedRisk || c.predictedRisk || 0;
  if(mode === "forecast") return c.forecastStormRisk || 0;
  if(mode === "outage") return c.percentCustomersOut || c.customersOut || 0;
  if(mode === "weather") return c.weatherRisk || 0;
  return c.currentSeverity || 0;
}
```

---

## 5. Add forecast button state
Where button states are updated, include:

```javascript
["forecastBtn","forecast"]
```

---

## 6. Add forecast click handler

```javascript
document.getElementById("forecastBtn").onclick = () => {
  mode = "forecast";
  renderAll();
};
```

---

## 7. Selected county panel cards
Add these to the mini-grid:

```html
<div class="mini"><strong id="forecastStormRisk">—</strong><span>Forecast storm risk</span></div>
<div class="mini"><strong id="forecastWind12h">—</strong><span>Max wind next 12h</span></div>
<div class="mini"><strong id="forecastRain12h">—</strong><span>Rain chance next 12h</span></div>
```

---

## 8. Update renderPanel()

```javascript
document.getElementById("forecastStormRisk").textContent = safeNum(c.forecastStormRisk);
document.getElementById("forecastWind12h").textContent = `${safeNum(c.forecastWindMax12h)} mph`;
document.getElementById("forecastRain12h").textContent = `${safeNum(c.forecastPrecipChanceMax12h)}%`;
```

---

## 9. Tooltip upgrade

```javascript
layer.bindTooltip(
  `${c.name} County · Severity ${c.currentSeverity} · Blended ${c.blendedPredictedRisk || "—"} · Forecast ${c.forecastStormRisk || 0}`
);
```

---

## 10. Recommended operational meaning
- Severity = current operational pain
- Predicted Risk = blended ML + rules escalation
- Forecast Threat = incoming storm pressure before outages worsen
- Outages = percent / customers impacted now

This converts DRMAP from reactive dashboard into forward-looking resilience intelligence.
