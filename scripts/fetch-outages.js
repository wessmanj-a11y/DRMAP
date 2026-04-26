const fs = require("fs/promises");

const OUT = "outages.json";
const HISTORY_OUT = "history/outage-history.json";

const TDIS_URL =
  "https://services1.arcgis.com/fXHQyq63u0UsTeSM/arcgis/rest/services/Power_Outage_Data/FeatureServer/0/query";

const COUNTIES_URL =
  "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json";

const NWS_URL = "https://api.weather.gov/alerts/active?area=TX";

const HHS_URL =
  "https://data.cdc.gov/resource/mpgq-jmmr.json?$limit=12&jurisdiction=TX&$order=weekendingdate DESC";

const ERCOT_SUPPLY_URL =
  "https://www.ercot.com/api/1/services/read/dashboards/supply-demand.json";

const ERCOT_OUTAGES_URL =
  "https://www.ercot.com/api/1/services/read/dashboards/generation-outages.json";

// ==============================
// Basic helpers
// ==============================

function num(v) {
  const n = Number(String(v ?? 0).replace(/,/g, "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json,*/*" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function tryFetchJson(url) {
  try {
    return await fetchJson(url);
  } catch {
    return null;
  }
}

function buildHospitalCapacity(hhsRows) {
  const rows = Array.isArray(hhsRows) ? hhsRows : [];

  const trend = rows
    .map(r => ({
      weekEndingDate: r.weekendingdate,
      inpatientOccupancyPct: num(r.pctinptbedsocc),
      icuOccupancyPct: num(r.pcticubedsocc),
      inpatientBeds: num(r.numinptbeds),
      inpatientBedsOccupied: num(r.numinptbedsocc),
      icuBeds: num(r.numicubeds),
      icuBedsOccupied: num(r.numicubedsocc)
    }))
    .filter(r => r.weekEndingDate)
    .sort((a, b) => new Date(a.weekEndingDate) - new Date(b.weekEndingDate));

  const latest = trend[trend.length - 1] || null;

  return {
    source: "CDC Weekly Hospital Respiratory Data",
    latest,
    trend
  };
}

function buildHospitalCapacity(hhsRows) {

}

function buildGridStress(supply, outages) {

  const latest = supply?.data?.[0];
  if(!latest) return null;

  const demand = num(latest.demand);
  const available = num(latest.availableCapacity);

  const reservePct =
    demand > 0 ? ((available - demand) / demand) * 100 : null;

  const outageMW = num(outages?.data?.[0]?.totalOutagesMW);

  let score = 0;

  if (reservePct < 15) score += 2;
  if (reservePct < 10) score += 3;
  if (reservePct < 5)  score += 5;

  if (outageMW > 10000) score += 1;
  if (outageMW > 20000) score += 2;

  let level = "LOW";
  if (score >= 3) level = "MODERATE";
  if (score >= 6) level = "HIGH";
  if (score >= 9) level = "CRITICAL";

  return {
    demandMW: demand,
    availableMW: available,
    reservePct,
    outageMW,
    score,
    level,
    timestamp: latest.timestamp
  };
}

// ==============================
// TDIS outage fetch
// ==============================

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

// ==============================
// County lookup
// ==============================

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

// ==============================
// Outage helpers
// ==============================

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

// ==============================
// Weather scoring
// ==============================

function getWeatherWeight(alert) {
  const p = alert.properties || {};
  const severity = String(p.severity || "").toLowerCase();
  const event = String(p.event || "").toLowerCase();
  const urgency = String(p.urgency || "").toLowerCase();
  const certainty = String(p.certainty || "").toLowerCase();

  let score = 0;

  if (severity === "extreme") score += 18;
  else if (severity === "severe") score += 12;
  else if (severity === "moderate") score += 6;
  else if (severity === "minor") score += 2;

  if (event.includes("ice storm") || event.includes("winter storm")) score += 26;
  else if (event.includes("extreme wind")) score += 28;
  else if (event.includes("high wind")) score += 22;
  else if (event.includes("severe thunderstorm warning")) score += 20;
  else if (event.includes("severe thunderstorm watch")) score += 10;
  else if (event.includes("tornado warning")) score += 18;
  else if (event.includes("tornado watch")) score += 8;
  else if (event.includes("flash flood warning")) score += 8;
  else if (event.includes("flood warning")) score += 6;
  else if (event.includes("flood watch")) score += 3;
  else if (event.includes("red flag") || event.includes("fire weather")) score += 8;
  else if (event.includes("heat")) score += 4;
  else if (event.includes("cold")) score += 5;
  else if (event.includes("storm")) score += 8;

  if (urgency === "immediate") score += 5;
  else if (urgency === "expected") score += 3;

  if (certainty === "observed") score += 5;
  else if (certainty === "likely") score += 3;

  return Math.min(45, score);
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
          urgency: alert.properties?.urgency || "",
          certainty: alert.properties?.certainty || "",
          weight
        });
      }
    }
  }
}

// ==============================
// DriveTexas UTFGrid road closures
// ==============================

const DRIVETEXAS_HOSTS = [
  "https://a.static.drivetexas.org",
  "https://b.static.drivetexas.org",
  "https://c.static.drivetexas.org"
];

const ROAD_TILE_ZOOM = 7;
const ROAD_TILE_X_MIN = 25;
const ROAD_TILE_X_MAX = 31;
const ROAD_TILE_Y_MIN = 48;
const ROAD_TILE_Y_MAX = 54;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function buildRecentDriveTexasPaths() {
  const paths = [];
  const now = new Date();

  for (let minutesBack = 0; minutesBack <= 180; minutesBack += 5) {
    const d = new Date(now.getTime() - minutesBack * 60 * 1000);

    const roundedMinute = Math.floor(d.getUTCMinutes() / 5) * 5;
    d.setUTCMinutes(roundedMinute, 2, 0);

    const yy = pad2(d.getUTCFullYear() % 100);
    const mo = pad2(d.getUTCMonth() + 1);
    const da = pad2(d.getUTCDate());
    const hh = pad2(d.getUTCHours());
    const mm = pad2(d.getUTCMinutes());

    paths.push(`tileset/${yy}/${mo}/${da}/${hh}/${mm}/02`);
  }

  return [...new Set(paths)];
}

function tileCellToLatLon(z, x, y, cellX, cellY, gridSize = 64) {
  const n = Math.pow(2, z);

  const lon = ((x + cellX / gridSize) / n) * 360 - 180;

  const latRad = Math.atan(
    Math.sinh(Math.PI * (1 - 2 * (y + cellY / gridSize) / n))
  );

  const lat = latRad * 180 / Math.PI;

  return { lat, lon };
}

function cleanRoadText(html = "") {
  return String(html)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function roadRiskScore(event) {
  const type = String(event.type || "").toUpperCase();
  const desc = String(event.description || "").toLowerCase();

  let score = 0;

  if (type === "Z") score += 10;
  else if (type === "D") score += 9;
  else if (type === "O") score += 5;
  else if (type === "C") score += 2;

  if (desc.includes("closed")) score += 6;
  if (desc.includes("all main lanes closed")) score += 8;
  if (desc.includes("main lanes closed")) score += 6;
  if (desc.includes("bridge is closed")) score += 8;
  if (desc.includes("roadway is closed")) score += 8;
  if (desc.includes("damage")) score += 6;
  if (desc.includes("flood")) score += 8;
  if (desc.includes("alternate route")) score += 4;
  if (desc.includes("detour")) score += 4;
  if (desc.includes("travel discouraged")) score += 5;
  if (desc.includes("closed to through traffic")) score += 6;
  if (desc.includes("closed to thru traffic")) score += 6;

  if (desc.includes("main lanes not affected")) score -= 6;
  if (desc.includes("frontage road only")) score -= 4;

  return Math.max(0, Math.min(20, score));
}

function isRealClosure(event) {
  const type = String(event.type || "").toUpperCase();
  const desc = String(event.description || "").toLowerCase();

  if (desc.includes("main lanes not affected")) return false;
  if (desc.includes("frontage road only")) return false;

  if (type === "Z") return true;
  if (type === "D" && desc.includes("closed")) return true;

  if (desc.includes("all main lanes closed")) return true;
  if (desc.includes("main lanes closed")) return true;
  if (desc.includes("roadway is closed")) return true;
  if (desc.includes("bridge is closed")) return true;
  if (desc.includes("closed to through traffic")) return true;
  if (desc.includes("closed to thru traffic")) return true;
  if (desc.includes("travel discouraged")) return true;
  if (desc.includes("detour in place")) return true;

  return false;
}

async function fetchDriveTexasTile(host, path, z, x, y) {
  const url = `${host}/${path}/${z}/${x}/${y}.grid.json`;
  const res = await fetch(url, { headers: { accept: "application/json,*/*" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function discoverDriveTexasPath() {
  const candidatePaths = buildRecentDriveTexasPaths();

  for (const path of candidatePaths) {
    for (const host of DRIVETEXAS_HOSTS) {
      const test = await tryFetchJson(`${host}/${path}/7/29/52.grid.json`);
      if (test?.grid && test?.keys && test?.data) {
        return path;
      }
    }
  }

  return null;
}

async function fetchDriveTexasRoadEvents(counties) {
  const eventsById = new Map();
  let requests = 0;
  let successes = 0;
  let failures = 0;

  const path = await discoverDriveTexasPath();

  if (!path) {
    return {
      events: [],
      status: {
        name: "DriveTexas UTFGrid closures",
        ok: false,
        error: "Could not discover current DriveTexas tileset path",
        requests,
        successes,
        failures
      }
    };
  }

  for (let x = ROAD_TILE_X_MIN; x <= ROAD_TILE_X_MAX; x++) {
    for (let y = ROAD_TILE_Y_MIN; y <= ROAD_TILE_Y_MAX; y++) {
      let tile = null;

      for (const host of DRIVETEXAS_HOSTS) {
        try {
          requests++;
          tile = await fetchDriveTexasTile(host, path, ROAD_TILE_ZOOM, x, y);
          successes++;
          break;
        } catch {
          failures++;
        }
      }

      if (!tile || !tile.grid || !tile.keys || !tile.data) continue;

      const seenKeysInTile = new Set();

      tile.grid.forEach((row, rowIndex) => {
        [...row].forEach((symbol, colIndex) => {
          if (!symbol || symbol === " ") return;

          const keyIndex = symbol.charCodeAt(0) - 32;
          const eventId = tile.keys[keyIndex];

          if (!eventId || seenKeysInTile.has(eventId)) return;
          seenKeysInTile.add(eventId);

          const raw = tile.data[eventId];
          if (!raw) return;

          const { lat, lon } = tileCellToLatLon(
            ROAD_TILE_ZOOM,
            x,
            y,
            colIndex,
            rowIndex,
            tile.grid.length || 64
          );

          const description = cleanRoadText(raw.COND_DSCR);
          const county = countyForPoint(lat, lon, counties);

          if (!county) return;

          const event = {
            id: eventId,
            county,
            lat,
            lon,
            type: raw.CNSTRNT_TYPE_CD || "Unknown",
            road: raw.RDWAY_NM || raw.RTE_NM || "Unknown",
            route: raw.RTE_NM || "",
            direction: raw.TRVL_DRCT_CD || "",
            description,
            endTime: raw.COND_END_TS ? new Date(raw.COND_END_TS).toISOString() : null,
            source: "DriveTexas UTFGrid tile",
            risk: 0
          };

          event.risk = roadRiskScore(event);

          if (isRealClosure(event)) {
            eventsById.set(event.id, event);
          }
        });
      });
    }
  }

  const events = [...eventsById.values()].sort((a, b) => b.risk - a.risk);

  return {
    events,
    status: {
      name: "DriveTexas UTFGrid closures",
      ok: true,
      path,
      requests,
      successes,
      failures,
      count: events.length,
      zoom: ROAD_TILE_ZOOM,
      tileRange: {
        x: [ROAD_TILE_X_MIN, ROAD_TILE_X_MAX],
        y: [ROAD_TILE_Y_MIN, ROAD_TILE_Y_MAX]
      }
    }
  };
}

// ==============================
// Main scoring
// ==============================

function computeCurrentSeverity(row) {
  const outageMagnitude = Math.min(40, Math.log10(1 + row.customersOut) * 10);
  const incidentScore = Math.min(20, row.incidents * 1.5);
  const largeClusterScore = Math.min(15, Math.log10(1 + row.maxSingleOutage) * 4);
  const weatherNowModifier = Math.min(10, row.weatherRisk * 0.1);
  const roadNowModifier = Math.min(8, (row.roadClosureRisk || 0) * 0.12);

  return Math.round(
    Math.min(
      100,
      outageMagnitude +
        incidentScore +
        largeClusterScore +
        weatherNowModifier +
        roadNowModifier
    )
  );
}

function computePredictedRisk(row, historyRow) {
  const weatherPressure = Math.min(35, row.weatherRisk * 0.25);
  const currentFragility = row.customersOut > 0
    ? Math.min(20, Math.log10(1 + row.customersOut) * 5)
    : 0;
  const incidentFragility = row.incidents > 0
    ? Math.min(10, row.incidents * 0.75)
    : 0;
  const trendPressure = historyRow && historyRow.change24h > 0
    ? Math.min(10, Math.log10(1 + historyRow.change24h) * 3)
    : 0;
  const roadAccessPressure = Math.min(15, (row.roadClosureRisk || 0) * 0.4);

  return Math.round(
    Math.min(
      100,
      weatherPressure +
        currentFragility +
        incidentFragility +
        trendPressure +
        roadAccessPressure
    )
  );
}

function computeRestorationDifficulty(row) {
  const outageLoad = Math.min(35, Math.log10(1 + row.customersOut) * 8);
  const incidentLoad = Math.min(15, row.incidents * 0.75);
  const roadAccess = Math.min(35, (row.roadClosureRisk || 0) * 0.7);
  const weatherAccess = Math.min(15, row.weatherRisk * 0.12);

  return Math.round(
    Math.min(100, outageLoad + incidentLoad + roadAccess + weatherAccess)
  );
}

function riskBand(score) {
  if (score >= 75) return "High";
  if (score >= 50) return "Elevated";
  if (score >= 25) return "Watch";
  return "Low";
}

// ==============================
// History
// ==============================

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

// ==============================
// Main
// ==============================

async function main() {
  try {
    const [counties, points, nws, hhsRows, ercotSupply, ercotOutages] = await Promise.all([
  fetchJson(COUNTIES_URL),
  fetchAllTDIS(),
  fetchJson(NWS_URL).catch(() => ({ features: [] })),
  fetchJson(HHS_URL).catch(() => []),
  fetchJson(ERCOT_SUPPLY_URL).catch(() => null),
  fetchJson(ERCOT_OUTAGES_URL).catch(() => null)
]);

const hospitalCapacity = buildHospitalCapacity(hhsRows);

    const gridStress = buildGridStress(ercotSupply, ercotOutages);

    const roadResult = await fetchDriveTexasRoadEvents(counties);
    const roadClosures = roadResult.events || [];

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
          roadClosureRisk: 0,
          roadEvents: [],
          restorationDifficulty: 0,
          updated: new Date().toISOString(),
          source: "TDIS Power_Outage_Data + NWS + DriveTexas"
        });
      }

      const row = byCounty.get(county);
      row.customersOut += customers;
      row.incidents += 1;
      row.maxSingleOutage = Math.max(row.maxSingleOutage, customers);
    }

    const outages = [...byCounty.values()];
    const nwsAlerts = nws.features || [];

    const countyByName = new Map(
      outages.map(o => [String(o.county).toLowerCase(), o])
    );

    for (const road of roadClosures) {
      const row = countyByName.get(String(road.county || "").toLowerCase());
      if (!row) continue;

      row.roadClosures += 1;
      row.roadClosureRisk += road.risk || 0;
      row.roadEvents.push(road);
    }

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
      row.restorationDifficulty = computeRestorationDifficulty(row);
      row.trend24h = historyRow.change24h;
      row.sevenDayPeak = historyRow.sevenDayPeak;

      row.predictionExplanation = [
        row.weatherAlerts > 0 ? `${row.weatherAlerts} county-matched weather alert(s)` : "No county-matched weather alerts",
        row.customersOut > 0 ? `${row.customersOut.toLocaleString()} current customers out` : "No current outage load",
        row.roadClosures > 0 ? `${row.roadClosures} impactful road closure(s)` : "No impactful road closures near active outage counties",
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
        predictedRisk: o.predictedRisk,
        restorationDifficulty: o.restorationDifficulty,
        roadClosures: o.roadClosures || 0
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
  name: "HHS/CDC Hospital Capacity",
  ok: !!hospitalCapacity.latest,
  latestWeek: hospitalCapacity.latest?.weekEndingDate || null,
  inpatientOccupancyPct: hospitalCapacity.latest?.inpatientOccupancyPct ?? null,
  weeks: hospitalCapacity.trend.length
},
        {
          name: "NWS Active Alerts",
          ok: true,
          activeTexasAlerts: nwsAlerts.length
        },
        roadResult.status,
        {
          name: "History",
          ok: true,
          snapshots: newSnapshots.length
        }
      ],
      count: outages.length,
      countiesWithOutages: outages.length,
      totalCustomersOut: outages.reduce((s, o) => s + o.customersOut, 0),
      highestPredictedRisk: Math.max(0, ...outages.map(o => o.predictedRisk)),
      highestCurrentSeverity: Math.max(0, ...outages.map(o => o.currentSeverity)),
      highestRestorationDifficulty: Math.max(0, ...outages.map(o => o.restorationDifficulty || 0)),
      outages,
      outagePoints: outagePoints.sort((a, b) => b.customersOut - a.customersOut).slice(0, 5000),
      roadClosures,
      roadSummary: {
        count: roadClosures.length,
        highRisk: roadClosures.filter(r => r.risk >= 15).length,
        source: "DriveTexas UTFGrid tiles"
      },
      hospitalCapacity,
      gridStress,
      history: newSnapshots.slice(-48)
    };

    await fs.writeFile(OUT, JSON.stringify(payload, null, 2));

    console.log(
      `SUCCESS: ${payload.totalCustomersOut} customers out, ${payload.roadSummary.count} road closures, ${payload.highestPredictedRisk} highest predicted risk`
    );
  } catch (err) {
    const payload = {
      updated: new Date().toISOString(),
      sourceStatus: [{ name: "v5 pipeline", ok: false, error: err.message }],
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
