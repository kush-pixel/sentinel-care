# Sentinel Care — Post-Discharge Voice Triage System

> **Automated AI voice calls that assess discharged patients before they become readmissions.**

Sentinel Care places outbound phone calls to hospital patients after discharge, conducts a structured clinical assessment using natural speech, and delivers a real-time triage report to the care team's dashboard — complete with an AI-generated SBAR clinical summary and immediate SNS escalation for high-risk patients.

---

## The Problem

Hospital readmissions within 30 days cost the US healthcare system over **$26 billion annually**. Most readmissions are preventable — patients leave the hospital, symptoms worsen at home, and no one follows up until it's too late.

Traditional phone-based follow-up programs fail because:
- **Nurse bandwidth** — manually calling every discharged patient doesn't scale
- **Inconsistency** — different nurses ask different questions; data is scattered
- **Latency** — a patient might deteriorate for days before anyone calls

## The Solution

Sentinel Care automates the entire follow-up loop:

```
Discharge → AI generates personalized triage protocol
         → System places outbound voice call (Amazon Connect + Lex)
         → Patient answers clinical questions in natural speech
         → AI extracts structured data in real time (Bedrock Nova Lite)
         → Triage engine evaluates against clinical rules (LACE + condition-specific)
         → SBAR summary generated and sent to nurse dashboard
         → Nurse reviews, acknowledges, escalates if needed
         → RED triage → immediate SNS alert to care team
```

---

## Architecture

```
Amazon Connect (outbound call)
        │
        ▼
Amazon Lex v2 (SentinelVoiceBot)
   lex-fulfillment Lambda ──── extracts answers via Amazon Bedrock (Nova Lite)
        │
        ├──► sentinel-triage-engine Lambda  (clinical rule evaluation + LACE scoring)
        │
        └──► sentinel-summarizer Lambda     (SBAR summary via Bedrock Nova Lite)
                                                 │
                                                 └──► SNS alert (RED triage only)

sentinel-care-planner Lambda   ← invoked on new patient or nurse rejection
   (protocol generation via Bedrock Nova Pro)
        │
        └──► ProtocolReview DynamoDB table  ← nurse approves/rejects via dashboard

HAPI FHIR R4 Server  ← patient demographics, conditions, medications, LACE inputs
DynamoDB Tables      ← PatientProfiles, TriageProtocols, CallResults,
                        ClinicalRules (versioned), ProtocolReview

Next.js Dashboard    ← real-time triage view, protocol review queue, SBAR modal
```

---

## Key Features

| Feature | Description |
|---|---|
| **Personalized protocols** | Care Planner generates condition-specific question sets using the patient's FHIR record and versioned clinical rules library |
| **Natural voice conversation** | Amazon Lex + Nova Lite understand patient speech including spelled-out numbers, hedged answers, and off-topic speech |
| **LACE readmission risk** | Calculates L·A·C·E index from encounter data at care-planning time; embedded in every SBAR |
| **Intelligent triage** | Weighted rule engine evaluates collected answers against clinical thresholds; produces RED/YELLOW/GREEN classification |
| **SBAR generation** | Structured clinical summaries with guideline citations, natural language only — no technical notation leaked to nurses |
| **Protocol versioning** | Clinical rules are versioned; each protocol tracks which rule version it was generated from |
| **Human-in-the-loop** | Low-confidence AI protocols go to nurse review queue; nurses approve or reject with reasons; rejections trigger automatic regeneration |
| **SNS escalation** | RED triage results publish an immediate alert to the care team |
| **Multi-language support** | English and Spanish supported throughout the full conversation flow |
| **Audit trail** | Every data access, protocol generation, SBAR creation, and nurse action is logged |

---

## Repository Structure

```
sentinel-care/
├── lambdas/
│   ├── lex-fulfillment/      # Dialog code hook — drives the patient conversation
│   ├── care-planner/         # Generates personalized triage protocols (Nova Pro)
│   ├── summarizer/           # Generates SBAR clinical summaries (Nova Lite)
│   ├── call-initiator/       # Places outbound calls via Amazon Connect
│   ├── call-bridge/          # Bridges Connect to downstream processing
│   ├── call-complete/        # Finalizes call record, triggers triage
│   ├── answer-collector/     # Writes individual answers to DynamoDB
│   ├── extractor/            # Extracts structured values from speech transcripts
│   └── nova-sonic-handler/   # Nova 2 Sonic bidirectional voice handler
│
├── dashboard/                # Next.js nurse triage dashboard
│   └── src/app/
│       ├── page.tsx          # Main dashboard UI (triage + protocol review tabs)
│       └── api/              # REST endpoints (patients, protocols, acknowledge)
│
├── packages/
│   ├── schemas/              # Zod schemas for TriageProtocol, ClinicalRule
│   ├── lace/                 # LACE score calculation library
│   ├── audit/                # Audit log utility
│   ├── types/                # Shared TypeScript types
│   └── validation/           # Input validators, ID generators, rule helpers
│
├── scripts/                  # Developer utilities (seed, deploy, test, audit)
├── step-functions/           # AWS Step Functions state machine definition
└── .env.example              # All required environment variables with documentation
```

---

## AWS Services Used

| Service | Role |
|---|---|
| **Amazon Connect** | Outbound voice call placement and contact flow management |
| **Amazon Lex v2** | Speech recognition and dialog management (SentinelVoiceBot) |
| **Amazon Bedrock — Nova Pro** | Generates personalized triage protocols from patient FHIR data |
| **Amazon Bedrock — Nova Lite** | Extracts structured answers from patient speech; generates SBAR summaries |
| **Amazon Bedrock — Nova 2 Sonic** | Bidirectional voice conversation for direct call handling |
| **Amazon Polly** | Neural TTS for pre-generated question audio |
| **AWS Lambda** | All backend processing (8 Lambda functions) |
| **Amazon DynamoDB** | Patient profiles, protocols, call results, clinical rules, review queue |
| **Amazon SNS** | RED-alert escalation to care team |
| **Amazon S3** | Polly audio cache |
| **Amazon Kinesis Video Streams** | Audio bridge for Nova Sonic calls |
| **HAPI FHIR R4 Server** | Patient demographics, conditions, medications |

---

## Getting Started

> The AWS infrastructure (EC2, Lambda, Connect, Lex, DynamoDB) is already deployed and running. You just need to configure your local environment and seed the demo data.

### Prerequisites

**Node.js 20+**
```bash
node --version  # v20.x.x or higher
npm --version   # v9.x.x or higher
```

**AWS SDK (included)**

AWS credentials are pre-configured in `.env.judge`. No AWS CLI installation required. The project uses the AWS SDK directly via the credentials in your `.env` file.

**Clone and install**
```bash
git clone https://github.com/kush-pixel/sentinel-care
cd sentinel-care
npm install
```

### Step 1 — Configure environment

A pre-configured environment file is included:

```bash
cp .env.judge .env
```

To test calls on YOUR phone, edit `.env` and change:

```
TEST_PHONE_NUMBER=+1XXXXXXXXXX
```

### Step 2 — Reset demo state

```bash
cd scripts
npm run morning:start
```

Takes ~50 seconds. Loads 6 demo patients with triage protocols, LACE scores, and SBAR summaries.

### Step 3 — Start the dashboard

```bash
cd dashboard
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### Step 4 — Test a real call (optional)

Set your phone number in `.env`:
```
TEST_PHONE_NUMBER=+1XXXXXXXXXX
```

Then:
```bash
cd scripts
npm run test:real-call
```

Your phone will ring from `+17208446427`. Answer and speak naturally to Nova 2 Sonic.

---

## How the Call Flow Works

1. **Care Planner** generates a personalized protocol:
   - Loads FHIR record; calculates LACE score
   - Fetches latest versioned clinical rules for the patient's condition
   - Calls Bedrock Nova Pro to produce a structured protocol (question list + thresholds)
   - High-confidence protocols are auto-approved; others go to nurse review

2. **Call Initiator** places the outbound call:
   - Confirms an approved protocol exists
   - Writes initial `CallResults` record (status: `IN_PROGRESS`)
   - Places call via Amazon Connect with `patientId` and `callId` in attributes

3. **Lex Fulfillment** drives the conversation:
   - Formats each protocol question for natural speech
   - Calls Bedrock Nova Lite to extract a structured value from the patient's response
   - Handles low-confidence answers with a single clarification prompt
   - Handles Lex no-input timeout events by rolling back and re-asking
   - Writes each confirmed answer to DynamoDB in real time
   - On completion: synchronously invokes triage engine, then fires summarizer async

4. **Triage Engine** evaluates the answers:
   - Compares each variable against its protocol condition and threshold
   - Applies weighted scoring with LACE risk modifier
   - Returns `RED` / `YELLOW` / `GREEN` + list of broken rules

5. **Summarizer** produces the SBAR:
   - Converts raw rule strings to natural language
   - Calls Bedrock Nova Lite to generate a 4-section SBAR with guideline citation
   - Saves to `CallResults`; triggers SNS RED alert if needed

6. **Nurse Dashboard** shows the result:
   - Auto-refreshes every 30 seconds; RED/YELLOW patients shown first
   - Click a patient card → view full SBAR, broken rules, LACE breakdown
   - Acknowledge receipt → clears from active queue
   - Protocol Review tab → approve or reject with clinical notes

---

## Clinical Rules and LACE

Rules are stored in DynamoDB with full version history:

```json
{
  "condition_code": "Z96.651",
  "condition_display": "Left knee joint replacement",
  "version": 2,
  "guideline_source": "AAOS Post-Arthroplasty Recovery Protocol",
  "conditions": [
    { "variable": "fever",          "operator": "==", "threshold": true, "weight": 0.85, "flag_color": "RED"    },
    { "variable": "wound_drainage", "operator": "==", "threshold": true, "weight": 0.90, "flag_color": "RED"    },
    { "variable": "pain_level",     "operator": ">=", "threshold": 7,    "weight": 0.70, "flag_color": "YELLOW" }
  ]
}
```

LACE readmission risk index:
- **L** — Length of inpatient stay (days)
- **A** — Acuity of admission (emergent vs elective)
- **C** — Charlson comorbidity index
- **E** — Emergency department visits (prior 6 months)

Scores ≥ 10 are HIGH risk; ≥ 13 are VERY HIGH risk. LACE is calculated at care-planning time and embedded in every triage result and SBAR.

---

## Running Tests

```bash
# Unit tests (all packages from repo root)
npm test

# TypeScript type checking
cd lambdas/lex-fulfillment && npx tsc --noEmit
cd lambdas/care-planner    && npx tsc --noEmit
cd dashboard               && npx tsc --noEmit

# End-to-end post-call audit
cd scripts && npm run post-call-audit -- <patientId> [callId]
```

See [TESTING.md](TESTING.md) for the full judge-facing test guide including expected outputs.

---

## Security Notes

- Patient identifiers use validated format (`P\d{3}` or UUID) — rejected at Lambda boundary
- Sensitive data (PHI) is never written to CloudWatch logs
- Every data access, protocol action, and nurse interaction is captured in the audit log
- `.env` is git-ignored; `.env.example` documents every required key
- Dashboard API routes are rate-limited
- SNS alert on RED triage — missing `ESCALATION_TOPIC_ARN` produces a `console.warn`, not a crash

---

## License

MIT
