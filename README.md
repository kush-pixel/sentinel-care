# Sentinel Voice

Sentinel Voice is a multi-agent post-discharge patient triage system that proactively calls patients after hospital discharge, conducts a structured voice assessment via Amazon Connect and Amazon Polly, transcribes and analyses the conversation with Amazon Transcribe and Amazon Bedrock, scores patient risk through an automated triage engine, and either generates a personalised care plan or escalates high-risk cases to clinical staff via SNS — all orchestrated by AWS Step Functions with end-to-end state persisted in DynamoDB and a real-time clinician dashboard served by Next.js.

## Project Structure

```
sentinel-voice/
├── packages/
│   ├── care-planner/        # Lambda: Bedrock-powered care plan generation
│   ├── voice-orchestrator/  # Lambda: Amazon Connect contact-flow driver
│   ├── triage-engine/       # Lambda: risk scoring + SNS escalation
│   ├── summarizer/          # Lambda: Transcribe + Bedrock call summarisation
│   └── dashboard/           # Next.js clinician dashboard
├── shared/
│   ├── schemas/             # Zod validation schemas (shared across packages)
│   └── types/               # TypeScript type definitions (shared across packages)
├── infrastructure/          # AWS CDK stack definitions
├── scripts/                 # Developer utilities: seed data, local invocation
├── .env.example             # All required environment variables (copy to .env)
├── tsconfig.base.json       # Root TypeScript config extended by every package
└── package.json             # npm workspaces root
```

## Prerequisites

- Node.js >= 20
- npm >= 10
- AWS CLI configured (`aws configure` or `AWS_PROFILE` set)
- AWS CDK CLI: `npm install -g aws-cdk`

## Setup

```bash
# 1. Clone and install all workspace dependencies
git clone <repo-url>
cd sentinel-voice
npm install

# 2. Copy and fill in environment variables
cp .env.example .env
# Edit .env with your AWS Account ID, Connect instance IDs, etc.

# 3. Bootstrap CDK (once per account/region)
cd infrastructure
npx cdk bootstrap

# 4. Deploy all stacks
npm run deploy --workspace=infrastructure

# 5. Start the dashboard locally
npm run dev --workspace=@sentinel/dashboard
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

## Cost Target

Designed for < $2 total AWS spend during the 10-day hackathon sprint using Lambda free tier, DynamoDB on-demand, and Bedrock pay-per-token pricing.
