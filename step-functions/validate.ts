import * as fs from "fs";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface State {
  Type: string;
  Next?: string;
  Catch?: Array<{ Next: string }>;
  Resource?: string;
}

interface StateMachineDefinition {
  StartAt?: string;
  States?: Record<string, State>;
}

// ─── Load and parse ───────────────────────────────────────────────────────────

const smPath = path.resolve(__dirname, "call-state-machine.json");
const raw = fs.readFileSync(smPath, "utf-8");

let definition: StateMachineDefinition;
let jsonValid = false;

try {
  definition = JSON.parse(raw) as StateMachineDefinition;
  jsonValid = true;
} catch {
  definition = {};
}

// ─── Checks ───────────────────────────────────────────────────────────────────

const states     = definition.States ?? {};
const stateNames = Object.keys(states);

// 1. Valid JSON
const check1 = jsonValid;

// 2. Has StartAt
const check2 = typeof definition.StartAt === "string" && definition.StartAt.length > 0;

// 3. Has States object
const check3 = stateNames.length > 0;

// 4. Every state has a Type field
const check4 = stateNames.every((name) => typeof states[name]?.Type === "string");

// 5. All Next references (including inside Catch) point to existing states
const allNextRefs: string[] = [];
for (const state of Object.values(states)) {
  if (state.Next) allNextRefs.push(state.Next);
  if (state.Catch) {
    for (const catcher of state.Catch) {
      allNextRefs.push(catcher.Next);
    }
  }
}
const invalidNextRefs = allNextRefs.filter((ref) => !stateNames.includes(ref));
const check5 = invalidNextRefs.length === 0;

// 6. No circular references — simple DFS from StartAt
function hasCircle(start: string, visited = new Set<string>()): boolean {
  if (visited.has(start)) return true;
  visited.add(start);
  const state = states[start];
  if (!state) return false;
  const nexts: string[] = [];
  if (state.Next) nexts.push(state.Next);
  if (state.Catch) nexts.push(...state.Catch.map((c) => c.Next));
  return nexts.some((n) => hasCircle(n, new Set(visited)));
}
const check6 = definition.StartAt ? !hasCircle(definition.StartAt) : true;

// 7. At least one terminal state (Succeed or Fail)
const check7 = stateNames.some(
  (name) => states[name]?.Type === "Succeed" || states[name]?.Type === "Fail"
);

// 8. Collect all LAMBDA_ARN_* placeholders
const placeholders = (raw.match(/LAMBDA_ARN_\w+/g) ?? []).filter(
  (v, i, arr) => arr.indexOf(v) === i
);

// ─── Report ───────────────────────────────────────────────────────────────────

const sep = "─────────────────────────────────────────────────";
console.log(`\n${sep}`);
console.log("STEP FUNCTIONS VALIDATION REPORT");
console.log(sep);
console.log(`JSON valid:              ${check1 ? "PASS" : "FAIL"}`);
console.log(`StartAt defined:         ${check2 ? "PASS" : "FAIL"}`);
console.log(`States defined:          ${stateNames.length} states`);
console.log(`All types defined:       ${check4 ? "PASS" : "FAIL"}`);
console.log(`All Next refs valid:      ${check5 ? "PASS" : `FAIL (${invalidNextRefs.join(", ")})`}`);
console.log(`No circular refs:        ${check6 ? "PASS" : "FAIL"}`);
console.log(`Terminal state exists:   ${check7 ? "PASS" : "FAIL"}`);
console.log(sep);
console.log("Lambda ARNs needed before deployment:");
for (const p of placeholders) {
  console.log(`  ${p.padEnd(30)} — fill in .env`);
}
console.log(sep);

const allPass = check1 && check2 && check3 && check4 && check5 && check6 && check7;
console.log(
  `STATUS: ${allPass ? "READY TO DEPLOY once Lambda ARNs filled" : "ACTION REQUIRED — fix checks above"}`
);
console.log(`${sep}\n`);

if (!allPass) process.exit(1);
