# Sentinel Voice — Security Configuration

This document describes what PHI is stored, what is logged, and what must be done before moving to production.

---

## 1. What PHI Is Stored and Where

| Data | Table | Fields |
|---|---|---|
| Patient identity | `PatientProfiles` | `patient_id` (de-identified key), condition codes, medication codes, discharge date |
| Triage outcomes | `CallResults` | `patient_id`, `call_id`, triage status, broken rule names, SBAR summary, LACE score |
| Triage protocols | `TriageProtocols` | `patient_id`, rule tree, question list — no free-text PHI |
| Protocol review | `ProtocolReview` | `patient_id`, protocol JSON, confidence score |
| Clinical rules | `ClinicalRules` | Condition codes and thresholds — no patient data |

**PHI fields in `CallResults`:** `sbar_summary` contains free-text clinical narrative (situation, background, assessment, recommendation). This is the highest-sensitivity field in the system.

All tables are in `us-east-1`. DynamoDB encryption at rest is enabled by default using AWS-managed keys. In production, use customer-managed KMS keys.

---

## 2. What Is Logged and What Is Never Logged

### What the `@sentinel/audit` logger emits

Every `[AUDIT]` line contains:

```
[AUDIT] {ISO-timestamp} {eventType} patient={patientId} by={performedBy} action={action} success={success}
```

**Logged:** `patientId`, `eventType`, `callId` (internal system key), `performedBy`, `action` (system-controlled string), `success`

### What is NEVER logged

- Patient names, dates of birth, phone numbers
- Variable values extracted from call transcripts (e.g. `weight_gain_lbs: 4`)
- SBAR summary content (clinical free-text)
- DynamoDB table names (sanitised out of error messages)
- Internal file paths or stack traces (sanitised by `sanitiseError()`)
- API tokens, environment variable values

### Error sanitisation

All Lambda handler errors returned to callers go through `sanitiseError()` from `@sentinel/validation`, which strips path-like strings and never exposes stack traces. Dashboard API routes return only `"Internal server error"` on 500.

---

## 3. How to Rotate Credentials

### AWS credentials (local development)

Stored in `.env` at the project root (excluded from git via `.gitignore`). Rotate by:

1. Generating a new access key in IAM console
2. Updating `.env` with the new `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
3. Deactivating the old key in IAM (wait 24h before deleting to confirm nothing breaks)

### Lambda execution roles (production)

Lambda uses IAM execution roles — no long-lived credentials. Roles rotate automatically via AWS STS. No manual rotation needed.

### SNS topic ARN / Connect instance IDs

Stored as environment variables in Lambda configuration. Rotate by updating the Lambda environment variable in the AWS console or via CDK re-deploy.

---

## 4. Security Headers Applied

Set on all routes via `dashboard/next.config.mjs`:

| Header | Value | Purpose |
|---|---|---|
| `X-Frame-Options` | `SAMEORIGIN` | Prevents clickjacking |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME-type sniffing |
| `X-XSS-Protection` | `1; mode=block` | Legacy XSS filter for older browsers |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referrer leakage |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Disables sensitive browser APIs |
| `X-DNS-Prefetch-Control` | `on` | Improves latency (non-security) |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; ...` | Restricts resource origins |

**Note:** `'unsafe-eval'` and `'unsafe-inline'` in `script-src` are required by Next.js dev mode. In production, use nonce-based CSP to remove these directives.

---

## 5. Rate Limits Configured

| Route | Limit | Window |
|---|---|---|
| `GET /api/patients` | 60 requests | 60 seconds |
| `POST /api/patients/[id]/acknowledge` | 20 requests | 60 seconds |

Rate limiting uses an in-memory `Map` keyed by route name (not IP). This resets on server restart and is suitable for demo use. In production, use a Redis-backed store (e.g. Upstash via `@upstash/ratelimit`) shared across all Next.js instances.

---

## 6. Input Validation Rules

Implemented in `shared/validation/src/index.ts`:

| Function | Rule |
|---|---|
| `validatePatientId(id)` | Must be a string, exactly 4 characters, matching `/^P\d{3}$/` (P001–P999) |
| `validateCallId(id)` | Must be a string, exactly 4 characters, matching `/^C\d{3}$/` (C001–C999) |
| `validateConfidence(c)` | Must be a number in `[0.0, 1.0]` inclusive |
| `sanitiseError(err)` | Strips path-like substrings; returns `"An internal error occurred"` for unknown types |

All Lambda handlers validate `patientId` (and `callId` where applicable) at the top of the handler before any DynamoDB access.

---

## 7. What to Do Before Going to Production

### Authentication
- [ ] Add AWS Cognito or an identity provider in front of the Next.js dashboard
- [ ] Require authenticated sessions for all `/api/*` routes
- [ ] Add per-user rate limiting keyed on authenticated user ID, not route name

### Network isolation
- [ ] Deploy all Lambdas into a VPC with private subnets
- [ ] Use VPC endpoints for DynamoDB, SNS, S3, Bedrock, and Polly (no traffic over public internet)
- [ ] Restrict the Next.js dashboard to a VPN or private network

### Encryption
- [ ] Enable DynamoDB encryption with customer-managed KMS keys (one key per table tier)
- [ ] Enable S3 server-side encryption (SSE-KMS) on the audio bucket
- [ ] Enforce HTTPS only — set `HSTS` header with `max-age=63072000; includeSubDomains; preload`

### WAF and threat protection
- [ ] Attach AWS WAF to the API Gateway (or CloudFront distribution) in front of the dashboard
- [ ] Enable AWS Shield Standard (included) or Advanced for DDoS protection
- [ ] Enable Amazon GuardDuty for threat detection across the AWS account

### Audit and compliance
- [ ] Enable CloudTrail in all regions (including global service events)
- [ ] Ship Lambda CloudWatch logs to a dedicated log archive account
- [ ] Review `[AUDIT]` lines daily — set a CloudWatch Alarm on `ERROR` or `success=false` patterns
- [ ] Conduct a HIPAA risk assessment before handling real patient data

### CSP hardening
- [ ] Replace `'unsafe-eval'` and `'unsafe-inline'` in CSP with nonce-based policy
- [ ] Add `Strict-Transport-Security` header once deployed over HTTPS

### Secrets management
- [ ] Move all secrets from `.env` to AWS Secrets Manager or Parameter Store
- [ ] Use Lambda environment variable encryption with a KMS key
