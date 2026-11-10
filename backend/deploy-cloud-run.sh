#!/usr/bin/env bash
# Deploys the Mission Log API to Google Cloud Run.
# Prereqs: gcloud CLI logged in (`gcloud auth login`) and a project with billing enabled.
# Usage: PROJECT_ID=my-project ./deploy-cloud-run.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-mission-log}"
SECRET="${SECRET:-mission-log-ingest-key}"

gcloud config set project "$PROJECT_ID"

# Fail fast with a clear message: Cloud Run needs a project linked to an OPEN billing account.
if [ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)')" != "True" ]; then
  echo "ERROR: billing is not enabled for $PROJECT_ID." >&2
  echo "Open or create a billing account at https://console.cloud.google.com/billing/manage, then run:" >&2
  echo "  gcloud billing projects link $PROJECT_ID --billing-account=<OPEN_ACCOUNT_ID>" >&2
  exit 1
fi

gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com

# Keep the ingest API key in Secret Manager, not in code or env files.
if ! gcloud secrets describe "$SECRET" >/dev/null 2>&1; then
  openssl rand -hex 24 | gcloud secrets create "$SECRET" --data-file=-
  echo "Created secret $SECRET. Read it with: gcloud secrets versions access latest --secret=$SECRET"
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
gcloud secrets add-iam-policy-binding "$SECRET" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" >/dev/null

# Build from source with Cloud Build and deploy. One instance max because the demo stores
# data in SQLite on the container's local disk (see README: swap in Cloud SQL for durability).
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --max-instances 1 \
  --set-secrets "INGEST_API_KEY=${SECRET}:latest"

echo "Service URL: $(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
