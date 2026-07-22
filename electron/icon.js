import { fileURLToPath } from 'node:url';

export const appIconPath = fileURLToPath(new URL('../build/icon.png', import.meta.url));
