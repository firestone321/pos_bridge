export type ErrorCode =
  | "invalid_request"
  | "origin_rejected"
  | "origin_missing"
  | "invalid_authorization"
  | "authorization_replayed"
  | "print_job_conflict"
  | "print_job_uncertain"
  | "printer_not_configured"
  | "printer_unavailable"
  | "print_failed"
  | "drawer_cooldown"
  | "drawer_failed"
  | "hardware_action_rejected"
  | "hardware_outcome_unknown"
  | "internal_error";

export class BridgeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}
