const fs = require("fs/promises");

const OUT = "outages.json";

const URL =
  "https://services1.arcgis.com/fXHQyq63u0UsTeSM/arcgis/rest/services/Power_Outage_Data/FeatureServer/0/query" +
  "?where=1%3D1" +
  "&outFields=*" +
  "&returnGeometry=true" +
  "&outSR=4326" +
  "&f=geojson" +
  "&resultRecordCount=2000";

async function main() {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const json = await res.json();

  const outages = (json.features || []).map((f) => {
    const p = f.properties || {};
    const coords = f.geometry?.coordinates || [null, null];

    return {
      state: "TX",
      county: "Unknown",
      utilityId: p.UtilityId ?? null,
      outageId: p.OutageId ?? null,
      customersOut: Number(p.CustomersOut || 0),
      outageCause: p.OutageCause || null,
      estimatedRestoration: p.EstimatedRestoration || null,
      dateTimeRecorded: p.DateTimeRecorded || null,
      lon: coords[0],
      lat: coords[1],
      updated: new Date().toISOString(),
      source: "TDIS Power_Outage_Data FeatureServer"
    };
  }).filter(o => o.customersOut > 0);

  const payload = {
    updated: new Date().toISOString(),
    sourceStatus: [{
      name: "TDIS Power Outage Data",
      ok: true,
      count: outages.length
    }],
    count: outages.length,
    totalCustomersOut: outages.reduce((s, o) => s + o.customersOut, 0),
    outages
  };

  await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${payload.count} outage records / ${payload.totalCustomersOut} customers out`);
}

main().catch(async err => {
  await fs.writeFile(OUT, JSON.stringify({
    updated: new Date().toISOString(),
    sourceStatus: [{
      name: "TDIS Power Outage Data",
      ok: false,
      error: err.message
    }],
    count: 0,
    totalCustomersOut: 0,
    outages: []
  }, null, 2));

  process.exitCode = 1;
});
