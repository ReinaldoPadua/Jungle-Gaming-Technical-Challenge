#!/usr/bin/env bash
# Executado pela LocalStack quando o serviço fica pronto (ready.d).
# Idempotente: CreateQueue com os mesmos atributos é no-op.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
VISIBILITY_TIMEOUT=30
MAX_RECEIVE_COUNT=5

create_fifo() {
  local name="$1"; shift
  awslocal sqs create-queue --region "$REGION" --queue-name "$name" \
    --attributes "FifoQueue=true,ContentBasedDeduplication=false,VisibilityTimeout=${VISIBILITY_TIMEOUT}$*" \
    --query QueueUrl --output text
}

queue_arn() {
  awslocal sqs get-queue-attributes --region "$REGION" --queue-url "$1" \
    --attribute-names QueueArn --query Attributes.QueueArn --output text
}

for env_name in wagering wagering_test; do
  suffix=""
  [ "$env_name" = "wagering_test" ] && suffix="-test"

  dlq_url=$(create_fifo "wager-transactions-dlq${suffix}.fifo" ",MessageRetentionPeriod=1209600")
  dlq_arn=$(queue_arn "$dlq_url")

  main_url=$(create_fifo "wager-transactions${suffix}.fifo")
  awslocal sqs set-queue-attributes --region "$REGION" --queue-url "$main_url" \
    --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${dlq_arn}\\\",\\\"maxReceiveCount\\\":\\\"${MAX_RECEIVE_COUNT}\\\"}\"}"

  create_fifo "wallet-events${suffix}.fifo" >/dev/null
  echo "[init-sqs] filas criadas (${env_name}): ${main_url} -> ${dlq_url}"
done

touch /tmp/sqs-ready
