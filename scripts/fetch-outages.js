const fs = require("fs/promises");

const OUT = "outages.json";

const INSTANCE_ID = "560abba3-7881-4741-b538-ca416b58ba1e";
const VIEW_ID = "ca124b24-9a06-4b19-aeb3-1841a9c962e1";
const BASE = "https://kubra.io";
const MIN_ZOOM = 7;
const MAX_ZOOM = 14;
const MAX_REQUESTS = 2500;

let requestCount = 0;

async function fetchJson(url) {
  requestCount++;
  if (requestCount > MAX_REQUESTS) throw new Error("Request limit hit");

  const res = await fetch(url, {
    headers: {
      accept: "application/json,text/html,*/*",
      "user-agent": "Mozilla/5.0"
    }
  });

  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const text = await res.text();
  return JSON.parse(text);
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

function quadkeyToTile(q) {
  let x = 0, y = 0;
  const z = q.length;

  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    const digit = Number(q[z - i]);

    if (digit & 1) x |= mask;
    if (digit & 2) y |= mask;
  }

  return { x, y, z };
}

function neighbors(q) {
  const t = quadkeyToTile(q);
  const shifts = [
    [0,-1],[1,0],[0,1],[-1,0],
    [1,-1],[1,1],[-1,-1],[-1,1]
  ];

  return shifts
    .map(([dx, dy]) => ({ x: t.x + dx, y: t.y + dy, z: t.z }))
    .filter(t => t.x >= 0 && t.y >= 0)
    .map(t => tileToQuadkey(t.x, t.y, t.z));
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
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);

    if (intersect) inside = !inside;
  }

  return inside;
}

function countyForPoint(lat, lon, counties) {
  for (const feature of counties.features) {
    if (feature.properties.STATE !== "48") continue;

    const geom = feature.geometry;
    if (!geom) continue;

    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;

    for (const poly of polys) {
      const outer = poly[0].map(([lng, lat]) => [lat, lng]);
      if (pointInRing([lat, lon], outer)) {
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
  const url = `${BASE}/stormcenter/api/v1/stormcenters/${INSTANCE_ID}/views/${VIEW_ID}/currentState?preview=false`;
  return fetchJson(url);
}

async function getKubraConfig(deploymentId) {
  const url = `${BASE}/stormcenter/api/v1/stormcenters/${INSTANCE_ID}/views/${VIEW_ID}/configuration/${deploymentId}?preview=false`;
  return fetchJson(url);
}

function getQuadkeyForPolyline(encodedPoint, zoom) {
  const pt = decodePolyline(encodedPoint)[0];
  return tileToQuadkey(lon2tile(pt[1], zoom), lat2tile(pt[0], zoom), zoom);
}

function outageFromRaw(raw, sourceUrl, counties) {
  const desc = raw.desc || {};
  const decoded = raw.geom?.p?.[0] ? decodePolyline(raw.geom.p[0]) : null;
  if (!decoded || !decoded[0]) return null;

  const [lat, lon] = decoded[0];
  const county = countyForPoint(lat, lon, counties);
  if (!county) return null;

  const customersOut =
    desc.cust_a?.val ??
    desc.n_out ??
    desc.numberOut ??
    0;

  return {
    state: "TX",
    county,
    utility: "Oncor",
    customersOut: Number(customersOut) || 0,
    incidents: Number(desc.n_out || 1) || 1,
    latitude: lat,
    longitude: lon,
    cause: desc.cause?.["EN-US"] || null,
    crewStatus: desc.crew_status || null,
    estimatedRestoration: desc.etr || null,
    startTime: desc.start_time || null,
    updated: new Date().toISOString(),
    source: sourceUrl
  };
}

async function scrapeTileData(quadkeys, alreadySeen, paths, layerName, counties, zoom = MIN_ZOOM) {
  const outages = new Map();

  for (const q of quadkeys) {
    const dataPath = paths.clusterDataPath.replace("{qkh}", q.slice(-3).split("").reverse().join(""));
    const url = `${BASE}${dataPath}/public/${layerName}/${q}.json`;

    if (alreadySeen.has(url)) continue;
    alreadySeen.add(url);

    let json;

    try {
      json = await fetchJson(url);
    } catch {
      continue;
    }

    for (const raw of json.file_data || []) {
      const isCluster = Boolean(raw.desc?.cluster);

      if (isCluster && zoom < MAX_ZOOM && raw.geom?.p?.[0]) {
        const nextQ = getQuadkeyForPolyline(raw.geom.p[0], zoom + 1);
        const deeper = await scrapeTileData([nextQ], alreadySeen, paths, layerName, counties, zoom + 1);

        for (const o of deeper.values()) outages.set(`${o.latitude},${o.longitude},${o.startTime}`, o);
      } else if (isCluster && zoom < MAX_ZOOM) {
        const deeper = await scrapeTileData(neighbors(q), alreadySeen, paths, layerName, counties, zoom + 1);

        for (const o of deeper.values()) outages.set(`${o.latitude},${o.longitude},${o.startTime}`, o);
      } else {
        const outage = outageFromRaw(raw, url, counties);
        if (outage && outage.customersOut > 0) {
          outages.set(`${outage.latitude},${outage.longitude},${outage.startTime}`, outage);
        }
      }
    }
  }

  return outages;
}

function aggregateByCounty(records) {
  const map = new Map();

  for (const r of records) {
    const key = r.county;

    if (!map.has(key)) {
      map.set(key, {
        state: "TX",
        county: r.county,
        utility: "Oncor",
        customersOut: 0,
        incidents: 0,
        updated: new Date().toISOString(),
        source: "Oncor KUBRA tile aggregation"
      });
    }

    const row = map.get(key);
    row.customersOut += Number(r.customersOut || 0);
    row.incidents += Number(r.incidents || 1);
  }

  return [...map.values()].sort((a, b) => b.customersOut - a.customersOut);
}

async function main() {
  const sourceStatus = [];
  let outages = [];

  try {
    const counties = await fetchTexasCounties();
    const state = await getKubraState();

    const regionKey = Object.keys(state.datastatic || {})[0];
    const regionsPath = state.datastatic[regionKey];

    const dataPath = state.data.interval_generation_data;
    const clusterDataPath = state.data.cluster_interval_generation_data;
    const deploymentId = state.stormcenterDeploymentId;

    const config = await getKubraConfig(deploymentId);

    const intervalLayers = config.config.layers.data.interval_generation_data;
    const clusterLayer = intervalLayers.find(l => String(l.type || "").startsWith("CLUSTER_LAYER"));

    if (!clusterLayer) throw new Error("Could not find KUBRA cluster layer");

    const serviceAreas = await fetchJson(`${BASE}${regionsPath}/${regionKey}/serviceareas.json`);
    const encodedAreas = serviceAreas.file_data?.[0]?.geom?.a || [];

    let servicePoints = [];
    for (const encoded of encodedAreas) {
      servicePoints = servicePoints.concat(decodePolyline(encoded));
    }

    const bounds = bbox(servicePoints);
    const quadkeys = bboxQuadkeys(bounds, MIN_ZOOM);

    const rawOutages = await scrapeTileData(
      quadkeys,
      new Set(),
      { dataPath, clusterDataPath },
      clusterLayer.id,
      counties
    );

    outages = aggregateByCounty([...rawOutages.values()]);

    sourceStatus.push({
      name: "Oncor KUBRA tile scrape",
      ok: true,
      countyRecords: outages.length,
      rawOutages: rawOutages.size,
      requests: requestCount,
      layerName: clusterLayer.id,
      deploymentId
    });
  } catch (err) {
    sourceStatus.push({
      name: "Oncor KUBRA tile scrape",
      ok: false,
      error: err.message,
      requests: requestCount
    });
  }

  const payload = {
    updated: new Date().toISOString(),
    note: "Texas outage file generated from Oncor KUBRA tile data.",
    sourceStatus,
    count: outages.length,
    countiesWithOutages: new Set(outages.map(o => o.county)).size,
    totalCustomersOut: outages.reduce((s, o) => s + o.customersOut, 0),
    outages
  };

  await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload.sourceStatus, null, 2));
  console.log(`Wrote ${payload.count} county records / ${payload.totalCustomersOut} customers out`);
}

main().catch(async err => {
  await fs.writeFile(OUT, JSON.stringify({
    updated: new Date().toISOString(),
    error: err.message,
    count: 0,
    totalCustomersOut: 0,
    outages: []
  }, null, 2));

  process.exitCode = 1;
});
