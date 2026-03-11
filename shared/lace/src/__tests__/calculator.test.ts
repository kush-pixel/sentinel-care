import {
  calculateLengthOfStayPoints,
  calculateAcuityPoints,
  calculateEDVisitPoints,
  scoreToRiskLevel,
  calculateLaceScore,
} from "../calculator";
import {
  calculateCharlsonScore,
  charlsonToLacePoints,
} from "../charlson";

// ─── Tests 1-7: Length of Stay ────────────────────────────────────────────────

test("LOS: same day admission and discharge returns 0", () => {
  expect(calculateLengthOfStayPoints("2026-03-06", "2026-03-06")).toBe(0);
});

test("LOS: 1 day stay returns 1", () => {
  expect(calculateLengthOfStayPoints("2026-03-05", "2026-03-06")).toBe(1);
});

test("LOS: 2 day stay returns 2", () => {
  expect(calculateLengthOfStayPoints("2026-03-04", "2026-03-06")).toBe(2);
});

test("LOS: 3 day stay returns 3", () => {
  expect(calculateLengthOfStayPoints("2026-03-03", "2026-03-06")).toBe(3);
});

test("LOS: 5 day stay returns 4", () => {
  expect(calculateLengthOfStayPoints("2026-03-01", "2026-03-06")).toBe(4);
});

test("LOS: 10 day stay returns 5", () => {
  expect(calculateLengthOfStayPoints("2026-02-24", "2026-03-06")).toBe(5);
});

test("LOS: 14 day stay returns 7", () => {
  expect(calculateLengthOfStayPoints("2026-02-20", "2026-03-06")).toBe(7);
});

// ─── Tests 8-9: Acuity ────────────────────────────────────────────────────────

test("Acuity: EMERGENCY returns 3", () => {
  expect(calculateAcuityPoints("EMERGENCY")).toBe(3);
});

test("Acuity: PLANNED returns 0", () => {
  expect(calculateAcuityPoints("PLANNED")).toBe(0);
});

// ─── Tests 10-12: ED Visits ───────────────────────────────────────────────────

test("ED visits: 0 visits returns 0", () => {
  expect(calculateEDVisitPoints(0)).toBe(0);
});

test("ED visits: 2 visits returns 2", () => {
  expect(calculateEDVisitPoints(2)).toBe(2);
});

test("ED visits: 4 visits returns 4", () => {
  expect(calculateEDVisitPoints(4)).toBe(4);
});

// ─── Tests 13-15: Charlson ────────────────────────────────────────────────────

test("Charlson: I50.9 scores 1, lace points 1", () => {
  expect(calculateCharlsonScore(["I50.9"])).toBe(1);
  expect(charlsonToLacePoints(1)).toBe(1);
});

test("Charlson: I50.9 + N18.3 scores 3, lace points 3", () => {
  expect(calculateCharlsonScore(["I50.9", "N18.3"])).toBe(3);
  expect(charlsonToLacePoints(3)).toBe(3);
});

test("Charlson: empty array scores 0, lace points 0", () => {
  expect(calculateCharlsonScore([])).toBe(0);
  expect(charlsonToLacePoints(0)).toBe(0);
});

// ─── Tests 16-19: Risk Level ──────────────────────────────────────────────────

test("Risk level: score 3 returns LOW", () => {
  expect(scoreToRiskLevel(3)).toBe("LOW");
});

test("Risk level: score 7 returns MODERATE", () => {
  expect(scoreToRiskLevel(7)).toBe("MODERATE");
});

test("Risk level: score 11 returns HIGH", () => {
  expect(scoreToRiskLevel(11)).toBe("HIGH");
});

test("Risk level: score 15 returns VERY HIGH", () => {
  expect(scoreToRiskLevel(15)).toBe("VERY HIGH");
});

// ─── Test 20: Full P001 scenario ──────────────────────────────────────────────

test("Full P001 scenario: LACE score 10 HIGH", () => {
  const result = calculateLaceScore({
    admissionDate: "2026-02-28",
    dischargeDate: "2026-03-06",
    admissionType: "EMERGENCY",
    conditionCodes: ["I50.9"],
    recentEDVisits: 2,
  });
  // 2026-02-28 to 2026-03-06 = 6 days → L=4
  // EMERGENCY → A=3
  // I50.9 charlson=1 → C=1
  // 2 ED visits → E=2
  // total = 10
  expect(result.totalScore).toBe(10);
  expect(result.riskLevel).toBe("HIGH");
  expect(result.components).toEqual({ L: 4, A: 3, C: 1, E: 2 });
});

// ─── Test 21: Full P006 scenario ──────────────────────────────────────────────

test("Full P006 scenario: LACE score 4 LOW", () => {
  const result = calculateLaceScore({
    admissionDate: "2026-03-05",
    dischargeDate: "2026-03-07",
    admissionType: "PLANNED",
    conditionCodes: ["N18.3"],
    recentEDVisits: 0,
  });
  // 2 days → L=2
  // PLANNED → A=0
  // N18.3 charlson=2 → C=2
  // 0 ED visits → E=0
  // total = 4
  expect(result.totalScore).toBe(4);
  expect(result.riskLevel).toBe("LOW");
  expect(result.components).toEqual({ L: 2, A: 0, C: 2, E: 0 });
});

// ─── Test 22: Full P005 scenario ──────────────────────────────────────────────

test("Full P005 scenario: LACE score 9 MODERATE", () => {
  const result = calculateLaceScore({
    admissionDate: "2026-03-02",
    dischargeDate: "2026-03-06",
    admissionType: "EMERGENCY",
    conditionCodes: ["I21.9"],
    recentEDVisits: 1,
  });
  // 4 days → L=4
  // EMERGENCY → A=3
  // I21.9 charlson=1 → C=1
  // 1 ED visit → E=1
  // total = 9
  expect(result.totalScore).toBe(9);
  expect(result.riskLevel).toBe("MODERATE");
});
