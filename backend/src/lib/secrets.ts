// Secret Manager abstraction (TQ-005). Locally, secrets come from .env (see .env.example).
// In GCP, set GCP_PROJECT_ID and this reads from Secret Manager instead — application code
// never has an env-vs-Secret-Manager branch to worry about; it just calls getSecret().
//
// AGENTS.md Do-Not-Do rule #9: never put a secret in code, committed config, or logs. This
// file is the only place that should ever construct a Secret Manager client.

let secretManagerClient: import("@google-cloud/secret-manager").SecretManagerServiceClient | null =
  null;

async function getSecretManagerClient() {
  if (!secretManagerClient) {
    // Lazy import, same pattern as objectStorage.ts's GcsObjectStorage: the
    // @google-cloud/secret-manager package is a real dependency (package.json), but this
    // path has never run against a live GCP project — no GCP credentials have been
    // available in any environment this scaffold has been built/tested in so far.
    const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
    secretManagerClient = new SecretManagerServiceClient();
  }
  return secretManagerClient;
}

export async function getSecret(name: string): Promise<string> {
  const projectId = process.env.GCP_PROJECT_ID;

  if (!projectId) {
    // Local/dev fallback: read straight from the environment.
    const value = process.env[name];
    if (!value) {
      throw new Error(
        `Secret "${name}" not found in environment. Set it in .env for local dev, or set ` +
          `GCP_PROJECT_ID to read it from Secret Manager instead.`
      );
    }
    return value;
  }

  const client = await getSecretManagerClient();
  const [version] = await client.accessSecretVersion({
    name: `projects/${projectId}/secrets/${name}/versions/latest`,
  });
  const payload = version.payload?.data?.toString();
  if (!payload) {
    throw new Error(`Secret "${name}" has no payload in Secret Manager (project ${projectId}).`);
  }
  return payload;
}
