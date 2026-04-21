import { LinearClient } from "@linear/sdk";
import { getTokenData, setTokenData, type TokenData } from "../store/secrets.js";
import { config } from "../../config.js";

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export async function getLinearClient(): Promise<LinearClient> {
  let token = await getTokenData();
  if (!token) {
    throw new Error("No OAuth token found — complete the OAuth flow first");
  }

  if (Date.now() >= token.expires_at - REFRESH_BUFFER_MS) {
    console.log("Access token expired or near expiry, refreshing...");
    token = await refreshToken(token);
  }

  return new LinearClient({ accessToken: token.access_token });
}

async function refreshToken(token: TokenData): Promise<TokenData> {
  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.LINEAR_CLIENT_ID,
      client_secret: config.LINEAR_CLIENT_SECRET,
      refresh_token: token.refresh_token,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const updated: TokenData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    app_user_id: token.app_user_id,
  };

  await setTokenData(updated);
  console.log("Token refreshed and persisted");
  return updated;
}
