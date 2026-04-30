const fs = require("fs/promises");

const OUTAGES_FILE = "outages.json";
const HISTORY_FILE = "history/outage-history.json";
const FORECAST_FILE = "history/county-weather-forecast.json";

function num(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function keyCounty(name) {
  return String(name || "")
    .replace(/ County$/i, "")
    .trim()
    .toLowerCase();
}

function emptyForecast() {
  return {
    forecastWindMax6h: 0,
    forecastWindMax12h: 0,
    forecastPrecipChanceMax12h: 0,
    forecastTempMax12h: null,
    forecastTempMin12h: null,
    forecastStormRisk: 0,
    forecastSummary12h: null
  };
}

function forecastFields(forecast) {
  if (!forecast) return emptyForecast();

  return {
    forecastWindMax6h: num(forecast.forecastWindMax6h),
    forecastWindMax12h: num(forecast.forecastWindMax12h),
    forecastPrecipChanceMax12h: num(forecast.forecastPrecipChanceMax12h),
    forecastTempMax12h:
      forecast.forecastTempMax12h == null ? null : num(forecast.forecastTempMax12h),
    forecastTempMin12h:
      forecast.forecastTempMin12h == null ? null : num(forecast.forecastTempMin12h),
    forecastStormRisk: num(forecast.forecastStormRisk),
    forecastSummary12h: forecast.forecastSummary12h || null
  };
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const outagesPayload = await readJson(OUTAGES_FILE, null);
  if (!outagesPayload) {
    console.log("No outages.json found; skipping weather forecast merge");
    return;
  }

  const forecastPayload = await readJson(FORECAST_FILE, { forecasts: [] });
  const forecastRows = Array.isArray(forecastPayload.forecasts)
    ? forecastPayload.forecasts
    : [];

  const byCounty = new Map(
    forecastRows.map(f => [keyCounty(f.county || f.key), f])
  );

  let enriched = 0;

  outagesPayload.outages = (outagesPayload.outages || []).map(row => {
    const forecast = byCounty.get(keyCounty(row.county));
    if (forecast) enriched += 1;
    return {
      ...row,
      ...forecastFields(forecast)
    };
  });

  outagesPayload.weatherForecast = {
    ok: forecastRows.length > 0,
    updated: forecastPayload.updated || null,
    source: forecastPayload.source || "NWS hourly forecast via county centroids",
    countyForecasts: forecastRows.length,
    countiesEnriched: enriched,
    errorCount: forecastPayload.errorCount || 0
  };

  outagesPayload.sourceStatus = Array.isArray(outagesPayload.sourceStatus)
    ? outagesPayload.sourceStatus.filter(s => s.name !== "NWS County Forecast")
    : [];

  outagesPayload.sourceStatus.push({
    name: "NWS County Forecast",
    ok: forecastRows.length > 0,
    countyForecasts: forecastRows.length,
    countiesEnriched: enriched,
    errorCount: forecastPayload.errorCount || 0
  });

  await fs.writeFile(OUTAGES_FILE, JSON.stringify(outagesPayload, null, 2));

  const historyPayload = await readJson(HISTORY_FILE, null);
  const snapshots = historyPayload?.snapshots;

  if (Array.isArray(snapshots) && snapshots.length) {
    const latest = snapshots[snapshots.length - 1];

    latest.counties = (latest.counties || []).map(row => {
      const forecast = byCounty.get(keyCounty(row.county));
      return {
        ...row,
        ...forecastFields(forecast)
      };
    });

    await fs.writeFile(
      HISTORY_FILE,
      JSON.stringify(
        {
          ...historyPayload,
          updated: new Date().toISOString(),
          snapshots
        },
        null,
        2
      )
    );
  }

  console.log(
    `Merged NWS forecast into ${enriched} outage counties from ${forecastRows.length} county forecasts`
  );
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
