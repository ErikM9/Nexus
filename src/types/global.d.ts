export {};

declare global {
  interface Window {
    __matrix_ready?: boolean;
    __cryptoReady?: boolean;
  }
}