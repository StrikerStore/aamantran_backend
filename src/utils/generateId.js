// Returns a random 5-digit number as a string: "14463"
function generateId() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

module.exports = generateId;
