/**
 * Base error for all SDK-specific errors.
 */
export class DownloaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    // Set the prototype explicitly to allow 'instanceof' checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a network connection error occurs.
 * This is often temporary.
 */
export class NetworkError extends DownloaderError {
  constructor(message = "Network error") {
    super(message);
  }
}

/**
 * Thrown when the server responds with a non-2xx HTTP status.
 */
export class HttpError extends DownloaderError {
  public statusCode: number;
  public statusText: string;

  constructor(statusCode: number, statusText: string) {
    super(`HTTP ${statusCode} ${statusText}`);
    this.statusCode = statusCode;
    this.statusText = statusText;
  }
}

/**
 * Thrown when the server doesn't support the features
 * required for chunked downloading (like 'Content-Range').
 */
export class UnsupportedServerError extends DownloaderError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown when the final assembled file's size
 * does not match the expected size.
 */
export class AssemblyError extends DownloaderError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown when IndexedDB storage quota is exceeded.
 */
export class QuotaError extends DownloaderError {
  constructor(message = "Storage quota exceeded") {
    super(message);
  }
}
