import { chunk, escapeHtml } from "../src/telegram.js";

let pass = 0, fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = String(got) === String(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      got=${got} want=${want}`);
}

// The exact string that broke a live send: Telegram read "<15m)" as a start tag.
check("1. the lateness label no longer looks like a tag",
  escapeHtml("fresh (<15m)"), "fresh (&lt;15m)");
check("2. ampersands escape first, so nothing double-escapes",
  escapeHtml("a & b < c"), "a &amp; b &lt; c");
check("3. an already-escaped entity survives a round trip intact",
  escapeHtml(escapeHtml("<")), "&amp;lt;");

// A long report must not split between <pre> and </pre>: each chunk is wrapped
// on its own, so every part has to be independently valid.
const big = Array.from({ length: 400 }, (_, i) => `row ${i} fresh (<15m) x`).join("\n");
const parts = chunk(escapeHtml(big), 4096 - 32);
check("4. a long report splits into several chunks", parts.length > 1, true);
check("5. no chunk carries a raw angle bracket",
  parts.every((p) => !/[<>]/.test(p)), true);
check("6. every chunk is independently wrappable",
  parts.every((p) => `<pre>${p}</pre>`.length <= 4096), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
