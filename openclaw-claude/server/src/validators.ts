/**
 * Outbound-response shape validators. We compile codex's published JSON
 * schemas (copied to src/protocol-schemas/codex-schemas/) and use them in
 * development to catch any shape drift before it reaches the plugin.
 *
 * In production we skip validation (it's a dev safety net, not a hot-path
 * guard) — codex's client revalidates on its end anyway.
 */

import AjvPkg, { type ValidateFunction } from "ajv";

import modelListResponseSchema from "./protocol-schemas/codex-schemas/v2/ModelListResponse.json" with { type: "json" };
import threadResumeResponseSchema from "./protocol-schemas/codex-schemas/v2/ThreadResumeResponse.json" with { type: "json" };
import threadStartResponseSchema from "./protocol-schemas/codex-schemas/v2/ThreadStartResponse.json" with { type: "json" };
import turnCompletedNotificationSchema from "./protocol-schemas/codex-schemas/v2/TurnCompletedNotification.json" with { type: "json" };
import turnStartResponseSchema from "./protocol-schemas/codex-schemas/v2/TurnStartResponse.json" with { type: "json" };
import errorNotificationSchema from "./protocol-schemas/codex-schemas/v2/ErrorNotification.json" with { type: "json" };

import type { Logger } from "./transport.js";

type AjvInstance = import("ajv").default;
const AjvCtor = AjvPkg as unknown as new (opts?: object) => AjvInstance;

const ajv = new AjvCtor({
  allErrors: true,
  strict: false,
  useDefaults: true,
  validateFormats: false,
});

const validators = {
  threadStart: ajv.compile(threadStartResponseSchema),
  threadResume: ajv.compile(threadResumeResponseSchema),
  turnStart: ajv.compile(turnStartResponseSchema),
  turnCompleted: ajv.compile(turnCompletedNotificationSchema),
  modelList: ajv.compile(modelListResponseSchema),
  errorNotification: ajv.compile(errorNotificationSchema),
};

export type ValidatorName = keyof typeof validators;

const validateInProduction = process.env.OPENCLAW_CLAUDE_APP_SERVER_VALIDATE === "1";
const skipValidation = process.env.NODE_ENV === "production" && !validateInProduction;

/**
 * Validate an outbound response against the named codex schema. On invalid:
 * - dev mode: warn (and proceed; we still emit the response so the plugin
 *   sees a real error, not a silent drop).
 * - production: skip validation entirely (codex revalidates on its end).
 *
 * Set OPENCLAW_CLAUDE_APP_SERVER_VALIDATE=1 to force validation in production.
 */
export function validateOutbound(name: ValidatorName, value: unknown, logger: Logger): void {
  if (skipValidation) return;
  const validate = validators[name] as ValidateFunction;
  if (validate(value)) return;
  logger.warn(`[validators] outbound ${name} failed schema validation`, {
    errors: ajv.errorsText(validate.errors ?? null, { separator: "; " }),
  });
}
