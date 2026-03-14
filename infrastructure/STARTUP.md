# Sentinel Voice — Local Startup Guide

## New Morning Routine (4 steps, ~3 min total)

```
1. Start Docker Desktop
2. Run:  .\scripts\start-local.ps1      ← wait 90 sec for FHIR to initialise
3. Run:  cd scripts && npm run morning:start
4. Run:  cd dashboard && npm run dev
5. Open: http://localhost:3000
```

`morning:start` runs the full startup pipeline automatically — no manual steps.

### What morning:start does

| Step | Action                                    | Output                         |
|------|-------------------------------------------|-------------------------------|
| 0    | Verify FHIR + DynamoDB are running        | ✓ FHIR server running         |
| 1    | Clear stale protocol reviews              | ✓ Stale reviews cleared       |
| 2    | Seed FHIR patients, encounters, rules     | ✓ Base data seeded            |
| 3    | Calculate LACE from FHIR → PatientProfiles| ✓ LACE scores hydrated        |
| 4    | Seed demo call results (5 patients)       | ✓ Call results seeded         |
| 5    | Run Care Planner for all 6 patients       | ✓ 6/6 protocols generated     |
| 6    | Run Triage Engine for 5 patients          | ✓ Triage results complete     |
| 7    | Run SBAR Summarizer for 5 patients        | ✓ SBAR summaries generated    |
| 8    | Reset ProtocolReview → REV-P004-DEMO      | ✓ 1 pending review (P004)     |
| 9    | Verify all tables are in correct state    | ✓ All checks pass             |

### Expected dashboard state after startup

| Patient | Triage | LACE | Notes                          |
|---------|--------|------|--------------------------------|
| P001    | RED    | 10 HIGH | CHF — weight gain + Lasix   |
| P002    | YELLOW | 2 LOW   | Post-op knee — pain 7/10    |
| P003    | GREEN  | 7 MODERATE | Diabetes — well-controlled |
| P004    | —      | 9 MODERATE | PENDING REVIEW (J18.9)     |
| P005    | RED    | 9 MODERATE | Acute MI — chest pain      |
| P006    | INCOMPLETE | 4 LOW | CKD — patient unreachable  |

- Dashboard header: **2 RED, 1 YELLOW, 1 GREEN, 1 INCOMPLETE, 1 PENDING REVIEW**
- All LACE scores populated (no UNKNOWN)
- SBAR modal opens correctly for all 5 completed patients

### Idempotency

`morning:start` is safe to run multiple times. Each step is idempotent:
- FHIR PUT is upsert — no duplicates
- DynamoDB PutCommand with same key overwrites existing record
- Care Planner generates a fresh review ID each time

---

## Old Manual Sequence (kept for reference)

Before `morning:start` existed, the 10-step manual process was:

```bash
# In scripts/ directory:
npm run clear:reviews          # 1. Clear stale reviews
npm run seed:fhir              # 2. Seed FHIR patients
npm run seed:encounters        # 3. Seed encounters
npm run seed:rules             # 4. Seed clinical rules
npm run lace:hydrate           # 5. Calculate LACE scores
npm run seed:demo              # 6. Seed call results
# Manually invoke care planner for each patient (P001-P006)
# Manually invoke triage engine for each call (C001-C006)
# Manually invoke summarizer for each call (C001-C006)
npm run seed:pending-review    # 10. Seed P004 PENDING_REVIEW
```

Problems with the manual process:
- Wrong step order → LACE UNKNOWN in dashboard
- Forgetting a step → stale data from previous run
- No verification → silent failures
- ~10 minutes of commands vs ~3 minutes automated

---

## Troubleshooting

### FHIR server not running
```
✗ FHIR server not running
  Start Docker Desktop and run:
  scripts\start-local.ps1
  Wait 90 seconds then run this again.
```
HAPI FHIR takes 60-90 seconds to initialise. Wait for start-local.ps1 to finish.

### DynamoDB table missing (PatientProfiles)
If you see `Cannot do operations on a non-existent table`:
```powershell
aws dynamodb create-table --table-name PatientProfiles `
  --attribute-definitions AttributeName=patient_id,AttributeType=S `
  --key-schema AttributeName=patient_id,KeyType=HASH `
  --billing-mode PAY_PER_REQUEST `
  --endpoint-url http://localhost:8000
```
Then re-run `start-local.ps1` (it creates all tables automatically).

### Care Planner fails for a patient
Bedrock is called for each patient. If AWS credentials are missing or Bedrock is
unavailable, the care planner uses a fallback protocol. The triage engine will
still run with the fallback. Check AWS credentials in `.env`.

### Running the demo flow
After `morning:start`, the P004 demo flow works:
```bash
npm run demo:flow   # Full P004 PENDING → APPROVED → RED journey
npm run demo:reset  # Reset P004 back to PENDING_REVIEW
```
