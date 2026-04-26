const fs = require("fs/promises");

const OUT = "outages.json";

const INSTANCE_ID = "560abba3-7881-4741-b538-ca416b58ba1e";
const VIEW_ID = "ca124b24-9a06-4b19-aeb3-1841a9c962e1";
const BASE = "https://kubra.io";
const MIN_ZOOM = 7;
const MAX_ZOOM = 14;
const MAX_REQUESTS = 2500;

let requestCount = 0;

// 🔥 FULL DEBUG FETCH
async function fetchJson(url) {
  requestCount++;

  try {
    const res = await fetch(url, {
      headers: {
        accept: "application/json,text/html,*/*",
        "user-agent": "Mozilla/5.0"
      }
    });

    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}`);
    }

    const text = await res.text();

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Not JSON. First 300 chars: ${text.slice(0, 300)}`);
    }

  } catch (err) {
    throw new Error(`FETCH FAILED URL: ${url} | ERROR: ${err.message}`);
  }
}

// --- UTILS ---
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
    if (x & mask) digit++;
    if (y & mask) digit += 2;
    quadkey += digit;
  }
  return quadkey;
}

// --- DATA SOURCES ---
async function fetchTexasCounties() {
  return fetchJson("https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json");
}

async function getKubraState() {
  return fetchJson(`${BASE}/stormcenter/api/v1/stormcenters/${INSTANCE_ID}/views/${VIEW_ID}/currentState?preview=false`);
}

async function getKubraConfig(deploymentId) {
  return fetchJson(`${BASE}/stormcenter/api/v1/stormcenters/${INSTANCE_ID}/views/${VIEW_ID}/configuration/${deploymentId}?preview=false`);
}

// --- MAIN ---
async function main() {
  let outages = [];
  let sourceStatus = [];

  try {
    console.log("STEP 1: Texas counties");
    const counties = await fetchTexasCounties();

    console.log("STEP 2: KUBRA currentState");
    const state = await getKubraState();

    console.log("STEP 3: config");
    const deploymentId = state.stormcenterDeploymentId;
    const config = await getKubraConfig(deploymentId);

    console.log("STEP 4: extracting paths");

    const regionKey = Object.keys(state.datastatic)[0];
    const regionsPath = state.datastatic[regionKey];

    const serviceAreasUrl = `${BASE}${regionsPath}/${regionKey}/serviceareas.json`;

    console.log("STEP 5: service areas", serviceAreasUrl);
    const serviceAreas = await fetchJson(serviceAreasUrl);

    sourceStatus.push({
      name: "Oncor KUBRA",
      ok: true,
      requests: requestCount,
      note: "Reached service areas successfully"
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
    sourceStatus,
    count: 0,
    totalCustomersOut: 0,
    outages: []
  };

  await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
}

main();
