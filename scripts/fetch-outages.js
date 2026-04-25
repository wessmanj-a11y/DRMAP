const fs = require("fs/promises");

const OUT = "outages.json";

const VALID_TX_COUNTIES = new Set([
  "Harris","Dallas","Tarrant","Bexar","Travis","Collin","Denton",
  "Fort Bend","Montgomery","Williamson","Galveston","Brazoria",
  "Hays","Nueces","Hidalgo","El Paso","Jefferson","Liberty",
  "Orange","Smith","Bell","Cameron","Webb","Midland","Ector",
  "Lubbock","Taylor","Wichita","Grayson","Rockwall"
]);

const CITY_TO_COUNTY = {
  "houston":"Harris","pasadena":"Harris","baytown":"Harris","katy":"Harris",
  "dallas":"Dallas","fort worth":"Tarrant","arlington":"Tarrant",
  "san antonio":"Bexar","austin":"Travis",
  "frisco":"Collin","plano":"Collin","mckinney":"Collin",
  "denton":"Denton",
  "sugar land":"Fort Bend",
  "conroe":"Montgomery",
  "galveston":"Galveston",
  "pearland":"Brazoria",
  "san marcos":"Hays",
  "corpus christi":"Nueces",
  "edinburg":"Hidalgo","mcallen":"Hidalgo",
  "brownsville":"Cameron",
  "laredo":"Webb",
  "beaumont":"Jefferson",
  "tyler":"Smith",
  "killeen":"Bell",
  "midland":"Midland",
  "odessa":"Ector",
  "lubbock":"Lubbock",
  "abilene":"Taylor",
  "wichita falls":"Wichita",
  "rockwall":"Rockwall"
};

function cleanCounty(v){
  return String(v||"").replace(/ County/i,"").trim();
}

function isTexasCounty(c){
  return VALID_TX_COUNTIES.has(cleanCounty(c));
}

function num(v){
  const n = Number(String(v||"").replace(/,/g,""));
  return isNaN(n)?0:n;
}

function pick(obj, keys){
  for(const k of keys){
    if(obj?.[k] != null) return obj[k];
  }
  return "";
}

function normalize({utility, county, city, customersOut}){
  let c = cleanCounty(county);

  if(!c && city){
    c = CITY_TO_COUNTY[String(city).toLowerCase()];
  }

  if(!isTexasCounty(c)) return null;

  return {
    state:"TX",
    county:c,
    utility,
    customersOut:num(customersOut),
    updated:new Date().toISOString()
  };
}

async function fetchAny(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(res.statusText);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

// ---------- ODIN ----------
async function fetchODIN(){
  try{
    const json = await fetchAny(
      "https://ornl.opendatasoft.com/api/explore/v2.1/catalog/datasets/odin-real-time-outages-county/records?limit=100"
    );

    return (json.results||[]).map(r=>{
      if(r.state !== "TX") return null;

      return normalize({
        utility:"ODIN",
        county:r.county,
        customersOut:r.customers_out
      });
    }).filter(Boolean);

  }catch(e){
    console.log("ODIN failed", e.message);
    return [];
  }
}

// ---------- ONCOR (FIXED) ----------
function parseHtmlTableRows(html){
  const rows = [];
  const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for(const tr of trs){
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g,"").trim());

    if(cells.length) rows.push(cells);
  }

  return rows;
}

async function fetchOncorReports(){
  const url = "https://stormcenter.oncor.com/reports/8a3a0248-66cb-4e05-b7d8-649e570562d5";
  const records = [];

  try{
    const html = await fetchAny(url);
    const rows = parseHtmlTableRows(html);

    for(const cells of rows){
      const text = cells.join(" ").toLowerCase();

      if(text.includes("county") || cells.length < 2) continue;

      const rec = normalize({
        utility:"Oncor",
        county:cells[0],
        customersOut:cells[1]
      });

      if(rec && rec.customersOut > 0) records.push(rec);
    }

  }catch(e){
    console.log("Oncor failed", e.message);
  }

  return records;
}

// ---------- MERGE ----------
function merge(arr){
  const map = new Map();

  arr.forEach(r=>{
    if(!r) return;

    const key = r.utility + "|" + r.county;

    if(!map.has(key)) map.set(key,{...r});
    else map.get(key).customersOut += r.customersOut;
  });

  return [...map.values()];
}

// ---------- MAIN ----------
async function main(){
  const odin = await fetchODIN();
  const oncor = await fetchOncorReports();

  const outages = merge([...odin, ...oncor]);

  const payload = {
    updated:new Date().toISOString(),
    count:outages.length,
    totalCustomersOut:outages.reduce((s,o)=>s+o.customersOut,0),
    outages
  };

  await fs.writeFile(OUT, JSON.stringify(payload,null,2));
  console.log("DONE:", payload.count);
}

main();
