import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { LaceResult } from "./calculator";

/**
 * getLaceForPatient — Read a stored LACE result from PatientProfiles.
 *
 * Returns null if the patient is not found or has no LACE data.
 * Callers should fall back to FHIR calculation when null is returned.
 */
export async function getLaceForPatient(
  patientId: string,
  docClient: DynamoDBDocumentClient,
  tableName: string
): Promise<LaceResult | null> {
  const response = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { patient_id: patientId },
    })
  );

  const item = response.Item;
  if (!item) return null;

  const totalScore = item["lace_score"] as number | undefined;
  const riskLevel  = item["lace_risk_level"] as LaceResult["riskLevel"] | undefined;
  const components = item["lace_components"] as LaceResult["components"] | undefined;

  if (totalScore === undefined || !riskLevel || !components) return null;

  const lengthOfStayDays = (item["lace_length_of_stay_days"] as number | undefined) ?? 0;
  const charlsonScore    = (item["lace_charlson_score"] as number | undefined) ?? 0;
  const interpretation   =
    (item["lace_interpretation"] as string | undefined) ??
    `LACE score ${totalScore}: ${riskLevel} readmission risk.`;

  return {
    totalScore,
    riskLevel,
    components,
    lengthOfStayDays,
    charlsonScore,
    interpretation,
  };
}
