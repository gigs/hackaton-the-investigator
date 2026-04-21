import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;

  const computed = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  if (computed.length !== signature.length) return false;

  return timingSafeEqual(
    Buffer.from(computed, "hex"),
    Buffer.from(signature, "hex"),
  );
}
