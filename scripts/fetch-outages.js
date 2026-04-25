const fs = require("fs/promises");

const OUT = "outages.json";

async function fetchAny(url){
  const res = await fetch(url, {
    headers: {
      accept: "application/json,text/html,*/*",
      "user-agent": "TexasEmergencyDashboard/1.0"
    }
  });

  if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const text = await res.text();

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------- ONCOR DIAGNOSTIC ----------
async function fetchOncorReports(){
  const url = "https://stormcenter.oncor.com/reports/8a3a0248-66cb-4e05-b7d8-649e570562d5";

  try{
    const html = await fetchAny(url);

    console.log("ONCOR HTML LENGTH:", String(html).length);
    console.log("ONCOR FIRST 1500 CHARS:");
    console.log(String(html).slice(0,1500));

    return [];
  }catch(e){
    console.log("Oncor failed:", e.message);
    return [];
  }
}

// ---------- MAIN ----------
async function main(){
  const oncor = await fetchOncorReports();

  const payload = {
    updated: new Date().toISOString(),
    note: "Diagnostic run. Check GitHub Action logs for ONCOR HTML output.",
    count: oncor.length,
    totalCustomersOut: 0,
    outages: oncor
  };

  await fs.writeFile(OUT, JSON.stringify(payload, null, 2));

  console.log("Wrote diagnostic outages.json");
}

main().catch(async err => {
  console.error(err);

  await fs.writeFile(OUT, JSON.stringify({
    updated: new Date().toISOString(),
    error: err.message,
    count: 0,
    totalCustomersOut: 0,
    outages: []
  }, null, 2));

  process.exitCode = 1;
});
