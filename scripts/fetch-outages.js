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

async function main() {
  let payload;

  try {
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

    const intervalLayers = config?.config?.layers?.data?.interval_generation_data || [];
    const clusterPath = state.data.cluster_interval_generation_data;
    const normalPath = state.data.interval_generation_data;

    const layerSummary = intervalLayers.map(l => ({
      id: l.id,
      type: l.type,
      name: l.name,
      enabled: l.enabled,
      visible: l.visible
    }));

    const tileSamples = [];

    for (let zoom = 7; zoom <= 12; zoom++) {
      const quadkeys = bboxQuadkeys(bounds, zoom).slice(0, 30);

      for (const layer of intervalLayers) {
        for (const q of quadkeys.slice(0, 8)) {
          const qkh = q.slice(-3).split("").reverse().join("");

          const urls = [
            `${BASE}${clusterPath.replace("{qkh}", qkh)}/public/${layer.id}/${q}.json`,
            `${BASE}${normalPath.replace("{qkh}", qkh)}/public/${layer.id}/${q}.json`
          ];

          for (const url of urls) {
            try {
              const json = await fetchJson(url);
              const rows = json.file_data || [];
              tileSamples.push({
                zoom,
                layerId: layer.id,
                layerType: layer.type,
                url,
                ok: true,
                rowCount: rows.length,
                firstRow: rows[0] || null
              });

              if (tileSamples.filter(s => s.rowCount > 0).length >= 10) break;
            } catch (err) {
              tileSamples.push({
                zoom,
                layerId: layer.id,
                layerType: layer.type,
                url,
                ok: false,
                error: String(err.message).slice(0, 160)
              });
            }
          }

          if (tileSamples.filter(s => s.rowCount > 0).length >= 10) break;
        }

        if (tileSamples.filter(s => s.rowCount > 0).length >= 10) break;
      }

      if (tileSamples.filter(s => s.rowCount > 0).length >= 10) break;
    }

    payload = {
      updated: new Date().toISOString(),
      note: "KUBRA layer/tile diagnostic. Send layerSummary and tileSamples with rowCount > 0.",
      sourceStatus: [{
        name: "Oncor KUBRA diagnostic",
        ok: true,
        requests: requestCount,
        deploymentId,
        regionKey,
        bounds,
        clusterPath,
        normalPath
      }],
      layerSummary,
      successfulTileSamples: tileSamples.filter(s => s.ok && s.rowCount > 0),
      failedSampleCount: tileSamples.filter(s => !s.ok).length,
      count: 0,
      totalCustomersOut: 0,
      outages: []
    };
  } catch (err) {
    payload = {
      updated: new Date().toISOString(),
      note: "KUBRA diagnostic failed.",
      sourceStatus: [{
        name: "Oncor KUBRA diagnostic",
        ok: false,
        error: err.message,
        requests: requestCount
      }],
      count: 0,
      totalCustomersOut: 0,
      outages: []
    };
  }

  await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
}

main();
