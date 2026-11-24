import { app } from 'electron';

/** Electron takes the runtime name from the packaged productName. */
export function isCascadiaBuild(): boolean {
  return app.name === 'Mesh Client Cascadia';
}
