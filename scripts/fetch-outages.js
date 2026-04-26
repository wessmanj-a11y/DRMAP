const fs = require("fs/promises");

const OUT = "outages.json";

const TDIS_URL =
  "https://services1.arcgis.com/fXHQyq63u0UsTeSM/arcgis/rest/services/Power_Outage_Data/FeatureServer/0/query";

const COUNTIES_URL =
  "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json";

function num(v) {
  const n = Number(String(v ?? 0).replace(/,/g, "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchAllTDIS() {
  let all = [];
  let offset = 0;

  while (true) {
    const url =
      `${TDIS_URL}?where=1%3D1` +
      `&outFields=*` +
      `&returnGeometry=true` +
      `&outSR=4326` +
      `&f=geojson` +
      `&resultRecordCount=2000` +
      `&resultOffset=${offset}`;

    const json = await fetchJson(url);
    const features = json.features || [];

    all.push(...features);

    if (features.length < 2000) break;
    offset += 2000;
    if (offset > 80000) break;
  }

  return all;
}

// --- POINT IN POLYGON ---
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
    const polys = geom.type === "Polygon"
      ? [geom.coordinates]
      : geom.coordinates;

    for (const poly of polys) {
      const ring = poly[0].map(([lng, lat]) => [lat, lng]);
      if (pointInRing([lat, lon], ring)) {
        return f.properties.NAME;
      }
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

// --- MAIN ---
async function main() {
  try {
    const [counties, points] = await Promise.all([
      fetchJson(COUNTIES_URL),
      fetchAllTDIS()
    ]);

    const byCounty = new Map();
    const outagePoints = [];

    for (const f of points) {
      const p = f.properties || {};
      const coords = f.geometry?.coordinates;

      if (!coords) continue;

      const lon = coords[0];
      const lat = coords[1];

      const customers = getCustomersOut(p);
      if (customers <= 0) continue;

      const county = countyForPoint(lat, lon, counties);
      if (!county) continue;

      outagePoints.push({
        county,
        customersOut: customers,
        outageCause: p.OutageCause || "Unknown",
        lat,
        lon
      });

      if (!byCounty.has(county)) {
        byCounty.set(county, {
          county,
          customersOut: 0,
          incidents: 0,
          maxSingleOutage: 0
        });
      }

      const row = byCounty.get(county);

      row.customersOut += customers;
      row.incidents += 1;
      row.maxSingleOutage = Math.max(row.maxSingleOutage, customers);
    }

    const outages = [...byCounty.values()].sort(
      (a, b) => b.customersOut - a.customersOut
    );

    const payload = {
      updated: new Date().toISOString(),
      count: outages.length,
      totalCustomersOut: outages.reduce((s, o) => s + o.customersOut, 0),
      outages,
      outagePoints
    };

    await fs.writeFile(OUT, JSON.stringify(payload, null, 2));

    console.log("SUCCESS:", payload.totalCustomersOut, "customers out");
  } catch (err) {
    console.error(err);
  }
}

main();
