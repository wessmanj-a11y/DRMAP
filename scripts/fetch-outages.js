const fs = require("fs/promises");
const path = require("path");

const OUT = path.join(process.cwd(), "data", "outages.json");

const STATES = {
  AL:["Alabama",32.8,-86.8], AK:["Alaska",64.2,-149.5], AZ:["Arizona",34.3,-111.7], AR:["Arkansas",35.0,-92.4],
  CA:["California",37.2,-119.7], CO:["Colorado",39.0,-105.5], CT:["Connecticut",41.6,-72.7], DE:["Delaware",39.0,-75.5],
  FL:["Florida",28.6,-82.4], GA:["Georgia",32.7,-83.4], HI:["Hawaii",20.8,-156.3], ID:["Idaho",44.2,-114.5],
  IL:["Illinois",40.0,-89.2], IN:["Indiana",40.0,-86.1], IA:["Iowa",42.0,-93.4], KS:["Kansas",38.5,-98.0],
  KY:["Kentucky",37.5,-85.3], LA:["Louisiana",31.0,-92.0], ME:["Maine",45.3,-69.0], MD:["Maryland",39.0,-76.7],
  MA:["Massachusetts",42.3,-71.8], MI:["Michigan",44.3,-85.6], MN:["Minnesota",46.3,-94.2], MS:["Mississippi",32.7,-89.7],
  MO:["Missouri",38.5,-92.5], MT:["Montana",46.9,-110.4], NE:["Nebraska",41.5,-99.8], NV:["Nevada",39.5,-116.9],
  NH:["New Hampshire",43.7,-71.6], NJ:["New Jersey",40.1,-74.5], NM:["New Mexico",34.4,-106.1], NY:["New York",42.9,-75.0],
  NC:["North Carolina",35.5,-79.4], ND:["North Dakota",47.5,-100.5], OH:["Ohio",40.3,-82.8], OK:["Oklahoma",35.6,-97.5],
  OR:["Oregon",44.0,-120.5], PA:["Pennsylvania",40.9,-77.8], RI:["Rhode Island",41.7,-71.5], SC:["South Carolina",33.9,-80.9],
  SD:["South Dakota",44.4,-100.2], TN:["Tennessee",35.8,-86.4], TX:["Texas",31.0,-99.0], UT:["Utah",39.3,-111.7],
  VT:["Vermont",44.0,-72.7], VA:["Virginia",37.5,-78.7], WA:["Washington",47.4,-120.7], WV:["West Virginia",38.6,-80.6],
  WI:["Wisconsin",44.5,-89.5], WY:["Wyoming",43.0,-107.6], DC:["District of Columbia",38.9,-77.0]
};

function pick(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
  }
  return "";
}

function numberValue(obj, keys) {
  const value = pick(obj, keys);
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function stateAbbr(value) {
  if (!value) return "";
  const raw = String(value).trim();
  if (raw.length === 2 && STATES[raw.toUpperCase()]) return raw.toUpperCase();

  const found = Object.entries(STATES).find(([, info]) => info[0].toLowerCase() === raw.toLowerCase());
  return found ? found[0] : "";
}

function geoPoint(record, abbr) {
  const geo = record.geo_point_2d || record.geopoint || record.location || record.coordinates;
  if (Array.isArray(geo) && geo.length >= 2) return [Number(geo[0]), Number(geo[1])];
  if (geo && typeof geo === "object") {
    const lat = Number(geo.lat || geo.latitude);
    const lon = Number(geo.lon || geo.lng || geo.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return [lat, lon];
  }
  if (STATES[abbr]) return [STATES[abbr][1], STATES[abbr][2]];
  return [null, null];
}

async function tryFetch(url) {
  const res = await fetch(url, { headers: { "accept": "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  const urls = [
    "https://openenergyhub.ornl.gov/api/explore/v2.1/catalog/datasets/odin-real-time-outages-county/records?limit=100",
    "https://ornl.opendatasoft.com/api/explore/v2.1/catalog/datasets/odin-real-time-outages-county/records?limit=100"
  ];

  let records = [];
  let lastError = null;

  for (const url of urls) {
    try {
      const json = await tryFetch(url);
      if (Array.isArray(json.results)) records = json.results;
      else if (Array.isArray(json.records)) records = json.records.map(r => r.fields || r);
      else if (Array.isArray(json.features)) records = json.features.map(f => f.properties || f.attributes || {});
      if (records.length) break;
    } catch (err) {
      lastError = err;
      console.warn(`Failed ${url}: ${err.message}`);
    }
  }

  const outages = records.map(raw => {
    const r = raw.fields || raw.properties || raw;
    const abbr = stateAbbr(pick(r, ["state", "state_abbreviation", "state_code", "state_id", "state_name", "st"]));
    const [lat, lon] = geoPoint(r, abbr);
    return {
      state: abbr,
      county: String(pick(r, ["county", "county_name", "countyname", "county_nam", "admin2", "geography"]) || "Unknown county"),
      customersOut: numberValue(r, ["customers_out", "customer_out", "customers_affected", "customer_affected", "outage_count", "outages", "num_out", "sum_customers_out"]),
      customersTracked: numberValue(r, ["customers_tracked", "customers_served", "customer_count", "total_customers", "customers_total"]),
      frequency: numberValue(r, ["frequency", "outage_frequency", "record_count", "count"]) || 1,
      updated: String(pick(r, ["last_updated", "updated", "timestamp", "datetime", "date"]) || new Date().toISOString()),
      lat,
      lon
    };
  }).filter(o => o.state && Number.isFinite(o.lat) && Number.isFinite(o.lon));

  const payload = {
    updated: new Date().toISOString(),
    source: "DOE/ORNL ODIN county outage dataset",
    sourceStatus: outages.length ? "ok" : `no records${lastError ? ": " + lastError.message : ""}`,
    count: outages.length,
    outages
  };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${outages.length} outage records to ${OUT}`);
}

main().catch(async err => {
  console.error(err);
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify({
    updated: new Date().toISOString(),
    source: "DOE/ORNL ODIN county outage dataset",
    sourceStatus: "failed: " + err.message,
    count: 0,
    outages: []
  }, null, 2));
});
