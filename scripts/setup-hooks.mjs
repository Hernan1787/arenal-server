// Activa los hooks de .githooks (gitleaks antes de cada commit).
// Funciona en Windows, macOS y Linux; si todavía no hay repo de git, no hace nada.
import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
} catch {
  // Sin git o fuera de un repo: se activa en el próximo `pnpm install`.
}
