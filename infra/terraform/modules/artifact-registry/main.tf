variable "name_prefix" { type = string }
variable "region" { type = string }
variable "labels" { type = map(string) }

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "${var.name_prefix}-images"
  format        = "DOCKER"
  labels        = var.labels
}

output "repo_id" {
  value = google_artifact_registry_repository.images.repository_id
}
