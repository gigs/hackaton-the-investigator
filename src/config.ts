import { z } from "zod";

const envSchema = z.object({
  LINEAR_CLIENT_ID: z.string().min(1),
  LINEAR_CLIENT_SECRET: z.string().min(1),
  LINEAR_WEBHOOK_SECRET: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),
  MANAGED_AGENT_ID: z.string().min(1),
  MANAGED_ENVIRONMENT_ID: z.string().min(1),
  MANAGED_VAULT_ID: z.string().min(1).optional(),

  GCP_PROJECT_ID: z.string().min(1),

  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url(),
});

export type Config = z.infer<typeof envSchema>;

const SECRET_KEYS: ReadonlySet<string> = new Set([
  "LINEAR_CLIENT_SECRET",
  "LINEAR_WEBHOOK_SECRET",
  "ANTHROPIC_API_KEY",
]);

function parseConfig(): Config {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const safeErrors = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    console.error("Invalid environment configuration:", safeErrors);
    process.exit(1);
  }

  const cfg = result.data;
  const safeKeys = Object.keys(cfg).filter((k) => !SECRET_KEYS.has(k));
  console.log(
    "Config loaded:",
    Object.fromEntries(safeKeys.map((k) => [k, cfg[k as keyof Config]])),
  );

  return cfg;
}

export const config: Config = parseConfig();
