gcloud functions deploy gcs-gemini-processor `
    --gen2 `
    --runtime python312 `
    --region us-central1 `
    --source . `
    --entry-point process_file_upload `
    --trigger-resource gs://course_files_raw `
    --trigger-event google.storage.object.finalize `
    --timeout 540s `
    --memory 1Gi