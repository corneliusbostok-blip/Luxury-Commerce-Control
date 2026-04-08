const counters = new Map();
const minuteEvents = new Map();

function increment(name, amount = 1) {
  const n = Number(amount) || 0;
  counters.set(name, (counters.get(name) || 0) + n);
  const arr = minuteEvents.get(name) || [];
  const now = Date.now();
  for (let i = 0; i < n; i += 1) arr.push(now);
  minuteEvents.set(name, arr);
}

function countInLastMs(name, ms) {
  const now = Date.now();
  const arr = minuteEvents.get(name) || [];
  const keep = arr.filter((t) => now - t <= ms);
  minuteEvents.set(name, keep);
  return keep.length;
}

function getSnapshot() {
  const out = {};
  for (const [k, v] of counters.entries()) out[k] = v;
  return out;
}

module.exports = {
  increment,
  countInLastMs,
  getSnapshot,
};
