# Cloud SQL for PostgreSQL — the primary transactional database (ADR 0002). Tenant isolation
# is enforced via Postgres RLS at the schema level (backend/db/migrations), not by this
# module — this module just provisions the instance/database/user.

variable "name_prefix" { type = string }
variable "region" { type = string }
variable "network_id" { type = string }
variable "db_tier" { type = string }
variable "db_password" {
  type      = string
  sensitive = true
}
variable "labels" { type = map(string) }

resource "google_sql_database_instance" "primary" {
  name             = "${var.name_prefix}-pg"
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    tier = var.db_tier
    ip_configuration {
      ipv4_enabled    = false
      private_network = var.network_id
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
    user_labels = var.labels
  }

  deletion_protection = true # flip to false only deliberately, e.g. for a throwaway dev instance
}

resource "google_sql_database" "app_db" {
  name     = "transformiq"
  instance = google_sql_database_instance.primary.name
}

resource "google_sql_user" "app_user" {
  name     = "transformiq_app"
  instance = google_sql_database_instance.primary.name
  password = var.db_password
}

output "connection_name" {
  value = google_sql_database_instance.primary.connection_name
}
