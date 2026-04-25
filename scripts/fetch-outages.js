const fs = require("fs/promises");

const OUT = "outages.json";

const URL =
  "https://services.arcgis.com/BLN4oKB0N1YSgvY8/ArcGIS/rest/services/Power_Outages_%28View%29/FeatureServer/2/query" +
  "?where=1%3D1" +
  "&outFields=*" +
  "&returnGeometry=false" +
  "&f=json" +
  "&resultRecordCount=2000";

function num(v) {
  const n = Number(String(v ?? 0).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const json = await res.json();
  const features = json.features || [];

  console.log("Feature count:", features.length);
  console.log("First feature sample:", JSON.stringify(features[0], null, 2));

  const outages = features.map(f => {
    const a = f.attributes || {};
    return {
      state: "TX",
      county: String(a.NAME || "").replace(/ County$/i, "").trim(),
      utility: "Texas County Aggregate",
      customersOut: num(a.Number_Impacted_Customers),
      incidents: num(a.Number_Incidents),
      plannedCustomersOut: num(a.Impacted_Customers_Planned),
      unplannedCustomersOut: num(a.Impacted_Cutomers_Not_Planned),
      updated: new Date().toISOString(),
      source: "Texas county outage ArcGIS layer"
    };
  }).filter(r => r.county);

  const payload = {
    updated: new Date().toISOString(),
    count: outages.length,
    countiesWithOutages: outages.filter(o => o.customersOut > 0).length,
    totalCustomersOut: outages.reduce((s, o) => s + o.customersOut, 0),
    outages
  };

  await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log("Wrote outages.json");
  console.log("Total customers out:", payload.totalCustomersOut);
  console.log("Counties with outages:", payload.countiesWithOutages);
}

main().catch(async err => {
  console.error(err);
  await fs.writeFile(OUT, JSON.stringify({
    updated: new Date().toISOString(),
    error: err.message,
    count: 0,
    countiesWithOutages: 0,
    totalCustomersOut: 0,
    outages: []
  }, null, 2));
  process.exit(1);
});
