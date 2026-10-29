import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageDir = join(import.meta.dirname, '..');
const srcDir = join(packageDir, 'src');

const IMPORT = /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

describe('arquitectura del dominio', () => {
  it('no declara dependencias', () => {
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(pkg['dependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
  });

  it('solo importa archivos propios: nada de red, base de datos, framework ni Node', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(join(srcDir, file), 'utf8');
      for (const match of source.matchAll(IMPORT)) {
        const specifier = match[1] ?? match[2] ?? '';
        if (!specifier.startsWith('./')) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no usa reloj, azar ni globales de entrada/salida', () => {
    const forbidden = /\b(Date\.now|new Date|Math\.random|crypto\.|setTimeout|setInterval|process\.|console\.)/;
    const withoutComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const offenders = readdirSync(srcDir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => forbidden.test(withoutComments(readFileSync(join(srcDir, f), 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
