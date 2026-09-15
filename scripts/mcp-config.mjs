// Emit machine-specific configuration without editing host settings.
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const entrypoint = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
await access(entrypoint);
console.log(JSON.stringify({ mcpServers: {
  'tudelft-brightspace': { command: process.execPath, args: [entrypoint, 'serve'] },
} }, null, 2));
