variable "project_id" {
  description = "The existing GCP project ID to deploy into (per user instruction: reuse the same gcloud project, do not create a new one)."
  type        = string
}

variable "region" {
  description = "Primary GCP region."
  type        = string
  default     = "us-central1"
}

variable "environment" {
  description = "Environment name: dev | staging | prod. Resources are namespaced by this."
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "db_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-f1-micro" # dev default; use a larger tier for staging/prod
}

variable "db_password" {
  description = "Cloud SQL app user password. Pass via -var or TF_VAR_db_password, never commit it."
  type        = string
  sensitive   = true
}
