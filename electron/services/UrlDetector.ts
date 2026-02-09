import { EventEmitter } from "node:events";
import { extractLocalhostUrls } from "../../shared/utils/urlUtils.js";
import { detectDevServerError, type DevServerError } from "../../shared/utils/devServerErrors.js";

export interface UrlDetectorEvents {
  "url-detected": (url: string) => void;
  "error-detected": (error: DevServerError) => void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface UrlDetector {
  on<K extends keyof UrlDetectorEvents>(event: K, listener: UrlDetectorEvents[K]): this;
  off<K extends keyof UrlDetectorEvents>(event: K, listener: UrlDetectorEvents[K]): this;
  emit<K extends keyof UrlDetectorEvents>(
    event: K,
    ...args: Parameters<UrlDetectorEvents[K]>
  ): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class UrlDetector extends EventEmitter {
  scanOutput(data: string, buffer: string): { buffer: string } {
    const newBuffer = (buffer + data).slice(-4096);

    let urls = extractLocalhostUrls(data);
    if (urls.length === 0) {
      const bufferUrls = extractLocalhostUrls(newBuffer);
      if (bufferUrls.length > 0) {
        urls = [bufferUrls[bufferUrls.length - 1]];
      }
    }

    if (urls.length > 0) {
      const preferredUrl = this.selectPreferredUrl(urls);
      if (preferredUrl) {
        this.emit("url-detected", preferredUrl);
      }
    }

    const error = detectDevServerError(newBuffer);
    if (error) {
      this.emit("error-detected", error);
    }

    return { buffer: newBuffer };
  }

  private selectPreferredUrl(urls: string[]): string | null {
    if (urls.length === 0) return null;
    if (urls.length === 1) return urls[0];

    const localPattern = /localhost/i;
    const localUrls = urls.filter((url) => localPattern.test(url));
    return localUrls.length > 0 ? localUrls[0] : urls[0];
  }
}
