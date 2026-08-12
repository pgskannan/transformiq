output "cloudsql_connection_name" {
  value       = module.cloudsql.connection_name
  description = "Cloud SQL instance connection name, for Cloud Run's --add-cloudsql-instances flag."
}

output "raw_data_bucket" {
  value       = module.storage.raw_data_bucket_name
  description = "Immutable raw-dataset bucket name (FR-PROJ-002/003)."
}

output "artifact_registry_repo" {
  value       = module.artifact_registry.repo_id
  description = "Artifact Registry repository for backend/frontend container images."
}
