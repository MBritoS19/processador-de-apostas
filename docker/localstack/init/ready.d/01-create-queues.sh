#!/bin/bash
# Cria as filas FIFO do processador. Nomes e maxReceiveCount vêm do docker compose,
# com os mesmos defaults da aplicação (.env.example).
# Idempotente para os mesmos atributos: create-queue devolve a fila existente.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
QUEUE_NAME="${SQS_WAGER_QUEUE_NAME:-wager-transactions.fifo}"
DLQ_NAME="${SQS_WAGER_DLQ_NAME:-wager-transactions-dlq.fifo}"
MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-10}"

if ! [[ "$MAX_RECEIVE_COUNT" =~ ^[1-9][0-9]*$ ]] || (( MAX_RECEIVE_COUNT > 1000 )); then
  echo "SQS_MAX_RECEIVE_COUNT inválido: '${MAX_RECEIVE_COUNT}' (esperado inteiro entre 1 e 1000)" >&2
  exit 1
fi
for name in "$QUEUE_NAME" "$DLQ_NAME"; do
  if ! [[ "$name" =~ ^[A-Za-z0-9_-]{1,75}\.fifo$ ]]; then
    echo "Nome de fila FIFO inválido: '${name}'" >&2
    exit 1
  fi
done

DLQ_URL=$(awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name "$DLQ_NAME" \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600 \
  --query QueueUrl --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --region "$REGION" \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

ATTRIBUTES_FILE=$(mktemp)
trap 'rm -f "$ATTRIBUTES_FILE"' EXIT

# RedrivePolicy é uma string JSON dentro do JSON de atributos (aspas escapadas).
# Os valores interpolados foram validados acima ou vêm do próprio LocalStack (ARN).
cat > "$ATTRIBUTES_FILE" <<JSON
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "false",
  "VisibilityTimeout": "30",
  "RedrivePolicy": "{\\"deadLetterTargetArn\\":\\"${DLQ_ARN}\\",\\"maxReceiveCount\\":\\"${MAX_RECEIVE_COUNT}\\"}"
}
JSON

awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name "$QUEUE_NAME" \
  --attributes "file://${ATTRIBUTES_FILE}" >/dev/null

echo "Filas criadas: ${QUEUE_NAME} -> DLQ ${DLQ_ARN} (maxReceiveCount=${MAX_RECEIVE_COUNT})"
