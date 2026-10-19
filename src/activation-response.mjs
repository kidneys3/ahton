const CLICK_RESPONSES = new Set(["activate", "activated", "click", "clicked"]);

/**
 * Accept only explicit activation/click responses. Dismissal, timeout, delivery,
 * and unknown responses fail closed.
 * @param {unknown} response
 * @param {unknown} metadata
 */
export function isActivationResponse(response, metadata) {
  if (typeof response === "string" && CLICK_RESPONSES.has(response.toLowerCase())) {
    return true;
  }
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  const record = /** @type {Record<string, unknown>} */ (metadata);
  const values = [record.activationType, record.event, record.type];
  return values.some((value) => typeof value === "string" && CLICK_RESPONSES.has(value.toLowerCase()));
}

/**
 * Reduce notifier results to fixed, privacy-safe diagnostic categories.
 * @param {unknown} error
 * @param {unknown} response
 * @param {unknown} metadata
 */
export function classifyActivationOutcome(error, response, metadata) {
  if (error) return "error";
  if (isActivationResponse(response, metadata)) return "activated";

  const record = metadata && typeof metadata === "object"
    ? /** @type {Record<string, unknown>} */ (metadata)
    : undefined;
  const candidates = [
    response,
    record?.activationType,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.toLowerCase();
    if (normalized === "timeout" || normalized === "timedout") return "timed_out";
    if (normalized === "dismissed") return "dismissed";
    if (normalized === "hidden") return "hidden";
  }
  return "unknown";
}
