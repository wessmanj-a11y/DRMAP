const fs = require("fs/promises");

const OUT = "outages.json";

const INSTANCE_ID = "560abba3-7881-4741-b538-ca416b58ba1e";
const VIEW_ID = "ca124b24-9a06-4b19-aeb3-1841a9c962e1";
const BASE = "https://kubra.io";

let requestCount = 0;

async function fetchJson(url) {
  requestCount++;

  const res = await fetch(url, {
    headers: {
      accept: "application/json,text/html,*/*",
      "user-agent": "Mozilla/5.0"
    }
  });

  if (!res.ok) {
    throw new Error(`FETCH FAILED URL: ${url} | ERROR: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`NOT JSON URL: ${url} | FIRST 300: ${text.slice(0, 300)}`);
  }
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

    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0;
    result = 0;

    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

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
  let quadkey = "";
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    quadkey += digit;
  }
  return quadkey;
}

function bbox(points) {
  const lats = points.map(p => p[0]);
  const lons = points.map(p => p[1]);

  return {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLon: Math.min(...lons),
    maxLon: Math.max(...lons)
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

    const geom = feature.geometry;
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;

    for (const poly of polys) {
      const ring = poly[0].map(([lng, lat]) => [lat, lng]);
      if (pointInRing([lat, lon], ring)) {
        return feature.properties.NAME;
      }
    }
  }

  return null;
}

async function fetchTexasCounties() {
  return fetchJson("https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json");
}

async function getKubraState() {
  return fetchJson(
    `${BASE}/stormcenter/api/v1/stormcenters/${INSTANCE_ID}/views/${VIEW_ID}/currentState?preview=false`
  );
}

async function getKubraConfig(deploymentId) {
  return fetchJson(
    `${BASE}/stormcenter/api/v1/stormcenters/${INSTANCE_ID}/views/${VIEW_ID}/configuration/${deploymentId}?preview=false`
  );
}

function getCustomerCount(desc) {
  const candidates = [
    desc?.cust_a?.val,
    desc?.cust_a,
    desc?.customers_affected,
    desc?.customersAffected,
    desc?.customersOut,
    desc?.n_out,
    desc?.outages
  ];

  for (const c of candidates) {
    const n = Number(String(c ?? "").replace(/,/g, "").replace(/[^\d.-]/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }

  return 0;
}

function outageFromRaw(raw, url, counties) {
  const desc = raw.desc || {};
  const encoded = raw.geom?.p?.[0];

  if (!encoded) return null;

  let decoded;
  try {
    decoded = decodePolyline(encoded);
  } catch {
    return null;
  }

  if (!decoded || !decoded[0]) return null;

  const [lat, lon] = decoded[0];
  const county = countyForPoint(lat, lon, counties);

  if (!county) return null;

  const customersOut = getCustomerCount(desc);

  return {
    state: "TX",
    county,
    utility: "Oncor",
    customersOut,
    incidents: 1,
    latitude: lat,
    longitude: lon,
    estimatedRestoration: desc?.etr || null,
    cause: desc?.cause?.["EN-US"] || desc?.cause || null,
    crewStatus: desc?.crew_status || null,
    updated: new Date().toISOString(),
    source: url
  };
}

async function main() {
  let sourceStatus = [];
  let countyRows = [];

  try {
    const counties = await fetchTexasCounties();
    const state = await getKubraState();

    const deploymentId = state.stormcenterDeploymentId;
    const config = await getKubraConfig(deploymentId);

    const regionKey = Object.keys(state.datastatic)[0];
    const regionsPath = state.datastatic[regionKey];
    const serviceAreasUrl =
      `${BASE}${regionsPath.startsWith("/") ? "" : "/"}${regionsPath}/${regionKey}/serviceareas.json`;

    const serviceAreas = await fetchJson(serviceAreasUrl);
    const encodedAreas = serviceAreas.file_data?.[0]?.geom?.a || [];

    let servicePoints = [];
    for (const encoded of encodedAreas) {
      servicePoints = servicePoints.concat(decodePolyline(encoded));
    }

    const bounds = bbox(servicePoints);

    const layerList = config?.config?.layers?.data?.interval_generation_data || [];
    const clusterLayer =
      layerList.find(l => String(l.type || "").includes("CLUSTER")) ||
      layerList.find(l => String(l.id || "").toLowerCase().includes("outage")) ||
      layerList[0];

    if (!clusterLayer) throw new Error("No KUBRA outage layer found in config");

    const layerId = clusterLayer.id;
    const clusterPath = state.data.cluster_interval_generation_data;
    const normalPath = state.data.interval_generation_data;

    const zoom = 7;
    const quadkeys = bboxQuadkeys(bounds, zoom);

    const rawOutages = [];

    for (const q of quadkeys) {
      const qkh = q.slice(-3).split("").reverse().join("");

      const urls = [
        `${BASE}${clusterPath.replace("{qkh}", qkh)}/public/${layerId}/${q}.json`,
        `${BASE}${normalPath.replace("{qkh}", qkh)}/public/${layerId}/${q}.json`
      ];

      for (const url of urls) {
        try {
          const json = await fetchJson(url);
          const rows = json.file_data || [];

          for (const raw of rows) {
            const outage = outageFromRaw(raw, url, counties);
            if (outage) rawOutages.push(outage);
          }
        } catch {
          // Missing tiles are normal.
        }
      }
    }

    const byCounty = new Map();

    for (const o of rawOutages) {
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
      row.customersOut += Number(o.customersOut || 0);
      row.incidents += 1;
    }

    countyRows = [...byCounty.values()]
      .filter(r => r.customersOut > 0 || r.incidents > 0)
      .sort((a, b) => b.customersOut - a.customersOut);

    sourceStatus.push({
      name: "Oncor KUBRA",
      ok: true,
      requests: requestCount,
      deploymentId,
      layerId,
      quadkeysChecked: quadkeys.length,
      rawOutages: rawOutages.length,
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
    totalCustomersOut: countyRows.reduce((s, o) => s + Number(o.customersOut || 0), 0),
    outages: countyRows
  };

  await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload.sourceStatus, null, 2));
  console.log(`Wrote ${payload.count} county records / ${payload.totalCustomersOut} customers out`);
}

main();
