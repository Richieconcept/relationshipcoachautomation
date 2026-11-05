// Error with a stable code for publishing failures (Cloudinary / Buffer).
// Messages must never contain credentials: they are logged and returned to the frontend.
export class PublishingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PublishingError';
    this.code = code;
    this.details = details;
  }
}
