// "Floral Design" → "floral-design"
function slugify(str) {
  return str
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')     // spaces/underscores → hyphen
    .replace(/[^a-z0-9-]/g, '')  // remove non-alphanumeric (except hyphen)
    .replace(/-+/g, '-')          // collapse multiple hyphens
    .replace(/^-|-$/g, '');       // strip leading/trailing hyphens
}

module.exports = slugify;
