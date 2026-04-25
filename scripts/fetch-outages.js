const fs = require("fs/promises");

const OUT = "outages.json";

const VALID_TX_COUNTIES = new Set([
  "Archer","Bell","Brown","Collin","Dallas","Denton","Ellis","Erath","Grayson",
  "Hood","Hunt","Johnson","Kaufman","McLennan","Midland","Parker","Rockwall",
  "Smith","Tarrant","Taylor","Wichita","Wise"
]);

function num(v) {
  const n = Number(String(v ?? "").replace(/,/g, "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function cleanCounty(v) {
  return String(v || "").replace(/\s+County$/i, "").trim();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json,text/html,*/*",
      "user-agent": "Mozilla/5.0"
    }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

async function fetchJson(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
}

function findIds(html) {
  const instanceId = html.match(/instanceId:\s*'([^']+)'/)?.[1];
  const viewId = html.match(/viewId:\s*'([^']+)'/)?.[1];
  return { instanceId, viewId };
}

function walk(obj, records = []) {
  if (!obj || typeof obj !== "object") return records;

  if (Array.isArray(obj)) {
    obj.forEach(x => walk(x, records));
    return records;
  }

  const keys = Object.keys(obj);
  const lower = Object.fromEntries(keys.map(k => [k.toLowerCase(), k]));

  const countyKey = lower.county || lower.countyname || lower.name || lower.area || lower.region;
  const affectedKey =
    lower.customersaffected ||
    lower.customersout ||
    lower.outages ||
    lower.affected ||
    lower.customer_count ||
    lower.customers;

  if (countyKey && affectedKey) {
    records.push(obj);
  }

  keys.forEach(k => walk(obj[k], records));
  return records;
}

async function fetchOncorKubra() {
  const pageUrl = "https://stormcenter.oncor.com/";
  const html = await fetchText(pageUrl);
  const { instanceId } = findIds(html);

  if (!instanceId) {
    throw new Error("Could not find Oncor KUBRA instanceId");
  }

  const candidateUrls = [
    `https://kubra.io/data/${instanceId}/public/thematic-1/thematic_areas.json`,
    `https://kubra.io/data/${instanceId}/public/summary.json`,
    `https://kubra.io/data/${instanceId}/public/config.json`,
    `https://kubra.io/data/${instanceId}/public/metadata.json`
  ];

  const outages = [];
  const debug = [];

  for (const url of candidateUrls) {
    try {
      const json = await fetchJson(url);
      debug.push({ url, ok: true });

      const found = walk(json);

      for (const row of found) {
        const county =
          cleanCounty(row.county || row.County || row.countyName || row.CountyName || row.name || row.Name);

        if (!VALID_TX_COUNTIES.has(county)) continue;

        const customersOut = num(
          row.customersAffected ??
          row.CustomersAffected ??
          row.customersOut ??
          row.CustomersOut ??
          row.affected ??
          row.Affected ??
          row.outages ??
          row.Outages
        );

        if (customersOut <= 0) continue;

        outages.push({
          state: "TX",
          county,
          utility: "Oncor",
          customersOut,
          updated: new Date().toISOString(),
          source: url
        });
      }
    } catch (err) {
      debug.push({ url, ok: false, error: err.message });
    }
  }

  return { outages, debug, instanceId };
}

function merge(records) {
  const map = new Map();

  for (const r of records) {
    const key = `${r.utility}|${r.county}`;
    if (!map.has(key)) map.set(key, { ...r });
    else map.get(key).customersOut += r.customersOut;
  }

  return [...map.values()].sort((a, b) => b.customersOut - a.customersOut);
}

async function main() {
  const sourceStatus = [];
  let all = [];

  try {
    const result = await fetchOncorKubra();
    all.push(...result.outages);
    sourceStatus.push({
      name: "Oncor KUBRA",
      ok: true,
      count: result.outages.length,
      instanceId: result.instanceId,
      tried: result.debug
    });
  } catch (err) {
    sourceStatus.push({
      name: "Oncor KUBRA",
      ok: false,
      count: 0,
      error: err.message
    });
  }

  const outages = merge(all);

  const payload = {
    updated: new Date().toISOString(),
    note: "Texas outage feed using Oncor KUBRA data probe.",
    sourceStatus,
    count: outages.length,
    countiesWithOutages: new Set(outages.map(o => o.county)).size,
    totalCustomersOut: outages.reduce((s, o) => s + o.customersOut, 0),
    outages
  };

  await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload.sourceStatus, null, 2));
  console.log(`Wrote ${payload.count} records / ${payload.totalCustomersOut} customers out`);
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
