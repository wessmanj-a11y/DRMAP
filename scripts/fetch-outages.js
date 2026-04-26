const fs = require("fs/promises");

const OUT = "outages.json";

const INSTANCE_ID = "560abba3-7881-4741-b538-ca416b58ba1e";
const VIEW_ID = "ca124b24-9a06-4b19-aeb3-1841a9c962e1";
const BASE = "https://kubra.io";
const LAYER_ID = "cluster-3";

let requestCount = 0;

function joinUrl(base, path) {
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function fetchJson(url) {
  requestCount++;

  const res = await fetch(url, {
    headers: {
      accept: "application/json,text/html,*/*",
      "user-agent": "Mozilla/5.0"
    }
  });

  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  return JSON.parse(await res.text());
}

function decodePolyline(str) {
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];

  while (index < str.length) {
    let b, shift = 0, result = 0;

    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;

    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coordinates.push([lat / 1e5, lng / 1e5]);
  }

  return coordinates;
}

function lon2tile(lon, z) {
  return Math.floor((lon + 180) / 360 * Math.pow(2, z));
}

function lat2tile(lat, z) {
  const rad = lat * Math.PI / 180;
  return Math.floor(
    (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z)
  );
}

function tileToQuadkey(x, y, z) {
  let q = "";
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if (x & mask) digit += 1;
    if (y & mask) digit += 2;
    q += digit;
  }
  return q;
}

function bbox(points) {
  return {
    minLat: Math.min(...points.map(p => p[0])),
    maxLat: Math.max(...points.map(p => p[0])),
    minLon: Math.min(...points.map(p => p[1])),
    maxLon: Math.max(...points.map(p => p[1]))
  };
}

function bboxQuadkeys(bounds, zoom) {
  const x1 = lon2tile(bounds.minLon, zoom);
  const x2 = lon2tile(bounds.maxLon, zoom);
  const y1 = lat2tile(bounds.maxLat, zoom);
  const y2 = lat2tile(bounds.minLat, zoom);
  const out = [];

  for (let x = x1; x <= x2; x++) {
    for (let y = y1; y <= y2; y++) {
      out.push(tileToQuadkey(x, y, zoom));
    }
  }

  return out;
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

    const polys =
      feature.geometry.type === "Polygon"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;

    for (const poly of polys) {
      const ring = poly[0].map(([lng, lat]) => [lat, lng]);
      if (pointInRing([lat, lon], ring)) return feature.properties.NAME;
    }
  }

  return null;
}

async function main() {
  const sourceStatus = [];
  let countyRows = [];

  try {
    const counties = await fetchJson(
      "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json"
    );

    const state = await fetchJson(
      `${BASE}/stormcenter/api/v1/stormcenters/${INSTANCE_ID}/views/${VIEW_ID}/currentState?preview=false`
    );

    const regionKey = Object.keys(state.datastatic)[0];
    const regionsPath = state.datastatic[regionKey];

    const serviceAreas = await fetchJson(
      joinUrl(BASE, `${regionsPath}/${regionKey}/serviceareas.json`)
    );

    let servicePoints = [];
    for (const encoded of serviceAreas.file_data?.[0]?.geom?.a || []) {
      servicePoints = servicePoints.concat(decodePolyline(encoded));
    }

    const bounds = bbox(servicePoints);
    const clusterPath = state.data.cluster_interval_generation_data;

    const byOutage = new Map();

    for (let zoom = 7; zoom <= 8; zoom++) {
      const quadkeys = bboxQuadkeys(bounds, zoom);

      for (const q of quadkeys) {
        const qkh = q.slice(-3).split("").reverse().join("");
        const url = joinUrl(
          BASE,
          `${clusterPath.replace("{qkh}", qkh)}/public/${LAYER_ID}/${q}.json`
        );

        try {
          const json = await fetchJson(url);

          for (const row of json.file_data || []) {
            const encoded = row.geom?.p?.[0];
            if (!encoded) continue;

            const [lat, lon] = decodePolyline(encoded)[0] || [];
            if (!lat || !lon) continue;

            const county = countyForPoint(lat, lon, counties);
            if (!county) continue;

            const customersOut = Number(row.desc?.cust_a?.val || 0);
            const incidents = Number(row.desc?.n_out || 1);

            if (customersOut <= 0) continue;

            const key = `${lat}|${lon}|${row.desc?.start_time || row.id}`;
            byOutage.set(key, {
              county,
              customersOut,
              incidents
            });
          }
        } catch {
          // Missing tiles are normal.
        }
      }
    }

    const byCounty = new Map();

    for (const o of byOutage.values()) {
      if (!byCounty.has(o.county)) {
        byCounty.set(o.county, {
          state: "TX",
          county: o.county,
          utility: "Oncor",
          customersOut: 0,
          incidents: 0,
          updated: new Date().toISOString(),
          source: "Oncor KUBRA tile aggregation"
        });
      }

      const row = byCounty.get(o.county);
      row.customersOut += o.customersOut;
      row.incidents += o.incidents;
    }

    countyRows = [...byCounty.values()].sort(
      (a, b) => b.customersOut - a.customersOut
    );

    sourceStatus.push({
      name: "Oncor KUBRA",
      ok: true,
      requests: requestCount,
      rawOutages: byOutage.size,
      countyRecords: countyRows.length
    });
  } catch (err) {
    sourceStatus.push({
      name: "Oncor KUBRA",
      ok: false,
      error: err.message,
      requests: requestCount
    });
  }

  const payload = {
    updated: new Date().toISOString(),
    note: "Texas outage file generated from Oncor KUBRA tile data.",
    sourceStatus,
    count: countyRows.length,
    countiesWithOutages: new Set(countyRows.map(o => o.county)).size,
    totalCustomersOut: countyRows.reduce((s, o) => s + o.customersOut, 0),
    outages: countyRows
  };

  await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload.sourceStatus, null, 2));
  console.log(`Wrote ${payload.count} counties / ${payload.totalCustomersOut} customers out`);
}

main();
