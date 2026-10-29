import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { buildAsyncApiDocument } from '../src/asyncapi.js';

const packageDir = join(import.meta.dirname, '..');
const outDir = join(packageDir, 'generated');
const { version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version: string };

mkdirSync(outDir, { recursive: true });
const header = '# Archivo generado por `pnpm contracts:generate` a partir de los esquemas Zod. No editar a mano.\n';
writeFileSync(join(outDir, 'asyncapi.yaml'), header + stringify(buildAsyncApiDocument(version), { lineWidth: 0 }));
process.stdout.write(`asyncapi.yaml generado (versión ${version})\n`);
