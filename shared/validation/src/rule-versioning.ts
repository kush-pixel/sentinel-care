/**
 * rule-versioning.ts — Rule version read/write utilities.
 *
 * Every ClinicalRule record in DynamoDB now uses a composite key:
 *   PK: condition_code   (e.g. "J18.9")
 *   SK: version_id       (e.g. "J18.9#v1", "J18.9#v2", or "LATEST")
 *
 * The "LATEST" record is a lightweight pointer:
 *   { condition_code, version_id: "LATEST", latest_version, latest_version_id, updated_at }
 */

import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { type ClinicalRule } from "@sentinel/schemas";

// ─── getLatestRule ─────────────────────────────────────────────────────────────

/**
 * Fetch the latest approved version of a clinical rule.
 *
 * 1. GetCommand PK=conditionCode, SK="LATEST"  → resolve latest_version_id
 * 2. GetCommand PK=conditionCode, SK=latestVersionId → return full rule
 */
export async function getLatestRule(
  conditionCode: string,
  docClient: DynamoDBDocumentClient,
  tableName: string
): Promise<ClinicalRule | null> {
  try {
    const latestRes = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { condition_code: conditionCode, version_id: "LATEST" },
      })
    );
    if (!latestRes.Item) return null;

    const latestVersionId = latestRes.Item["latest_version_id"] as string | undefined;
    if (!latestVersionId) return null;

    const ruleRes = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { condition_code: conditionCode, version_id: latestVersionId },
      })
    );
    if (!ruleRes.Item) return null;

    return ruleRes.Item as ClinicalRule;
  } catch {
    return null;
  }
}

// ─── getRuleVersion ────────────────────────────────────────────────────────────

/**
 * Fetch a specific version of a clinical rule by version_id.
 * Use this to re-evaluate an existing protocol against the exact rule
 * version it was generated with.
 */
export async function getRuleVersion(
  conditionCode: string,
  versionId: string,
  docClient: DynamoDBDocumentClient,
  tableName: string
): Promise<ClinicalRule | null> {
  try {
    const res = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { condition_code: conditionCode, version_id: versionId },
      })
    );
    if (!res.Item) return null;
    return res.Item as ClinicalRule;
  } catch {
    return null;
  }
}

// ─── createNewRuleVersion ──────────────────────────────────────────────────────

/**
 * Create a new version of an existing rule without overwriting the old one.
 *
 * 1. Reads LATEST to find current version number
 * 2. Marks old version record: is_latest = false, superseded_by = newVersionId
 * 3. Writes new versioned record (inheriting old fields + overrides)
 * 4. Updates LATEST pointer to new version
 *
 * Returns: { versionId: "J18.9#v2", version: 2 }
 */
export async function createNewRuleVersion(
  conditionCode: string,
  updatedRule: Partial<ClinicalRule>,
  changeNotes: string,
  createdBy: string,
  docClient: DynamoDBDocumentClient,
  tableName: string
): Promise<{ versionId: string; version: number }> {
  // STEP 1 — Read LATEST pointer
  const latestRes = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { condition_code: conditionCode, version_id: "LATEST" },
    })
  );
  if (!latestRes.Item) {
    throw new Error(`No LATEST record found for condition_code "${conditionCode}"`);
  }

  const currentVersionId = latestRes.Item["latest_version_id"] as string;
  const currentVersion   = latestRes.Item["latest_version"]    as number;
  const newVersion       = currentVersion + 1;
  const newVersionId     = `${conditionCode}#v${newVersion}`;

  // STEP 2 — Read old versioned record
  const oldRuleRes = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { condition_code: conditionCode, version_id: currentVersionId },
    })
  );
  if (!oldRuleRes.Item) {
    throw new Error(`Rule version "${currentVersionId}" not found`);
  }

  // STEP 3 — Mark old version as superseded
  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { condition_code: conditionCode, version_id: currentVersionId },
      UpdateExpression: "SET is_latest = :il, superseded_by = :sb",
      ExpressionAttributeValues: { ":il": false, ":sb": newVersionId },
    })
  );

  // STEP 4 — Write new versioned record
  const now = new Date().toISOString();
  const newRecord = {
    ...oldRuleRes.Item,
    ...updatedRule,
    version:       newVersion,
    version_id:    newVersionId,
    is_latest:     true,
    effective_from: now,
    superseded_by:  null,
    change_notes:   changeNotes,
    created_by:     createdBy,
    created_at:     now,
  };
  await docClient.send(
    new PutCommand({ TableName: tableName, Item: newRecord })
  );

  // STEP 5 — Update LATEST pointer
  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        condition_code:    conditionCode,
        version_id:        "LATEST",
        latest_version:    newVersion,
        latest_version_id: newVersionId,
        updated_at:        now,
      },
    })
  );

  return { versionId: newVersionId, version: newVersion };
}
