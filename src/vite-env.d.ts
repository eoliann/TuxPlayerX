/// <reference types="vite/client" />

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.svg' {
  const src: string;
  export default src;
}

declare module '*.ico' {
  const src: string;
  export default src;
}

interface ImportMetaEnv {
  /** Set by the Tauri CLI during dev/build: 'windows', 'linux', 'android', ... */
  readonly TAURI_ENV_PLATFORM?: string;
}
