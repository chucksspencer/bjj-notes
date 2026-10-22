/** A problem with the request that the caller can fix (shown to them as-is). */
export class UserError extends Error {}

/** The thing asked for doesn't exist. */
export class NotFoundError extends UserError {}

/** Only the owner can do that. */
export class ForbiddenError extends UserError {}
