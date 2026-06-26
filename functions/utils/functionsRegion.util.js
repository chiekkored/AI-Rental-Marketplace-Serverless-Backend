function parseFunctionsRegion(value) {
  const regions = String(value || "")
    .split(",")
    .map((region) => region.trim())
    .filter(Boolean);

  if (regions.length === 0) return "asia-southeast1";
  if (regions.length === 1) return regions[0];
  return regions;
}

const FUNCTIONS_REGION = parseFunctionsRegion(process.env.FUNCTIONS_REGION);
const PRIMARY_FUNCTIONS_REGION = Array.isArray(FUNCTIONS_REGION)
  ? FUNCTIONS_REGION[0]
  : FUNCTIONS_REGION;

module.exports = {
  FUNCTIONS_REGION,
  PRIMARY_FUNCTIONS_REGION,
};
