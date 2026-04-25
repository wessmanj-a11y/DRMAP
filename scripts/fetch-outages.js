const fs = require("fs/promises");

const OUT = "outages.json";

const VALID_TX_COUNTIES = new Set([
  "Archer","Bell","Brown","Collin","Dallas","Denton","Ellis","Erath","Grayson",
  "Hood","Hunt","Johnson","Kaufman","McLennan","Midland","Parker","Rockwall",
  "Smith","Tarrant","Taylor","Wichita","Wise"
]);

function num(v) {
  const n = Number(String(v || "").replace(/,/g, "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      accept: "text/html,*/*",
      "user-agent": "Mozilla/5.0"
    }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

async function fetchOncorCountyReport() {
  const url = "https://stormcenter.oncor.com/%C2%A0/reports/8a3a0248-66cb-4e05-b7d8-649e570562d5";
  const html = await fetchText(url);

  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const records = [];

  for (const county of VALID_TX_COUNTIES) {
    const re = new RegExp(`${county}\\s+(\\d[\\d,]*)\\s+(\\d[\\d,]*)`, "i");
    const match = text.match(re);

    if (match) {
      records.push({
        state: "TX",
        county,
        utility: "Oncor",
        customersOut: num(match[1]),
        customersTracked: num(match[2]),
        updated: new Date().toISOString(),
        source: "Oncor county report"
      });
    }
  }

  return records.filter(r => r.customersOut > 0);
}

async function main() {
  let outages = [];
  let sourceStatus = [];

  try {
    const oncor = await fetchOncorCountyReport();
    outages.push(...oncor);
    sourceStatus.push({ name: "Oncor", ok: true, count: oncor.length });
  } catch (err) {
    sourceStatus.push({ name: "Oncor", ok: false, count: 0, error: err.message });
  }

  const payload = {
    updated: new Date().toISOString(),
    sourceStatus,
    count: outages.length,
    countiesWithOutages: new Set(outages.map(o => o.county)).size,
    totalCustomersOut: outages.reduce((s, o) => s + o.customersOut, 0),
    outages
  };

  await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${payload.count} records / ${payload.totalCustomersOut} customers out`);
}

main();
