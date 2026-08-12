# Fill in project_id with your real GCP project (the existing one you're reusing).
# Never commit db_password here — pass it via -var or TF_VAR_db_password.
project_id  = "REPLACE_ME"
region      = "us-central1"
environment = "dev"
db_tier     = "db-f1-micro"
