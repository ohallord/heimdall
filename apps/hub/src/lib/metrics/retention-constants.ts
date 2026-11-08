/** Researched default (Phase 25): 60 days. Admins can change within the clamp. */
export const DEFAULT_RETENTION_DAYS = 60;
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 365;

/** Phase 29: spans are high volume, so traces get a shorter, separate window. */
export const DEFAULT_TRACES_RETENTION_DAYS = 7;
export const MIN_TRACES_RETENTION_DAYS = 1;
export const MAX_TRACES_RETENTION_DAYS = 60;
