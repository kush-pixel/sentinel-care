Write-Host "Starting DynamoDB Local..." -ForegroundColor Cyan
docker start dynamo-local 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Container not found, creating fresh..." -ForegroundColor Yellow
    docker run -d -p 8000:8000 --name dynamo-local amazon/dynamodb-local
    Start-Sleep -Seconds 3
}

Write-Host "Creating local tables if missing..." -ForegroundColor Cyan
$tables = @(
    "PatientProfiles:patient_id",
    "TriageProtocols:patient_id",
    "ClinicalRules:condition_code"
)
foreach ($t in $tables) {
    $name,$key = $t -split ":"
    aws dynamodb create-table --table-name $name `
        --attribute-definitions AttributeName=$key,AttributeType=S `
        --key-schema AttributeName=$key,KeyType=HASH `
        --billing-mode PAY_PER_REQUEST `
        --endpoint-url http://localhost:8000 2>$null
}

aws dynamodb create-table --table-name CallResults `
    --attribute-definitions AttributeName=call_id,AttributeType=S AttributeName=patient_id,AttributeType=S `
    --key-schema AttributeName=call_id,KeyType=HASH AttributeName=patient_id,KeyType=RANGE `
    --billing-mode PAY_PER_REQUEST `
    --endpoint-url http://localhost:8000 2>$null

aws dynamodb create-table --table-name ProtocolReview `
    --attribute-definitions AttributeName=review_id,AttributeType=S AttributeName=patient_id,AttributeType=S `
    --key-schema AttributeName=review_id,KeyType=HASH AttributeName=patient_id,KeyType=RANGE `
    --billing-mode PAY_PER_REQUEST `
    --endpoint-url http://localhost:8000 2>$null

Write-Host "Starting FHIR server..." -ForegroundColor Cyan
docker start fhir-server 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "FHIR container not found, creating fresh..." -ForegroundColor Yellow
    docker run -d -p 8080:8080 --name fhir-server hapiproject/hapi:latest
    Write-Host "Waiting 90 seconds for FHIR server to initialise..." -ForegroundColor Yellow
    Start-Sleep -Seconds 90
}

Write-Host "Local environment ready!" -ForegroundColor Green
Write-Host "DynamoDB Local: http://localhost:8000" -ForegroundColor Green
Write-Host "FHIR Server:    http://localhost:8080/fhir" -ForegroundColor Green
aws dynamodb list-tables --endpoint-url http://localhost:8000
