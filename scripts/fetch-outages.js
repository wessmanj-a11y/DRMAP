const fs = require("fs/promises");

const OUT = "outages.json";

const INSTANCE_ID = "560abba3-7881-4741-b538-ca416b58ba1e";
const VIEW_ID = "ca124b24-9a06-4b19-aeb3-1841a9c962e1";

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

async function tryUrl(url) {
  try {
    const text = await fetchText(url);
    return {
      url,
      ok: true,
      length: text.length,
      sample: text.slice(0, 500)
    };
  } catch (err) {
    return {
      url,
      ok: false,
      error: err.message
    };
  }
}

async function main() {
  const candidates = [];

  const bases = [
    `https://kubra.io/stormcenter/api/v1/stormcenters/${INSTANCE_ID}/views/${VIEW_ID}`,
    `https://kubra.io/stormcenter/api/v1/views/${VIEW_ID}`,
    `https://kubra.io/api/v1/stormcenters/${INSTANCE_ID}/views/${VIEW_ID}`,
    `https://kubra.io/data/${INSTANCE_ID}/${VIEW_ID}`,
    `https://kubra.io/data/${INSTANCE_ID}/views/${VIEW_ID}`,
    `https://kubra.io/data/${VIEW_ID}`,
    `https://kubra.io/stormcenter/views/${VIEW_ID}`
  ];

  const suffixes = [
    "",
    "/configuration.json",
    "/config.json",
    "/metadata.json",
    "/outages.json",
    "/outages",
    "/incidents.json",
    "/incidents",
    "/clusters.json",
    "/clusters",
    "/areas.json",
    "/areas",
    "/summary.json",
    "/summary",
    "/public/outages.json",
    "/public/summary.json",
    "/public/metadata.json"
  ];

  for (const base of bases) {
    for (const suffix of suffixes) {
      candidates.push(base + suffix);
    }
  }

  const results = [];
  for (const url of candidates) {
    results.push(await tryUrl(url));
  }

  const payload = {
    updated: new Date().toISOString(),
    note: "KUBRA endpoint probe. Look for ok:true with JSON-like samples.",
    instanceId: INSTANCE_ID,
    viewId: VIEW_ID,
    results,
    outages: []
  };

  await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log("Probe complete");
  console.log(JSON.stringify(results.filter(r => r.ok), null, 2));
}

main();
