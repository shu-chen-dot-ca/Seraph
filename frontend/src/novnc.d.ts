// noVNC's client ships no types. Only what LiveDesktop.tsx and PhoneVM.tsx use.
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string);
    viewOnly: boolean;
    scaleViewport: boolean;
    focusOnClick: boolean;
    background: string;
    disconnect(): void;
    // keysym: the X keysym; code: the physical key, or null; down left out: pressed and let go.
    sendKey(keysym: number, code: string | null, down?: boolean): void;
  }
}
