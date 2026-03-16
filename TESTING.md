# Sentinel Care — Testing Guide

This guide walks judges through verifying the full Sentinel Care pipeline: from patient data setup through a real outbound voice call to the nurse dashboard.

---

## Prerequisites

Before running any tests, ensure:

1. `.env` is configured (copy from `.env.example` and fill all values)
2. AWS credentials are active (`aws sts get-caller-identity` should succeed)
3. All Lambda functions are deployed (`npm run deploy:lambdas` from `scripts/`)
4. HAPI FHIR server is reachable at the `FHIR_BASE_URL` in your `.env`
5. Amazon Connect instance is configured with the Sentinel contact flow
6. Amazon Lex SentinelVoiceBot is deployed with the lex-fulfillment Lambda as the code hook
7. Node.js 20+ installed

---

## Quick Verification (no phone call needed)

### 1. Run all unit tests

```bash
# From repo root
npm test
```

**Expected:** All test suites pass. The test output will show coverage across:
- `packages/lace` — LACE score calculation (all risk tiers: LOW, MODERATE, HIGH, VERY HIGH)
- `packages/schemas` — Zod schema validation for protocols and clinical rules
- `packages/validation` — Patient ID, call ID, rule version validation
- `lambdas/lex-fulfillment` — Answer extraction, dedup guard, no-input rollback, redirect sentinel

### 2. Health check

```bash
cd scripts
npm run health:check
```

**Expected output:**
```
✓ AWS credentials valid
✓ DynamoDB tables reachable (PatientProfiles, TriageProtocols, CallResults, ClinicalRules, ProtocolReview)
✓ FHIR server reachable
✓ Bedrock endpoint accessible
✓ Lambda functions deployed and invocable
```

### 3. Verify patient data

```bash
cd scripts
npm run verify
```

**Expected:** Lists all patients in PatientProfiles with their LACE scores and condition codes.

---

## Seeding Demo Data

If starting from a clean state:

```bash
cd scripts

# Seed all patient data (FHIR, encounters, rules, LACE, demo results, protocol reviews)
npm run seed:all

# Generate approved triage protocols for all patients
npm run morning:start
```

**What `seed:all` creates:**
- P001: Heart failure patient (I50.9) — LACE HIGH risk
- P002: Knee replacement patient (Z96.651) — LACE MODERATE risk
- P003: COPD patient — LACE HIGH risk
- P004–P008: Additional condition variants for dashboard demo

**What `morning:start` does:**
- Invokes `sentinel-care-planner` for each patient
- Protocols scoring above the confidence threshold are AUTO_APPROVED and written to `TriageProtocols`
- Others are written to `ProtocolReview` as `PENDING_REVIEW`

---

## Dashboard Verification

### 1. Start the dashboard

```bash
cd dashboard
npm run dev
```

Open `http://localhost:3000`.

### 2. What to verify

**Triage tab:**
- Patient cards display correctly with RED / YELLOW / GREEN / INCOMPLETE badges
- LACE score pill appears on each card (color-coded by risk level)
- RED patients appear first, sorted by severity
- Stats pills in the header show correct counts (🔴 N RED, 🟡 N YELLOW, ✅ N GREEN)

**SBAR Modal:**
- Click any patient card to open the SBAR modal
- Verify the SBAR has all four sections: S (Situation), B (Background), A (Assessment), R (Recommendation)
- Broken rules should appear in natural language (e.g., "wound drainage is present") — no `>=` or `_` notation
- LACE components breakdown should be visible (L + A + C + E = score)
- Guideline source should be cited (e.g., "AAOS Post-Arthroplasty Recovery Protocol")
- "Acknowledge" button marks the patient as reviewed (card dims and moves to bottom)

**Protocol Review tab:**
- Click "Protocol Review (N)" tab in the header
- Pending reviews appear with confidence scores and condition badges
- Click a review to expand: shows the full question list with variable names, operators, thresholds, and flag colors
- "Approve" button: approves the protocol and moves it to `TriageProtocols` (makes the patient callable)
- "Reject" button: opens reason selection + notes; submitting rejection triggers automatic regeneration via `sentinel-care-planner`
- After rejection, the review status updates to `REJECTED` and a new `PENDING_REVIEW` record appears within ~10 seconds

---

## End-to-End Voice Call Test

This test places a real outbound call to a physical phone.

### Prerequisites for this test

- `TEST_PHONE_NUMBER` set in `.env` (E.164 format: `+1XXXXXXXXXX`)
- P002 (or P001) must have an approved protocol in `TriageProtocols`
- Amazon Connect must be configured and the phone number active

### Step 1: Initiate the call

```bash
cd scripts
npm run test:p002-call
```

**Expected output:**
```
═══════════════════════════════════════════════════════
  SENTINEL — P002 REAL CALL TEST
═══════════════════════════════════════════════════════

STEP 1 — Loading P002 patient data...
  Patient:    Robert Chen (P002)
  Condition:  Z96.651 — Left knee joint replacement
  LACE:       7 MODERATE

STEP 2 — Adding test phone number to FHIR...
  ✓ Phone +1XXXXXXXXXX written to FHIR Patient/P002

STEP 3 — Verifying triage protocol...
  ✓ Protocol found — 5 questions:
    Q1: fever == true (flag: RED)
    Q2: wound_drainage == true (flag: RED)
    Q3: pain_level >= 7 (flag: YELLOW)
    Q4: mobility == false (flag: YELLOW)
    Q5: medication_adherence == false (flag: YELLOW)

STEP 4 — Placing call via sentinel-call-initiator...
  ✓ Call initiated (contactId: <contact-id>)

═══════════════════════════════════════════════════════
  REAL CALL — Robert Chen (P002)
  Condition: Z96.651 — Left knee joint replacement
  Phone: +1XXXXXXXXXX
  Call ID: CALL-<hex>
───────────────────────────────────────────────────────
  Expected questions:
    Q1 — fever  Temperature ≥ 101°F?
    Q2 — wound_drainage  Drainage/discharge from incision?
    Q3 — pain_level  Pain ≥ 7/10?
    Q4 — mobility  Able to move / walk as expected?
    Q5 — medication_adherence  Taking all meds as prescribed?
───────────────────────────────────────────────────────
  Answer naturally. Incoming call from +17208446427
  WAITING — Do not continue until the call has ended.
```

**Note the Call ID** — you'll need it for the audit.

### Step 2: Answer the call

When your phone rings, answer and respond naturally to each question. The AI will:

- Greet you by the patient's first name
- Ask each question conversationally (not robotically)
- Acknowledge your answer before moving on ("Good to hear. / I understand, I've noted that.")
- Ask for clarification once if your answer is ambiguous
- Thank you and close when all questions are answered

**Suggested answers to trigger a YELLOW result:**
- Fever: "No I don't have a fever" → extracts `false`
- Wound drainage: "Yes, there is some discharge" → extracts `true` (RULE BROKEN)
- Pain level: "About a four" → extracts `4`
- Mobility: "Yes, I've been walking" → extracts `true`
- Medication adherence: "Yes, taking everything" → extracts `true`

### Step 3: Run the post-call audit

After the call ends (~2–3 minutes):

```bash
cd scripts
npm run post-call-audit -- P002 CALL-<id-from-step-1>
# or omit callId to use the most recent call:
npm run post-call-audit -- P002
```

**Expected output (all PASS):**
```
═══════════════════════════════════════════════════════
  POST-CALL AUDIT — P002

INVESTIGATION A — Call
───────────────────────────────────────────────────────
  call_id:            CALL-<hex>
  call_status:        COMPLETE
  call_timestamp:     2024-...
  Variables captured: 5/5

  Captured variables:
    fever: false (conf: 0.95)
    wound_drainage: true (conf: 0.90)
    pain_level: 4 (conf: 0.90)
    mobility: true (conf: 0.95)
    medication_adherence: true (conf: 0.95)

INVESTIGATION B — Triage
───────────────────────────────────────────────────────
  triage_status:      YELLOW
  weighted_score:     0.90
  lace_score:         7 MODERATE
  escalation:         no

  Broken rules (raw → natural):
    wound_drainage == true  →  wound drainage is present

INVESTIGATION C — SBAR
───────────────────────────────────────────────────────
  SBAR text:
  S (Situation): Post-discharge follow-up completed for Robert Chen (P002)...
  B (Background): Patient underwent left knee arthroplasty...
  A (Assessment): wound drainage is present per AAOS Post-Arthroplasty Recovery Protocol...
  R (Recommendation): Nurse callback required within 24 hours...

  Quality checks:
    Generated:          YES
    Has condition ref:  YES
    Has guideline:      YES
    No tech notation:   YES
    No UNKNOWN/holders: YES
    No underscores:     YES
    Has recommendation: YES

═══════════════════════════════════════════════════════
  P002 PIPELINE AUDIT — Robert Chen (Z96.651)

  CALL:
    Status:                  COMPLETE
    Questions answered:      5/5
    No question repeated:    YES
    All answers captured:    YES
    Unresolved variables:    0

  TRIAGE:
    Engine ran:              YES
    Result:                  YELLOW
    Broken rules natural:    YES
    LACE score:              7 MODERATE

  SBAR:
    Generated:               YES
    Condition correct:       YES (Z96.651/Left knee joint replacement)
    Guideline cited:         YES
    Natural language:        YES
    No == or >=:             YES
    No underscores:          YES
    No UNKNOWN:              YES
    Has recommendation:      YES

  OVERALL:
    Call pipeline:           PASS
    Triage pipeline:         PASS
    SBAR pipeline:           PASS

═══════════════════════════════════════════════════════
  P002 PIPELINE: PASS
═══════════════════════════════════════════════════════
```

### Step 4: Verify in dashboard

Refresh `http://localhost:3000`. P002 should appear with:
- YELLOW badge
- "wound drainage is present" in the broken rules section
- Full SBAR with AAOS guideline citation
- "Acknowledge" button functional

---

## Testing Protocol Review Flow

This tests the human-in-the-loop approval/rejection cycle.

### Seed a pending review

```bash
cd scripts
npm run seed:reviews   # Creates PENDING_REVIEW records for select patients
```

### In the dashboard:

1. Click "Protocol Review" tab
2. Select a PENDING_REVIEW protocol
3. Review the generated question list and conditions
4. **Test Approval:** Click "Approve" — the protocol moves to `TriageProtocols` and the patient becomes callable
5. **Test Rejection:** Click "Reject", select a reason (e.g., "Missing critical variable"), enter notes, submit
   - The protocol updates to `REJECTED`
   - A new `PENDING_REVIEW` entry appears within ~10 seconds (regeneration triggered)
   - The new entry shows `↻ REVISED PROTOCOL` with the rejection reason for context

---

## Testing New Patient Registration

```bash
cd scripts
npm run test:new-patient-call
```

This test:
1. Creates a brand-new patient with a UUID (no existing FHIR record)
2. Seeds their FHIR data
3. Generates their protocol from scratch via `sentinel-care-planner`
4. Places an outbound call
5. Runs the full pipeline end-to-end

**Expected:** Protocol generated, call placed, triage completed, SBAR visible in dashboard — demonstrating the system handles any patient, not just pre-seeded ones.

---

## Robustness Tests

### Maintenance cleanup

```bash
cd scripts
npm run cleanup:stale   # Removes IN_PROGRESS calls older than 24h
```

### Re-build FHIR data

```bash
cd scripts
npm run rebuild:fhir    # Re-seeds all FHIR patient records from scratch
```

---

## TypeScript Type Checking

```bash
# Check each Lambda package
cd lambdas/lex-fulfillment    && npx tsc --noEmit && echo "PASS" || echo "FAIL"
cd lambdas/care-planner       && npx tsc --noEmit && echo "PASS" || echo "FAIL"
cd lambdas/summarizer         && npx tsc --noEmit && echo "PASS" || echo "FAIL"
cd lambdas/nova-sonic-handler && npx tsc --noEmit && echo "PASS" || echo "FAIL"
cd lambdas/call-initiator     && npx tsc --noEmit && echo "PASS" || echo "FAIL"

# Check dashboard
cd dashboard && npx tsc --noEmit && echo "PASS" || echo "FAIL"
```

All should output `PASS`.

---

## What a Perfect Run Looks Like

| Check | Expected |
|---|---|
| `npm test` | All test suites pass |
| `npm run health:check` | All services reachable |
| `npm run morning:start` | Protocols generated for all patients |
| Dashboard loads | RED/YELLOW patients visible, stats correct |
| SBAR modal | Natural language, guideline cited, all 4 sections present |
| Real call placed | Call answered, all questions asked once, no repeats |
| Post-call audit | `P002 PIPELINE: PASS` |
| Protocol approval | Protocol moves to TriageProtocols |
| Protocol rejection | New PENDING_REVIEW appears within 10s |
| TypeScript check | No type errors in any package |

---

## Common Issues

**"No protocol found — cannot initiate call"**
The patient needs an approved protocol. Run `npm run morning:start` or approve a pending review in the dashboard.

**"No phone number found in FHIR"**
Set `TEST_PHONE_NUMBER` in `.env`. The test scripts automatically add this to the patient's FHIR record.

**"FHIR GET Patient failed"**
Check `FHIR_BASE_URL` in `.env`. The FHIR server must be running and reachable.

**Call rings but no questions are asked**
Check that the Lex bot is correctly configured with `lex-fulfillment` as the code hook and that `DYNAMO_TABLE_PROTOCOLS`, `DYNAMO_TABLE_RESULTS`, `BEDROCK_MODEL_EXTRACTOR` are set in the Lambda environment.

**Post-call audit shows SBAR pipeline FAIL**
Most likely the SBAR was not generated yet (summarizer is async). Wait ~30 seconds and re-run the audit.
