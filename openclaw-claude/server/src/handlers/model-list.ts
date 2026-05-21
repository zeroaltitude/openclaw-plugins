import type { JsonValue } from "../protocol.js";
import { buildModelListResponse } from "../models.js";
import type { Logger } from "../transport.js";
import { validateOutbound } from "../validators.js";

export function createModelListHandler(logger: Logger) {
  return async function handleModelList(): Promise<JsonValue> {
    const response = buildModelListResponse();
    validateOutbound("modelList", response, logger);
    return response as unknown as JsonValue;
  };
}
