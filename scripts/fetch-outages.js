const fs = require("fs/promises");

const OUT = "outages.json";

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      accept: "text/html,application/javascript,application/json,*/*",
      "user-agent": "Mozilla/5.0"
    }
  });

  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

function uniq(arr) {
  return [...new Set(arr)].filter(Boolean);
}

async function main() {
  const pageUrl = "https://stormcenter.oncor.com/reports/8a3a0248-66cb-4e05-b7d8-649e570562d5";
  const html = await fetchText(pageUrl);

  const scriptUrls = uniq(
    [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1])
  ).map(src => src.startsWith("http") ? src : new URL(src, pageUrl).href);

  console.log("SCRIPT URLS:", scriptUrls);

  const findings = [];

  for (const scriptUrl of scriptUrls) {
    try {
      const js = await fetchText(scriptUrl);

      const urls = uniq([
        ...[...js.matchAll(/https?:\/\/[^"'\\\s)]+/g)].map(m => m[0]),
        ...[...js.matchAll(/\/[A-Za-z0-9_\-./{}?=&:%]+\.json/g)].map(m => m[0]),
        ...[...js.matchAll(/[A-Za-z0-9_\-./{}?=&:%]+thematic[A-Za-z0-9_\-./{}?=&:%]*/gi)].map(m => m[0]),
        ...[...js.matchAll(/[A-Za-z0-9_\-./{}?=&:%]+outage[A-Za-z0-9_\-./{}?=&:%]*/gi)].map(m => m[0]),
        ...[...js.matchAll(/[A-Za-z0-9_\-./{}?=&:%]+incident[A-Za-z0-9_\-./{}?=&:%]*/gi)].map(m => m[0])
      ]);

      findings.push({
        scriptUrl,
        length: js.length,
        interestingMatches: urls.slice(0, 100)
      });

      console.log("SCRIPT:", scriptUrl);
      console.log("LENGTH:", js.length);
      console.log("MATCHES:", urls.slice(0, 50));
    } catch (err) {
      findings.push({
        scriptUrl,
        error: err.message
      });
    }
  }

  const payload = {
    updated: new Date().toISOString(),
    note: "KUBRA endpoint discovery diagnostic. Send ChatGPT the interestingMatches output.",
    pageUrl,
    scriptUrls,
    findings,
    count: 0,
    totalCustomersOut: 0,
    outages: []
  };

  await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log("Wrote KUBRA discovery diagnostic");
}

main().catch(async err => {
  await fs.writeFile(OUT, JSON.stringify({
    updated: new Date().toISOString(),
    error: err.message,
    outages: []
  }, null, 2));

  process.exitCode = 1;
});
