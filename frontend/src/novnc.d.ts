// noVNC's client ships no types. Only what LiveDesktop.tsx uses.
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string);
    viewOnly: boolean;
    scaleViewport: boolean;
    focusOnClick: boolean;
    background: string;
    disconnect(): void;
  }
}
