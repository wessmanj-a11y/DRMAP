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
  const res = await fetch(url, {
    headers: { accept: "application/json,*/*" }
  });

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

    // safety stop
    if (offset > 50000) break;
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
  for (const feature of counties.features) {
    if (feature.properties.STATE !== "48") continue;

    const geom = feature.geometry;
    const polys =
      geom.type === "Polygon"
        ? [geom.coordinates]
        : geom.coordinates;

    for (const poly of polys) {
      const outerRing = poly[0].map(([lng, lat]) => [lat, lng]);

      if (pointInRing([lat, lon], outerRing)) {
        return feature.properties.NAME;
      }
    }
  }

  return null;
}

function getCustomersOut(props) {
  return num(
    props.CustomersOut ??
    props.customersOut ??
    props.CUSTOMERSOUT ??
    props.Customers_Out ??
    props.customers_out ??
    props.CustomersAffected ??
    props.customersAffected ??
    props.CustomerCount ??
    0
  );
}

async function main() {
  try {
    const [counties, points] = await Promise.all([
      fetchJson(COUNTIES_URL),
      fetchAllTDIS()
    ]);

    const byCounty = new Map();
    let pointRecordsUsed = 0;
    let totalPointCustomers = 0;

    for (const feature of points) {
      const props = feature.properties || {};
      const coords = feature.geometry?.coordinates;

      if (!coords || coords.length < 2) continue;

      const lon = Number(coords[0]);
      const lat = Number(coords[1]);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const customersOut = getCustomersOut(props);

      if (customersOut <= 0) continue;

      const county = countyForPoint(lat, lon, counties);

      if (!county) continue;

      pointRecordsUsed++;
      totalPointCustomers += customersOut;

      if (!byCounty.has(county)) {
        byCounty.set(county, {
          state: "TX",
          county,
          utility: "TDIS Aggregate",
          customersOut: 0,
          incidents: 0,
          updated: new Date().toISOString(),
          source: "TDIS Power_Outage_Data FeatureServer"
        });
      }

      const row = byCounty.get(county);
      row.customersOut += customersOut;
      row.incidents += 1;
    }

    const outages = [...byCounty.values()].sort(
      (a, b) => b.customersOut - a.customersOut
    );

    const payload = {
      updated: new Date().toISOString(),
      sourceStatus: [
        {
          name: "TDIS Power Outage Data",
          ok: true,
          rawPointRecords: points.length,
          pointRecordsUsed,
          countyRecords: outages.length
        }
      ],
      count: outages.length,
      countiesWithOutages: outages.length,
      totalCustomersOut: outages.reduce((s, o) => s + o.customersOut, 0),
      outages
    };

    await fs.writeFile(OUT, JSON.stringify(payload, null, 2));

    console.log(
      `Wrote ${payload.count} county records / ${payload.totalCustomersOut} customers out`
    );
  } catch (err) {
    const payload = {
      updated: new Date().toISOString(),
      sourceStatus: [
        {
          name: "TDIS Power Outage Data",
          ok: false,
          error: err.message
        }
      ],
      count: 0,
      countiesWithOutages: 0,
      totalCustomersOut: 0,
      outages: []
    };

    await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
    console.error(err);
    process.exitCode = 1;
  }
}

main();
