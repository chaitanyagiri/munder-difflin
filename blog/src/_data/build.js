// Build-time metadata. `new Date()` here is fine — it's the build machine clock,
// not the Eleventy template layer.
const now = new Date();
export default {
  year: now.getUTCFullYear(),
  timestamp: now.toISOString(),
  date: now.toISOString().slice(0, 10), // YYYY-MM-DD
};
