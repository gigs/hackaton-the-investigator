import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { config } from "../../config.js";

const SECRET_NAME = "investigator-oauth-token";

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  app_user_id: string;
}

let client: SecretManagerServiceClient | null = null;

function getClient(): SecretManagerServiceClient {
  if (!client) {
    client = new SecretManagerServiceClient();
  }
  return client;
}

function secretPath(): string {
  return `projects/${config.GCP_PROJECT_ID}/secrets/${SECRET_NAME}`;
}

export async function getTokenData(): Promise<TokenData | null> {
  try {
    const [version] = await getClient().accessSecretVersion({
      name: `${secretPath()}/versions/latest`,
    });

    const payload = version.payload?.data;
    if (!payload) return null;

    const raw =
      typeof payload === "string"
        ? payload
        : Buffer.from(payload as Uint8Array).toString("utf8");

    return JSON.parse(raw) as TokenData;
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    // 5 = NOT_FOUND — no versions exist yet
    if (code === 5) return null;
    throw err;
  }
}

export async function setTokenData(data: TokenData): Promise<void> {
  await getClient().addSecretVersion({
    parent: secretPath(),
    payload: { data: Buffer.from(JSON.stringify(data), "utf8") },
  });
  console.log("Token data stored in Secret Manager");
}
