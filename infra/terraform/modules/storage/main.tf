# Immutable raw-dataset storage (FR-PROJ-002/003). Versioning + retention lock enforce
# immutability at the infrastructure level, not just application logic — see AGENTS.md §4.1.

variable "name_prefix" { type = string }
variable "region" { type = string }
variable "labels" { type = map(string) }

resource "google_storage_bucket" "raw_data" {
  name                        = "${var.name_prefix}-raw-data"
  location                    = var.region
  uniform_bucket_level_access = true
  labels                      = var.labels

  versioning {
    enabled = true
  }

  retention_policy {
    retention_period = 60 * 60 * 24 * 30 # 30 days minimum; raise for prod once retention policy is approved (SRS §19)
    is_locked         = false            # keep false until the retention period is confirmed — locking is irreversible
  }
}

output "raw_data_bucket_name" {
  value = google_storage_bucket.raw_data.name
}
