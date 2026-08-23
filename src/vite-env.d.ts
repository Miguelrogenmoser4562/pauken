/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

declare module "*?url" {
  const src: string;
  export default src;
}
