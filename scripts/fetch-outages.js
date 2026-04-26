const fs = require("fs/promises");

const OUT = "outages.json";
const HISTORY_OUT = "history/outage-history.json";

const TDIS_URL =
  "https://services1.arcgis.com/fXHQyq63u0UsTeSM/arcgis/rest/services/Power_Outage_Data/FeatureServer/0/query";

const COUNTIES_URL =
  "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json";

const NWS_URL = "https://api.weather.gov/alerts/active?area=TX";

function num(v) {
  const n = Number(String(v ?? 0).replace(/,/g, "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json,*/*" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchAllTDIS() {
  let all = [];
  let offset = 0;
  const pageSize = 2000;

  while (true) {
    const url =
      `${TDIS_URL}?where=1%3D1` +
      `&outFields=*` +
      `&returnGeometry=true` +
      `&outSR=4326` +
      `&f=geojson` +
      `&resultRecordCount=${pageSize}` +
      `&resultOffset=${offset}`;

    const json = await fetchJson(url);
    const features = json.features || [];
    all.push(...features);

    if (features.length < pageSize) break;
    offset += pageSize;
    if (offset > 80000) break;
  }

  return all;
}

function pointInRing(point, ring) {
  const [lat, lon] = point;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][1], yi = ring[i][0];
    const xj = ring[j][1], yj = ring[j][0];

    const intersect =
      ((yi > lat) !== (yj > lat)) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

function countyForPoint(lat, lon, counties) {
  for (const f of counties.features) {
    if (f.properties.STATE !== "48") continue;

    const geom = f.geometry;
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;

    for (const poly of polys) {
      const ring = poly[0].map(([lng, lat]) => [lat, lng]);
      if (pointInRing([lat, lon], ring)) return f.properties.NAME;
    }
  }

  return null;
}

function getCustomersOut(p) {
  return num(
    p.CustomersOut ??
    p.customersOut ??
    p.CUSTOMERSOUT ??
    p.CustomerCount ??
    p.customersAffected ??
    0
  );
}

function getWeatherWeight(alert) {
  const p = alert.properties || {};
  const severity = String(p.severity || "").toLowerCase();
  const event = String(p.event || "").toLowerCase();

  let score = 0;

  if (severity === "extreme") score += 40;
  else if (severity === "severe") score += 30;
  else if (severity === "moderate") score += 16;
  else if (severity === "minor") score += 8;

  if (event.includes("tornado")) score += 30;
  if (event.includes("severe thunderstorm")) score += 24;
  if (event.includes("flash flood")) score += 22;
  if (event.includes("flood")) score += 14;
  if (event.includes("winter") || event.includes("ice")) score += 28;
  if (event.includes("high wind")) score += 18;
  if (event.includes("red flag") || event.includes("fire")) score += 14;

  return score;
}

function applyWeatherToCounties(countyRows, nwsAlerts) {
  const byCounty = new Map(countyRows.map(c => [c.county.toLowerCase(), c]));

  for (const alert of nwsAlerts) {
    const area = String(alert.properties?.areaDesc || "").toLowerCase();
    const weight = getWeatherWeight(alert);

    for (const row of byCounty.values()) {
      if (area.includes(row.county.toLowerCase())) {
        row.weatherAlerts += 1;
        row.weatherRisk += weight;
        row.weatherEvents.push({
          event: alert.properties?.event || "Weather alert",
          severity: alert.properties?.severity || "Unknown",
          headline: alert.properties?.headline || "",
          weight
        });
      }
    }
  }
}

function computeCurrentSeverity(row) {
  const outageMagnitude = Math.min(45, Math.log10(1 + row.customersOut) * 12);
  const incidentScore = Math.min(20, row.incidents * 2.5);
  const weatherScore = Math.min(25, row.weatherRisk * 0.35);
  return Math.round(Math.min(100, outageMagnitude + incidentScore + weatherScore));
}

function computePredictedRisk(row, historyRow) {
  const weatherScore = Math.min(50, row.weatherRisk * 0.55);
  const currentFragility = Math.min(25, Math.log10(1 + row.customersOut) * 8);
  const incidentFragility = Math.min(15, row.incidents * 2);
  const trendPressure = historyRow && historyRow.change24h > 0
    ? Math.min(10, Math.log10(1 + historyRow.change24h) * 4)
    : 0;

  return Math.round(Math.min(100, weatherScore + currentFragility + incidentFragility + trendPressure));
}

function riskBand(score) {
  if (score >= 75) return "High";
  if (score >= 50) return "Elevated";
  if (score >= 25) return "Watch";
  return "Low";
}

async function readHistory() {
  try {
    const raw = await fs.readFile(HISTORY_OUT, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.snapshots) ? parsed.snapshots : [];
  } catch {
    return [];
  }
}

async function writeHistory(snapshots) {
  await fs.mkdir("history", { recursive: true });
  await fs.writeFile(
    HISTORY_OUT,
    JSON.stringify({ updated: new Date().toISOString(), snapshots }, null, 2)
  );
}

function buildHistorySummary(currentCountyRows, previousSnapshots) {
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const oneDayMs = 24 * 60 * 60 * 1000;

  const recent = previousSnapshots.filter(s => {
    const t = new Date(s.timestamp).getTime();
    return Number.isFinite(t) && now - t <= sevenDaysMs;
  });

  const latestOlderThan24h = [...recent]
    .filter(s => now - new Date(s.timestamp).getTime() >= oneDayMs)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

  const byCounty24h = new Map(
    (latestOlderThan24h?.counties || []).map(c => [c.county, c.customersOut])
  );

  const historyByCounty = {};

  for (const row of currentCountyRows) {
    const sevenDayPeak = Math.max(
      row.customersOut,
      ...recent.flatMap(s =>
        (s.counties || [])
          .filter(c => c.county === row.county)
          .map(c => c.customersOut || 0)
      )
    );

    const prior24h = byCounty24h.get(row.county) || 0;

    historyByCounty[row.county] = {
      county: row.county,
      currentCustomersOut: row.customersOut,
      prior24hCustomersOut: prior24h,
      change24h: row.customersOut - prior24h,
      sevenDayPeak
    };
  }

  return historyByCounty;
}

async function main() {
  try {
    const [counties, points, nws] = await Promise.all([
      fetchJson(COUNTIES_URL),
      fetchAllTDIS(),
      fetchJson(NWS_URL).catch(() => ({ features: [] }))
    ]);

    const byCounty = new Map();
    const outagePoints = [];

    for (const f of points) {
      const p = f.properties || {};
      const coords = f.geometry?.coordinates;
      if (!coords) continue;

      const lon = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const customers = getCustomersOut(p);
      if (customers <= 0) continue;

      const county = countyForPoint(lat, lon, counties);
      if (!county) continue;

      const point = {
        county,
        customersOut: customers,
        outageCause: p.OutageCause || p.Cause || "Unknown",
        estimatedRestoration: p.EstimatedRestoration || p.ETR || null,
        lat,
        lon
      };

      outagePoints.push(point);

      if (!byCounty.has(county)) {
        byCounty.set(county, {
          state: "TX",
          county,
          utility: "TDIS Aggregate",
          customersOut: 0,
          incidents: 0,
          maxSingleOutage: 0,
          weatherAlerts: 0,
          weatherRisk: 0,
          weatherEvents: [],
          roadClosures: 0,
          updated: new Date().toISOString(),
          source: "TDIS Power_Outage_Data + NWS"
        });
      }

      const row = byCounty.get(county);
      row.customersOut += customers;
      row.incidents += 1;
      row.maxSingleOutage = Math.max(row.maxSingleOutage, customers);
    }

    const outages = [...byCounty.values()];
    const nwsAlerts = nws.features || [];

    applyWeatherToCounties(outages, nwsAlerts);

    const previousSnapshots = await readHistory();
    const historyByCounty = buildHistorySummary(outages, previousSnapshots);

    for (const row of outages) {
      const historyRow = historyByCounty[row.county] || {
        county: row.county,
        currentCustomersOut: row.customersOut,
        prior24hCustomersOut: 0,
        change24h: row.customersOut,
        sevenDayPeak: row.customersOut
      };

      row.currentSeverity = computeCurrentSeverity(row);
      row.predictedRisk = computePredictedRisk(row, historyRow);
      row.predictedRiskBand = riskBand(row.predictedRisk);
      row.trend24h = historyRow.change24h;
      row.sevenDayPeak = historyRow.sevenDayPeak;

      row.predictionExplanation = [
        row.weatherAlerts > 0 ? `${row.weatherAlerts} active weather alert(s)` : "No active weather alerts",
        row.customersOut > 0 ? `${row.customersOut.toLocaleString()} current customers out` : "No current outage load",
        row.trend24h > 0 ? `24h trend worsening by ${row.trend24h.toLocaleString()}` : "24h trend stable or improving"
      ].join(" + ");
    }

    outages.sort((a, b) => b.currentSeverity - a.currentSeverity);

    const snapshot = {
      timestamp: new Date().toISOString(),
      totalCustomersOut: outages.reduce((s, o) => s + o.customersOut, 0),
      countiesImpacted: outages.length,
      counties: outages.map(o => ({
        county: o.county,
        customersOut: o.customersOut,
        incidents: o.incidents,
        currentSeverity: o.currentSeverity,
        predictedRisk: o.predictedRisk
      }))
    };

    const newSnapshots = [...previousSnapshots, snapshot].filter(s => {
      const t = new Date(s.timestamp).getTime();
      return Number.isFinite(t) && Date.now() - t <= 7 * 24 * 60 * 60 * 1000;
    });

    await writeHistory(newSnapshots);

    const payload = {
      updated: new Date().toISOString(),
      sourceStatus: [
        {
          name: "TDIS Power Outage Data",
          ok: true,
          rawPointRecords: points.length,
          pointRecordsUsed: outagePoints.length,
          countyRecords: outages.length
        },
        {
          name: "NWS Active Alerts",
          ok: true,
          activeTexasAlerts: nwsAlerts.length
        },
        {
          name: "History",
          ok: true,
          snapshots: newSnapshots.length
        },
        {
          name: "Road Closures",
          ok: false,
          note: "Not configured yet"
        }
      ],
      count: outages.length,
      countiesWithOutages: outages.length,
      totalCustomersOut: outages.reduce((s, o) => s + o.customersOut, 0),
      highestPredictedRisk: Math.max(0, ...outages.map(o => o.predictedRisk)),
      highestCurrentSeverity: Math.max(0, ...outages.map(o => o.currentSeverity)),
      outages,
      outagePoints: outagePoints.sort((a, b) => b.customersOut - a.customersOut).slice(0, 5000),
      roadClosures: [],
      history: newSnapshots.slice(-48)
    };

    await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
    console.log(`SUCCESS: ${payload.totalCustomersOut} customers out, ${payload.highestPredictedRisk} highest predicted risk`);
  } catch (err) {
    const payload = {
      updated: new Date().toISOString(),
      sourceStatus: [{ name: "v4 pipeline", ok: false, error: err.message }],
      count: 0,
      totalCustomersOut: 0,
      highestPredictedRisk: 0,
      outages: [],
      outagePoints: [],
      roadClosures: [],
      history: []
    };

    await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
    console.error(err);
    process.exitCode = 1;
  }
}

main();
