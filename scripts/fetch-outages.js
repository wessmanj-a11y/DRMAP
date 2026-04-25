const fs = require("fs/promises");

const OUT = "outages.json";

const TEXAS_COUNTY_OUTAGE_URL =
  "https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/Power_Outages_%28View%29/FeatureServer/2/query" +
  "?where=1%3D1" +
  "&outFields=NAME,Number_Impacted_Customers,Number_Incidents,Impacted_Customers_Planned,Impacted_Cutomers_Not_Planned" +
  "&returnGeometry=true" +
  "&f=geojson" +
  "&resultRecordCount=2000";

function centroid(coords) {
  let points = [];

  function flatten(arr) {
    if (typeof arr[0] === "number") {
      points.push(arr);
    } else {
      arr.forEach(flatten);
    }
  }

  flatten(coords);

  const valid = points.filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!valid.length) return [31, -99];

  const lon = valid.reduce((s, p) => s + p[0], 0) / valid.length;
  const lat = valid.reduce((s, p) => s + p[1], 0) / valid.length;

  return [lat, lon];
}

function num(value) {
  const n = Number(String(value ?? 0).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function fetchTexasCountyOutages() {
  const res = await fetch(TEXAS_COUNTY_OUTAGE_URL, {
    headers: { accept: "application/json" }
  });

  if (!res.ok) {
    throw new Error(`Texas county outage layer failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();

  return (json.features || [])
    .map(feature => {
      const p = feature.properties || {};
      const county = String(p.NAME || "").replace(/ County$/i, "").trim();

      const customersOut = num(p.Number_Impacted_Customers);
      const incidents = num(p.Number_Incidents);
      const planned = num(p.Impacted_Customers_Planned);
      const unplanned = num(p.Impacted_Cutomers_Not_Planned);

      const [lat, lon] = feature.geometry
        ? centroid(feature.geometry.coordinates)
        : [31, -99];

      return {
        state: "TX",
        county,
        utility: "Texas County Aggregate",
        customersOut,
        customersTracked: 0,
        incidents,
        plannedCustomersOut: planned,
        unplannedCustomersOut: unplanned,
        lat,
        lon,
        updated: new Date().toISOString(),
        source: "Texas county outage ArcGIS layer"
      };
    })
    .filter(r => r.county && r.customersOut > 0);
}

async function main() {
  let outages = [];
  let sourceStatus = [];

  try {
    outages = await fetchTexasCountyOutages();
    sourceStatus.push({
      name: "Texas county outage ArcGIS layer",
      ok: true,
      count: outages.length
    });
  } catch (err) {
    sourceStatus.push({
      name: "Texas county outage ArcGIS layer",
      ok: false,
      error: err.message
    });
  }

  const payload = {
    updated: new Date().toISOString(),
    count: outages.length,
    totalCustomersOut: outages.reduce((s, o) => s + o.customersOut, 0),
    sourceStatus,
    outages
  };

  await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${outages.length} outage records / ${payload.totalCustomersOut} customers out`);
}

main();
