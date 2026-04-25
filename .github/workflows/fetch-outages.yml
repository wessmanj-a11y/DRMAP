const fs = require("fs/promises");

const OUT = "outages.json";

const VALID_TX_COUNTIES = new Set([
  "Anderson","Andrews","Angelina","Aransas","Archer","Armstrong","Atascosa","Austin","Bailey","Bandera","Bastrop","Baylor","Bee","Bell","Bexar","Blanco","Borden","Bosque","Bowie","Brazoria","Brazos","Brewster","Briscoe","Brooks","Brown","Burleson","Burnet","Caldwell","Calhoun","Callahan","Cameron","Camp","Carson","Cass","Castro","Chambers","Cherokee","Childress","Clay","Cochran","Coke","Coleman","Collin","Collingsworth","Colorado","Comal","Comanche","Concho","Cooke","Coryell","Cottle","Crane","Crockett","Crosby","Culberson","Dallam","Dallas","Dawson","Deaf Smith","Delta","Denton","DeWitt","Dickens","Dimmit","Donley","Duval","Eastland","Ector","Edwards","El Paso","Ellis","Erath","Falls","Fannin","Fayette","Fisher","Floyd","Foard","Fort Bend","Franklin","Freestone","Frio","Gaines","Galveston","Garza","Gillespie","Glasscock","Goliad","Gonzales","Gray","Grayson","Gregg","Grimes","Guadalupe","Hale","Hall","Hamilton","Hansford","Hardeman","Hardin","Harris","Harrison","Hartley","Haskell","Hays","Hemphill","Henderson","Hidalgo","Hill","Hockley","Hood","Hopkins","Houston","Howard","Hudspeth","Hunt","Hutchinson","Irion","Jack","Jackson","Jasper","Jeff Davis","Jefferson","Jim Hogg","Jim Wells","Johnson","Jones","Karnes","Kaufman","Kendall","Kenedy","Kent","Kerr","Kimble","King","Kinney","Kleberg","Knox","La Salle","Lamar","Lamb","Lampasas","Lavaca","Lee","Leon","Liberty","Limestone","Lipscomb","Live Oak","Llano","Loving","Lubbock","Lynn","Madison","Marion","Martin","Mason","Matagorda","Maverick","McCulloch","McLennan","McMullen","Medina","Menard","Midland","Milam","Mills","Mitchell","Montague","Montgomery","Moore","Morris","Motley","Nacogdoches","Navarro","Newton","Nolan","Nueces","Ochiltree","Oldham","Orange","Palo Pinto","Panola","Parker","Parmer","Pecos","Polk","Potter","Presidio","Rains","Randall","Reagan","Real","Red River","Reeves","Refugio","Roberts","Robertson","Rockwall","Runnels","Rusk","Sabine","San Augustine","San Jacinto","San Patricio","San Saba","Schleicher","Scurry","Shackelford","Shelby","Sherman","Smith","Somervell","Starr","Stephens","Sterling","Stonewall","Sutton","Swisher","Tarrant","Taylor","Terrell","Terry","Throckmorton","Titus","Tom Green","Travis","Trinity","Tyler","Upshur","Upton","Uvalde","Val Verde","Van Zandt","Victoria","Walker","Waller","Ward","Washington","Webb","Wharton","Wheeler","Wichita","Wilbarger","Willacy","Williamson","Wilson","Winkler","Wise","Wood","Yoakum","Young","Zapata","Zavala"
]);

const CITY_TO_COUNTY = {
  "houston":"Harris","pasadena":"Harris","baytown":"Harris","katy":"Harris","cypress":"Harris","spring":"Harris","humble":"Harris",
  "dallas":"Dallas","irving":"Dallas","garland":"Dallas","mesquite":"Dallas","richardson":"Dallas",
  "fort worth":"Tarrant","arlington":"Tarrant","grapevine":"Tarrant","southlake":"Tarrant",
  "san antonio":"Bexar","austin":"Travis","round rock":"Williamson","georgetown":"Williamson",
  "frisco":"Collin","plano":"Collin","mckinney":"Collin","allen":"Collin",
  "denton":"Denton","lewisville":"Denton","flower mound":"Denton",
  "sugar land":"Fort Bend","missouri city":"Fort Bend","conroe":"Montgomery","the woodlands":"Montgomery",
  "galveston":"Galveston","texas city":"Galveston","pearland":"Brazoria","lake jackson":"Brazoria",
  "san marcos":"Hays","corpus christi":"Nueces","edinburg":"Hidalgo","mcallen":"Hidalgo",
  "brownsville":"Cameron","laredo":"Webb","beaumont":"Jefferson","port arthur":"Jefferson",
  "tyler":"Smith","killeen":"Bell","temple":"Bell","midland":"Midland","odessa":"Ector",
  "lubbock":"Lubbock","abilene":"Taylor","wichita falls":"Wichita","rockwall":"Rockwall"
};

function cleanCounty(value) {
  if (!value) return "";
  return String(value).replace(/\s+County$/i, "").trim().replace(/\b\w/g, c => c.toUpperCase());
}

function isTexasCounty(county) {
  return VALID_TX_COUNTIES.has(cleanCounty(county));
}

function numberValue(value) {
  const n = Number(String(value ?? "").replace(/,/g, "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function pick(obj, names) {
  if (!obj) return "";
  for (const name of names) {
    if (obj[name] !== undefined && obj[name] !== null && obj[name] !== "") return obj[name];
  }
  const lower = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of names) {
    const v = lower[String(name).toLowerCase()];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return "";
}

function normalizeRecord({ utility, county, city, customersOut, incidents, updated, source }) {
  let c = cleanCounty(county);

  if (!c && city) {
    c = CITY_TO_COUNTY[String(city).toLowerCase().trim()] || "";
  }

  if (!isTexasCounty(c)) return null;

  return {
    state: "TX",
    county: c,
    utility: utility || "Unknown",
    customersOut: numberValue(customersOut),
    incidents: numberValue(incidents),
    updated: updated || new Date().toISOString(),
    source: source || "unknown"
  };
}

async function fetchAny(url) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json,text/html,*/*",
      "user-agent": "TexasEmergencyDashboard/1.0"
    }
  });

  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const text = await res.text();

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function fetchODIN() {
  try {
    const json = await fetchAny(
      "https://ornl.opendatasoft.com/api/explore/v2.1/catalog/datasets/odin-real-time-outages-county/records?limit=100"
    );

    const rows = Array.isArray(json.results) ? json.results : [];

    return rows.map(r => {
      const state = String(pick(r, ["state", "state_abbreviation", "state_code", "state_name"])).toUpperCase();

      if (state && state !== "TX" && state !== "TEXAS") return null;

      return normalizeRecord({
        utility: "ODIN",
        county: pick(r, ["county", "county_name", "countyname", "geography"]),
        customersOut: pick(r, ["customers_out", "customers_affected", "outage_count", "outages"]),
        incidents: pick(r, ["frequency", "record_count", "count"]),
        updated: pick(r, ["last_updated", "updated", "timestamp", "datetime"]),
        source: "ODIN"
      });
    }).filter(Boolean);

  } catch (err) {
    console.log("ODIN failed:", err.message);
    return [];
  }
}

async function fetchCenterPoint() {
  const services = [
    "https://gis.centerpointenergy.com/arcgis/rest/services/Outage/OUTAGE_TRACKER_OEP_ALL/MapServer",
    "https://origin-gis.centerpointenergy.com/arcgis/rest/services/Outage/OUTAGE_TRACKER_OEP_ALL/MapServer"
  ];

  const records = [];

  for (const service of services) {
    try {
      const meta = await fetchAny(`${service}?f=json`);
      const layerIds = (meta.layers || []).map(l => l.id).slice(0, 10);

      for (const layerId of layerIds) {
        try {
          const url = `${service}/${layerId}/query?where=1%3D1&outFields=*&returnGeometry=false&f=json&resultRecordCount=2000`;
          const json = await fetchAny(url);

          for (const f of json.features || []) {
            const a = f.attributes || {};

            const rec = normalizeRecord({
              utility: "CenterPoint",
              county: pick(a, ["COUNTY", "County", "county", "CNTY_NM", "COUNTY_NAM", "CountyName"]),
              city: pick(a, ["CITY", "City", "city", "MUNICIPALITY"]),
              customersOut: pick(a, ["CUSTOMERS_OUT", "CustomersOut", "CUST_OUT", "OUTAGECUSTOMERS", "CUSTOMERS", "Customers", "CustomerCount"]),
              incidents: pick(a, ["INCIDENTS", "IncidentCount", "OUTAGES", "OutageCount"]),
              updated: pick(a, ["LASTUPDATED", "LAST_UPDATE", "UPDATED", "LastUpdated"]),
              source: "CenterPoint ArcGIS"
            });

            if (rec && (rec.customersOut > 0 || rec.incidents > 0)) records.push(rec);
          }
        } catch {}
      }
    } catch (err) {
      console.log("CenterPoint failed:", err.message);
    }
  }

  return records;
}

function parseHtmlTableRows(html) {
  const rows = [];
  const trMatches = String(html).match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (const tr of trMatches) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m =>
      m[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()
    );
    if (cells.length) rows.push(cells);
  }

  return rows;
}

async function fetchOncorReports() {
  const urls = [
    "https://stormcenter.oncor.com/external/default.html/reports/bf46edea-cddf-4abb-94d2-22f095250724?c=control-a09f84af-bac6-465f-af1e-1b3fded43574&o=option-9ea8acc1-8aa2-48dc-a3fb-eaa4f88727ca"
  ];

  const records = [];

  for (const url of urls) {
    try {
      const html = await fetchAny(url);
      const rows = parseHtmlTableRows(html);

      for (const cells of rows) {
        const lower = cells.join(" ").toLowerCase();

        if (lower.includes("customers affected") || lower.includes("customers served") || lower.includes("city") || lower.includes("zip")) continue;

        const city = cells[0];
        const customersOut = cells.length > 1 ? numberValue(cells[1]) : 0;

        const rec = normalizeRecord({
          utility: "Oncor",
          city,
          customersOut,
          incidents: customersOut > 0 ? 1 : 0,
          updated: new Date().toISOString(),
          source: "Oncor public report"
        });

        if (rec && rec.customersOut > 0) records.push(rec);
      }
    } catch (err) {
      console.log("Oncor failed:", err.message);
    }
  }

  return records;
}

async function fetchAepTexasReports() {
  try {
    const html = await fetchAny("https://outagemap.aeptexas.com/reports/27d19f6e-6291-4601-bef7-f7f44cf8f5ec");
    const rows = parseHtmlTableRows(html);

    return rows.map(cells => {
      const lower = cells.join(" ").toLowerCase();

      if (lower.includes("customers affected") || lower.includes("customers served") || lower.includes("zip")) return null;

      return normalizeRecord({
        utility: "AEP Texas",
        city: cells[0],
        customersOut: cells.length > 1 ? numberValue(cells[1]) : 0,
        incidents: cells.length > 1 && numberValue(cells[1]) > 0 ? 1 : 0,
        updated: new Date().toISOString(),
        source: "AEP Texas public report"
      });
    }).filter(r => r && r.customersOut > 0);

  } catch (err) {
    console.log("AEP Texas failed:", err.message);
    return [];
  }
}

function mergeRecords(records) {
  const byKey = new Map();

  for (const r of records) {
    if (!r || r.state !== "TX" || !isTexasCounty(r.county)) continue;

    const key = [r.utility, r.county, r.source].join("|");

    if (!byKey.has(key)) {
      byKey.set(key, { ...r });
    } else {
      const existing = byKey.get(key);
      existing.customersOut += numberValue(r.customersOut);
      existing.incidents += numberValue(r.incidents);
    }
  }

  return [...byKey.values()]
    .filter(r => r.customersOut > 0 || r.incidents > 0)
    .sort((a, b) => b.customersOut - a.customersOut);
}

async function main() {
  const sources = [
    ["ODIN", fetchODIN],
    ["CenterPoint", fetchCenterPoint],
    ["Oncor", fetchOncorReports],
    ["AEP Texas", fetchAepTexasReports]
  ];

  const sourceStatus = [];
  const allRecords = [];

  for (const [name, fn] of sources) {
    try {
      const rows = await fn();
      allRecords.push(...rows);
      sourceStatus.push({ name, ok: true, count: rows.length });
      console.log(`${name}: ${rows.length} records`);
    } catch (err) {
      sourceStatus.push({ name, ok: false, count: 0, error: err.message });
      console.log(`${name} failed: ${err.message}`);
    }
  }

  const outages = mergeRecords(allRecords);

  const payload = {
    updated: new Date().toISOString(),
    note: "Texas-only outage file. Non-Texas counties are filtered out.",
    sourceStatus,
    count: outages.length,
    countiesWithOutages: new Set(outages.map(o => o.county)).size,
    totalCustomersOut: outages.reduce((sum, r) => sum + numberValue(r.customersOut), 0),
    outages
  };

  await fs.writeFile(OUT, JSON.stringify(payload, null, 2));

  console.log(`Wrote ${payload.count} outage records / ${payload.totalCustomersOut} customers out to ${OUT}`);
}

main().catch(async err => {
  console.error(err);

  await fs.writeFile(OUT, JSON.stringify({
    updated: new Date().toISOString(),
    note: "Texas-only outage file failed to generate.",
    sourceStatus: [{ name: "aggregator", ok: false, error: err.message }],
    count: 0,
    countiesWithOutages: 0,
    totalCustomersOut: 0,
    outages: []
  }, null, 2));

  process.exitCode = 1;
});
