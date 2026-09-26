declare module "@novnc/novnc/lib/rfb.js" {
  class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    qualityLevel: number;
    compressionLevel: number;
    focusOnClick: boolean;
    disconnect(): void;
    focus(): void;
    blur(): void;
    clipboardPasteFrom(text: string): void;
  }
  const client: typeof RFB | { default: typeof RFB };
  export default client;
}
