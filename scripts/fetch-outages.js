/**
 * Texas outage aggregator for GitHub Actions
 * Writes: outages.json
 */

const fs = require("fs/promises");

const OUT = "outages.json";

// --- County center fallback (for mapping)
const TX_COUNTY_CENTERS = {
  Harris:[29.77,-95.31], Dallas:[32.77,-96.78], Tarrant:[32.77,-97.29],
  Bexar:[29.45,-98.52], Travis:[30.27,-97.74], Collin:[33.18,-96.57],
  Denton:[33.21,-97.13], FortBend:[29.53,-95.77], Montgomery:[30.32,-95.48]
};

function cleanCounty(v){
  return String(v||"").replace(/ County/i,"").trim();
}

function num(v){
  const n = Number(String(v||"").replace(/,/g,""));
  return isNaN(n)?0:n;
}

function center(county){
  return TX_COUNTY_CENTERS[cleanCounty(county)] || [31,-99];
}

// --- normalize format
function normalize({utility, county, customersOut, lat, lon}){
  if(!county) return null;
  const [clat, clon] = center(county);
  return {
    state:"TX",
    county: cleanCounty(county),
    utility,
    customersOut: num(customersOut),
    lat: lat || clat,
    lon: lon || clon,
    updated: new Date().toISOString()
  };
}

// --- ODIN (baseline)
async function fetchODIN(){
  try{
    const res = await fetch("https://ornl.opendatasoft.com/api/explore/v2.1/catalog/datasets/odin-real-time-outages-county/records?limit=100");
    const json = await res.json();
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

// --- CenterPoint ArcGIS
async function fetchCenterPoint(){
  try{
    const res = await fetch("https://gis.centerpointenergy.com/arcgis/rest/services/Outage/OUTAGE_TRACKER_OEP_ALL/MapServer/0/query?where=1%3D1&outFields=*&f=json");
    const json = await res.json();

    return (json.features||[]).map(f=>{
      const a = f.attributes;
      return normalize({
        utility:"CenterPoint",
        county:a.COUNTY,
        customersOut:a.CUST_OUT,
        lat:f.geometry?.y,
        lon:f.geometry?.x
      });
    }).filter(r=>r && r.customersOut>0);

  }catch(e){
    console.log("CenterPoint failed", e.message);
    return [];
  }
}

// --- Merge
function merge(arr){
  const map = new Map();
  arr.forEach(r=>{
    const key = r.utility + "|" + r.county;
    if(!map.has(key)) map.set(key, {...r});
    else map.get(key).customersOut += r.customersOut;
  });
  return [...map.values()];
}

// --- Main
async function main(){
  const odin = await fetchODIN();
  const cp = await fetchCenterPoint();

  const outages = merge([...odin, ...cp]);

  const payload = {
    updated: new Date().toISOString(),
    count: outages.length,
    totalCustomersOut: outages.reduce((s,o)=>s+o.customersOut,0),
    outages
  };

  await fs.writeFile(OUT, JSON.stringify(payload,null,2));
  console.log("Wrote outages.json", payload.count);
}

main();
