# Make sure to replace placeholders like [YOUR_PROJECT_ID] and [YOUR_SECRET_TOKEN]

gcloud functions deploy gcs-gemini-processor `
    --gen2 `
    --runtime python312 `
    --region us-central1 `
    --source . `
    --entry-point process_file_upload `
    --trigger-resource gs://course_files_raw1 `
    --trigger-event google.storage.object.finalize `
    --timeout 540s `
    --memory 4Gi `
    --cpu 2 `
    --concurrency 1 `
    --set-env-vars BACKEND_WEBHOOK_URL="https://6c4313baa499.ngrok-free.app/api/gcs-webhook"

gcloud functions deploy gcs-gemini-processor `
    --gen2 `
    --runtime python312 `
    --region us-central1 `
    --source . `
    --entry-point process_file_upload `
    --trigger-resource gs://course_files_raw1 `
    --trigger-event google.storage.object.finalize `
    --timeout 1800s `
    --memory 4Gi `
    --cpu 2 `
    --concurrency 1 `
    --update-env-vars BACKEND_WEBHOOK_URL="https://7c08bb32e2df.ngrok-free.app/api/gcs-webhook"