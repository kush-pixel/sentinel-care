# Sentinel Care

Sentinel Care is a multi-agent post-discharge patient triage system that proactively calls patients after hospital discharge, conducts a structured voice assessment via Amazon Connect and Amazon Polly, transcribes and analyses the conversation with Amazon Transcribe and Amazon Bedrock, scores patient risk through an automated triage engine, and either generates a personalised care plan or escalates high-risk cases to clinical staff via SNS — all orchestrated by AWS Step Functions with end-to-end state persisted in DynamoDB and a real-time clinician dashboard served by Next.js.

## Project Structure

```
sentinel-care/
├── lambdas/
│   └── care-planner/        # Care plan generation: Bedrock + Polly + DynamoDB
├── packages/
│   ├── voice-orchestrator/  # Amazon Connect contact-flow driver
│   ├── triage-engine/       # Risk scoring + SNS escalation
│   ├── summarizer/          # Transcribe + Bedrock call summarisation
│   └── dashboard/           # Next.js clinician dashboard
├── shared/
│   ├── lace/                # LACE readmission risk score calculator (pure TS)
│   ├── schemas/             # Zod validation schemas (shared across packages)
│   └── types/               # TypeScript type definitions
├── scripts/                 # Developer utilities: seed data, FHIR client, verify
│   └── src/
│       ├── fhir/            # FHIR R4 client + patient/encounter seed data
│       ├── rules/           # DynamoDB clinical rules client + seed
│       ├── reviews/         # Demo call results + protocol review seed
│       └── lace/            # LACE score report across all patients
├── infrastructure/          # AWS CDK stack definitions
├── start-local.ps1          # Start DynamoDB Local + HAPI FHIR server
├── .env.example             # All required environment variables
├── tsconfig.base.json       # Root TypeScript config extended by every package
└── package.json             # npm workspaces root
```

## Sections Completed

| Section | Description | Status |
|---------|-------------|--------|
| 0 | Environment verification — AWS services, .env, project structure | ✅ |
| 1 | Shared Zod schemas — TriageProtocol, ClinicalRule, ProtocolReview, LaceResult | ✅ |
| 2 | Patient data layer — FHIR client, 6 patients, clinical rules, LACE calculator | ✅ |
| 3 | Care planner — Nova Lite prompt, confidence scoring, Polly audio, DynamoDB writes | ✅ |

## Prerequisites

- Node.js >= 20
- npm >= 10
- Docker (for DynamoDB Local and HAPI FHIR)
- AWS CLI configured with credentials that have access to Bedrock, Polly, S3, DynamoDB
- AWS CDK CLI: `npm install -g aws-cdk`

## Local Development Setup

```powershell
# 1. Clone and install all workspace dependencies
git clone <repo-url>
cd sentinel-care
npm install

# 2. Copy and fill in environment variables
cp .env.example .env
# Edit .env with your AWS Account ID, region, table names, Bedrock model, etc.

# 3. Start local services (DynamoDB Local + HAPI FHIR R4)
./scripts/start-local.ps1

# 4. Seed all data (patients, encounters, rules, demo results, reviews)
cd scripts
npm run seed:all

# 5. Verify Section 2 is complete
npm run verify
# Expected: OVERALL: SECTION 2 COMPLETE (12/12 checks)

# 6. Run LACE score report
npm run lace
```

## Care Planner (Section 3)

```bash
# Build check — zero TypeScript errors
cd lambdas/care-planner
npm run build

# Unit tests — confidence scoring
npm test
# Expected: 6 passed, coverage >= 93%

# Local integration test — runs all 6 patients against live services
npm run test:local
# Expected: OVERALL: SECTION 3 COMPLETE
```

## Build

```bash
# Build all packages
npm run build

# Typecheck all packages
npm run typecheck

# Clean all build artefacts
npm run clean
```

## Key Environment Variables

| Variable | Description |
|----------|-------------|
| `FHIR_BASE_URL` | HAPI FHIR R4 server (local: `http://localhost:8080/fhir`) |
| `DYNAMO_ENDPOINT` | DynamoDB Local endpoint (local: `http://localhost:8000`) |
| `DYNAMO_TABLE_PROTOCOLS` | TriageProtocols table name |
| `DYNAMO_TABLE_RULES` | ClinicalRules table name |
| `DYNAMO_TABLE_REVIEWS` | ProtocolReview table name |
| `BEDROCK_MODEL_CARE_PLANNER` | Nova Lite model ID (`amazon.nova-lite-v1:0`) |
| `POLLY_VOICE_ID` | Polly voice (e.g. `Joanna`) |
| `S3_AUDIO_BUCKET` | S3 bucket for generated audio files |
| `CONFIDENCE_THRESHOLD` | Auto-approval threshold (default `0.7`) |
| `AWS_REGION` | AWS region (e.g. `us-east-1`) |

## Architecture

```
Patient discharge
      │
      ▼
 HAPI FHIR R4 ──► getFullPatientRecord()
                        │
              ┌─────────┴──────────┐
              ▼                    ▼
       LACE Calculator      Clinical Rules
       (shared/lace)        (DynamoDB)
              │                    │
              └─────────┬──────────┘
                        ▼
               buildCarePlannerPrompt()
                        │
                        ▼
              Amazon Bedrock Nova Lite
              (triage protocol JSON)
                        │
                   Zod validation
                  /             \
           PASS                  FAIL
             │                    │
        protocol             fallback protocol
             │                    │
             └────────┬───────────┘
                      ▼
              scoreConfidence()
             /                  \
        score > 0.7          score <= 0.7
             │                    │
       AUTO_APPROVED        PENDING_REVIEW
             │                    │
      TriageProtocols        ProtocolReview
      (DynamoDB)             (DynamoDB — awaits nurse)
             │
      generateQuestionAudio()
      (Polly → S3, skipped in local dev)
```

## Cost Target

Designed for < $2 total AWS spend during the 10-day hackathon sprint using Lambda free tier, DynamoDB on-demand, and Bedrock pay-per-token pricing.
