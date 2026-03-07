import { extractLocalhostUrls } from "../../shared/utils/urlUtils.js";
import { detectDevServerError, type DevServerError } from "../../shared/utils/devServerErrors.js";

export interface ScanResult {
  url: string | null;
  error: DevServerError | null;
  buffer: string;
}

export class UrlDetector {
  scanOutput(data: string, buffer: string): ScanResult {
    const newBuffer = (buffer + data).slice(-8192);

    let urls = extractLocalhostUrls(data);
    if (urls.length === 0) {
      const bufferUrls = extractLocalhostUrls(newBuffer);
      if (bufferUrls.length > 0) {
        urls = [bufferUrls[bufferUrls.length - 1]];
      }
    }

    const preferredUrl = urls.length > 0 ? this.selectPreferredUrl(urls) : null;
    const error = detectDevServerError(newBuffer);

    return {
      url: preferredUrl,
      error,
      buffer: newBuffer,
    };
  }

  private selectPreferredUrl(urls: string[]): string | null {
    if (urls.length === 0) return null;
    if (urls.length === 1) return urls[0];

    const localPattern = /localhost/i;
    const localUrls = urls.filter((url) => localPattern.test(url));
    return localUrls.length > 0 ? localUrls[0] : urls[0];
  }
}
