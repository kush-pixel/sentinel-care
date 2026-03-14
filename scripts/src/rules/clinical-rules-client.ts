import * as dotenv from "dotenv";
import * as path from "path";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { type ClinicalRule, ClinicalRuleSchema } from "@sentinel/schemas";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// ─── DynamoDB client ──────────────────────────────────────────────────────────

function makeClient(): DynamoDBClient {
  return new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"]
      ? { endpoint: process.env["DYNAMO_ENDPOINT"] }
      : {}),
  });
}

function rulesTable(): string {
  return process.env["DYNAMO_TABLE_RULES"] ?? "ClinicalRules";
}

// ─── Exported functions ───────────────────────────────────────────────────────

export async function getRulesForCondition(
  conditionCode: string
): Promise<ClinicalRule | null> {
  try {
    const client = makeClient();
    const tbl = rulesTable();

    // 1. Read LATEST pointer to find the current version_id
    const latestRes = await client.send(
      new GetItemCommand({
        TableName: tbl,
        Key: marshall({ condition_code: conditionCode, version_id: "LATEST" }),
      })
    );
    if (!latestRes.Item) return null;

    const latestData = unmarshall(latestRes.Item) as { latest_version_id?: string };
    const latestVersionId = latestData.latest_version_id;
    if (!latestVersionId) return null;

    // 2. Fetch the actual versioned rule record
    const ruleRes = await client.send(
      new GetItemCommand({
        TableName: tbl,
        Key: marshall({ condition_code: conditionCode, version_id: latestVersionId }),
      })
    );
    if (!ruleRes.Item) return null;

    const raw = unmarshall(ruleRes.Item);
    const parsed = ClinicalRuleSchema.safeParse(raw);
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export async function getRulesForPatient(
  conditionCodes: string[]
): Promise<ClinicalRule[]> {
  const results = await Promise.all(
    conditionCodes.map((code) => getRulesForCondition(code))
  );
  return results.filter((r): r is ClinicalRule => r !== null);
}
