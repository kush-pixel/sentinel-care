/**
 * setup-kvs.ts — Creates the Kinesis Video Streams stream used by Nova Sonic
 * to receive audio from Amazon Connect.
 *
 * Run: cd scripts && npm run setup:kvs
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import {
  KinesisVideoClient,
  CreateStreamCommand,
  DescribeStreamCommand,
} from "@aws-sdk/client-kinesis-video";

const STREAM_NAME = "sentinel-voice-calls";

const client = new KinesisVideoClient({
  region: process.env["AWS_REGION"] ?? "us-east-1",
});

async function main(): Promise<void> {
  console.log("─────────────────────────────────────────────");
  console.log("KVS STREAM SETUP");
  console.log("─────────────────────────────────────────────");

  // STEP 1 — Check if stream already exists
  try {
    const describeResp = await client.send(
      new DescribeStreamCommand({ StreamName: STREAM_NAME })
    );
    const arn = describeResp.StreamInfo?.StreamARN ?? "unknown";
    console.log(`  ✓ Stream already exists — skipping creation`);
    console.log(`\nKVS_STREAM_NAME=${STREAM_NAME}`);
    console.log(`KVS_STREAM_ARN=${arn}`);
    return;
  } catch (err: unknown) {
    const code = (err as { name?: string }).name;
    if (code !== "ResourceNotFoundException") {
      throw err;
    }
    // Stream does not exist — proceed to create
  }

  // STEP 2 — Create stream
  console.log(`  Creating stream: ${STREAM_NAME}...`);
  const createResp = await client.send(
    new CreateStreamCommand({
      StreamName:             STREAM_NAME,
      DataRetentionInHours:   24,
      MediaType:              "audio/pcm",
    })
  );

  const arn = createResp.StreamARN ?? "unknown";
  console.log(`  ✓ Stream created`);

  // STEP 3 — Print env vars
  console.log(`\nKVS_STREAM_NAME=${STREAM_NAME}`);
  console.log(`KVS_STREAM_ARN=${arn}`);
  console.log("─────────────────────────────────────────────");
}

main().catch((err: unknown) => {
  console.error("setup:kvs failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
