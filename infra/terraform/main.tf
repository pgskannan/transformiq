# TransformIQ infrastructure — Sprint 1 (TQ-001). NOT APPLIED. This is IaC written and
# validated (`terraform validate`, `terraform fmt`) against the local provider schema; no
# `terraform apply` has been run against any real GCP project from this scaffold (no GCP
# credentials were available in the environment it was built in). See ADR 0002.
#
# Reuses the existing GCP project (var.project_id) rather than creating a new one, per the
# user's instruction. Run per environment: terraform apply -var-file=environments/dev.tfvars

terraform {
  required_version = ">= 1.7.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.40"
    }
  }
  # Uncomment and configure once a real GCS bucket exists for state:
  # backend "gcs" {
  #   bucket = "transformiq-tfstate-<project_id>"
  #   prefix = "env"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  name_prefix = "transformiq-${var.environment}"
  labels = {
    app         = "transformiq"
    environment = var.environment
    managed_by  = "terraform"
  }
}

module "network" {
  source      = "./modules/network"
  name_prefix = local.name_prefix
  region      = var.region
}

module "cloudsql" {
  source      = "./modules/cloudsql"
  name_prefix = local.name_prefix
  region      = var.region
  network_id  = module.network.network_id
  db_tier     = var.db_tier
  db_password = var.db_password
  labels      = local.labels
}

module "storage" {
  source      = "./modules/storage"
  name_prefix = local.name_prefix
  region      = var.region
  labels      = local.labels
}

module "artifact_registry" {
  source      = "./modules/artifact-registry"
  name_prefix = local.name_prefix
  region      = var.region
  labels      = local.labels
}
