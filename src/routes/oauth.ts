import { Hono } from "hono";
import { config } from "../config.js";
import { createOAuthState, consumeOAuthState } from "../lib/store/memory.js";
import { setTokenData, type TokenData } from "../lib/store/secrets.js";

const oauth = new Hono();

oauth.get("/oauth/authorize", (c) => {
  const state = crypto.randomUUID();
  createOAuthState(state);

  const params = new URLSearchParams({
    client_id: config.LINEAR_CLIENT_ID,
    redirect_uri: `${config.APP_URL}/oauth/callback`,
    response_type: "code",
    scope: "read,write,app:assignable,app:mentionable",
    actor: "app",
    state,
  });

  return c.redirect(`https://linear.app/oauth/authorize?${params.toString()}`);
});

oauth.get("/oauth/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!state || !consumeOAuthState(state)) {
    return c.text("Invalid or expired OAuth state", 403);
  }

  if (!code) {
    return c.text("Missing authorization code", 400);
  }

  const tokenRes = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.LINEAR_CLIENT_ID,
      client_secret: config.LINEAR_CLIENT_SECRET,
      redirect_uri: `${config.APP_URL}/oauth/callback`,
      code,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    console.error("Token exchange failed:", tokenRes.status, body);
    return c.text("Token exchange failed", 502);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const viewerRes = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenData.access_token}`,
    },
    body: JSON.stringify({ query: "{ viewer { id } }" }),
  });

  if (!viewerRes.ok) {
    console.error("Viewer query failed:", viewerRes.status);
    return c.text("Failed to fetch app user ID", 502);
  }

  const viewer = (await viewerRes.json()) as {
    data: { viewer: { id: string } };
  };

  const stored: TokenData = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Date.now() + tokenData.expires_in * 1000,
    app_user_id: viewer.data.viewer.id,
  };

  await setTokenData(stored);
  console.log("OAuth complete, tokens stored for app user:", stored.app_user_id);

  return c.html(`
    <!DOCTYPE html>
    <html>
      <head><title>The Investigator — Connected</title></head>
      <body style="font-family: system-ui; max-width: 480px; margin: 80px auto; text-align: center;">
        <h1>Connected!</h1>
        <p>The Investigator is now linked to your Linear workspace.</p>
        <p>You can close this tab.</p>
      </body>
    </html>
  `);
});

export { oauth };
