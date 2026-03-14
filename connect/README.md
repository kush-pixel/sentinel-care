# Amazon Connect — Nova Sonic Outbound Flow

## Overview

`nova-sonic-outbound-flow.json` is the Amazon Connect contact flow for
Sentinel Care outbound calls using Nova 2 Sonic bidirectional voice AI.

The flow:
1. Sets contact attributes (patientId, callId, kvsStreamArn)
2. Starts KVS media streaming (audio to/from customer)
3. Invokes the `nova-sonic-handler` Lambda (up to 15 min)
4. Handles Lambda errors gracefully with a patient-facing message
5. Disconnects when Lambda signals completion

## How to import into Connect

1. Open your Connect instance:
   `https://sentinel-voice-demo.my.connect.aws`

2. Navigate to **Routing → Contact flows → Create contact flow**

3. Click the dropdown arrow on **Save** → **Import flow (beta)**

4. Paste the contents of `nova-sonic-outbound-flow.json`

5. Find the **Invoke Lambda function** block and update the Lambda ARN:
   - Replace `LAMBDA_ARN_NOVA_SONIC` with the deployed Lambda ARN
   - Example: `arn:aws:lambda:us-east-1:629843009128:function:sentinel-nova-sonic-handler`

6. Click **Save**, then **Publish**

7. Copy the contact flow ID from the URL and add to `.env`:
   ```
   CONNECT_CONTACT_FLOW_ID=<id-from-url>
   ```

8. Associate with phone number `+17208446427`:
   - **Channels → Phone numbers**
   - Select the number → set Contact flow to `nova-sonic-outbound-flow`

## IAM Requirements

The Lambda execution role needs:
- `bedrock:InvokeModelWithBidirectionalStream` on `amazon.nova-2-sonic-v1:0`
- `kinesisvideo:PutMedia`, `GetMedia`, `DescribeStream`, `GetDataEndpoint`
- `connect:GetContactAttributes`, `UpdateContactAttributes`
- `dynamodb:GetItem`, `PutItem`, `UpdateItem` on all Sentinel tables
- `sns:Publish` on the escalation topic

See `infrastructure/iam-policies/lambda-policy.json`.

## Contact attributes passed to Lambda

| Attribute     | Source                          |
|---------------|---------------------------------|
| `patientId`   | Set by call-initiator Lambda    |
| `callId`      | Set by call-initiator Lambda    |
| `kvsStreamArn`| Set by call-initiator Lambda    |
| `contactId`   | Injected by Connect ($.ContactId)|
| `instanceId`  | Injected by Connect ($.InstanceARN)|

## Testing

To test the contact flow without a real phone call, use the
**Test chat** feature in the Connect console with mock attributes.

For full local testing without Connect, run:
```bash
cd lambdas/nova-sonic-handler
npm run test:local
```
