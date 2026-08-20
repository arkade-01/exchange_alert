import { recordSnapshots, getSnapshotAtOrBefore } from "../src/db.js";

const MIN = 60_000;
const now = Date.now();
let pass = 0, fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

// A 1h window, tolerating snapshots up to 20m older than the cutoff.
const cutoff = now - 60 * MIN;
const slack = 20 * MIN;

recordSnapshots([
  // Good: 65m old — just past the cutoff, well inside the slack.
  { exchange: "t", symbol: "FRESH", ts: now - 65 * MIN, oi: 100, price: 10 },
  // Stale: 11h old — the exact shape of the bug this guards against.
  { exchange: "t", symbol: "STALE", ts: now - 11 * 60 * MIN, oi: 100, price: 10 },
  // Too recent: 30m old, does not span the window at all.
  { exchange: "t", symbol: "RECENT", ts: now - 30 * MIN, oi: 100, price: 10 },
  // Gap: one usable at 70m and one useless at 12h; must pick the 70m one.
  { exchange: "t", symbol: "GAP", ts: now - 70 * MIN, oi: 100, price: 10 },
  { exchange: "t", symbol: "GAP", ts: now - 12 * 60 * MIN, oi: 999, price: 99 },
]);

const age = (s?: { ts: number }) => (s ? Math.round((now - s.ts) / MIN) : null);

check("in-window snapshot is accepted", age(getSnapshotAtOrBefore("t", "FRESH", cutoff, slack)), 65);
check("11h-stale snapshot is REJECTED", getSnapshotAtOrBefore("t", "STALE", cutoff, slack), undefined);
check("too-recent snapshot is not used", getSnapshotAtOrBefore("t", "RECENT", cutoff, slack), undefined);
check("picks newest in range, not oldest", age(getSnapshotAtOrBefore("t", "GAP", cutoff, slack)), 70);
check("unknown symbol yields nothing", getSnapshotAtOrBefore("t", "NOPE", cutoff, slack), undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
