import { z } from "zod";

const base = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().url(),
  STELLAR_NETWORK: z.enum(["testnet", "public"]).default("testnet"),
  SOROBAN_RPC_URL: z.string().url(),
  HORIZON_URL: z.string().url(),
});

export type BaseConfig = z.infer<typeof base>;

/**
 * Parse and validate env. Services extend `base` with their own schema so a
 * missing secret fails at boot, not on first use.
 */
export function loadConfig<T extends z.ZodRawShape>(
  extra?: T,
  env: NodeJS.ProcessEnv = process.env,
): BaseConfig & z.infer<z.ZodObject<T>> {
  const schema = extra ? base.extend(extra) : base;
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid environment:\n  ${issues}`);
  }
  return result.data as BaseConfig & z.infer<z.ZodObject<T>>;
}

export const networkPassphrase = (network: "testnet" | "public"): string =>
  network === "public"
    ? "Public Global Stellar Network ; September 2015"
    : "Test SDF Network ; September 2015";
