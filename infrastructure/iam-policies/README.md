# IAM Least-Privilege Policy — Sentinel Voice Lambdas

`lambda-policy.json` documents the minimum IAM permissions required across all Lambda functions. In production, create one execution role per Lambda and grant only the actions that Lambda actually calls.

---

## Statement Breakdown

### DynamoDBAccess

**Actions:** `GetItem`, `PutItem`, `UpdateItem`, `Query`, `Scan`

**Tables and which Lambdas use them:**

| Table | Lambdas |
|---|---|
| `PatientProfiles` | care-planner (FHIR data seed) |
| `TriageProtocols` | care-planner (write), triage-engine (read), call-initiator (read), call-complete (read) |
| `CallResults` | call-initiator (write), answer-collector (read/write), call-complete (read/write), triage-engine (read/write), summarizer (read/write) |
| `ClinicalRules` | care-planner (read), summarizer (read) |
| `ProtocolReview` | care-planner (write) |

**Scope:** Per-Lambda roles should restrict `Resource` to only the tables that Lambda reads or writes.

---

### BedrockAccess

**Actions:** `bedrock:InvokeModel`

**Models and which Lambdas use them:**

| Model | Lambda |
|---|---|
| `amazon.nova-pro-v1:0` | care-planner — generates TriageProtocol JSON |
| `amazon.nova-lite-v1:0` | summarizer — generates SBAR clinical summary |

**Scope:** care-planner does not need nova-lite; summarizer does not need nova-pro. Per-Lambda roles should restrict to one model ARN each.

---

### SNSPublish

**Actions:** `sns:Publish`

**Topic:** `sentinel-red-escalation`

**Lambdas:** triage-engine and summarizer both publish RED alerts to this topic.

---

### S3AudioAccess

**Actions:** `s3:PutObject`, `s3:GetObject`

**Bucket:** `sentinel-audio-629843009128`

**Lambda:** care-planner — uploads Polly-synthesized question audio files.

**Scope:** `/*` suffix limits to objects within the bucket, not bucket-level operations.

---

### PollyAccess

**Actions:** `polly:SynthesizeSpeech`

**Lambda:** care-planner — converts triage questions to audio.

**Note:** Polly does not support resource-level restrictions on `SynthesizeSpeech`; `"Resource": "*"` is required.

---

### LambdaInvoke

**Actions:** `lambda:InvokeFunction`

**Pattern:** `arn:aws:lambda:us-east-1:629843009128:function:sentinel-*`

**Lambda:** call-complete — invokes the triage-engine Lambda when a call ends.

**Scope:** Wildcard `sentinel-*` matches all Sentinel functions. In production, restrict to the specific triage-engine function ARN.

---

### CloudWatchLogs

**Actions:** `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`

**All Lambdas** need this to write execution logs to CloudWatch.

---

## Production Hardening Checklist

- [ ] Create one IAM execution role per Lambda (not a shared role)
- [ ] Restrict `Resource` to the specific tables/topics/functions each Lambda uses
- [ ] Replace `sentinel-*` wildcard in LambdaInvoke with the exact triage-engine ARN
- [ ] Enable AWS Config rules to detect overly-permissive policies
- [ ] Enable CloudTrail in all regions to audit API calls
- [ ] Tag all roles with `Service=sentinel-voice` for cost allocation and auditing
