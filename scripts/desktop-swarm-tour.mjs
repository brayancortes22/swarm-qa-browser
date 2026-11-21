/**
 * Desktop window audit (Windows only, experimental). Lists top-level windows and reports the
 * ones that overflow the monitor or have a non-descriptive title. Writes .qa/desktop-audit.json.
 *
 *   npm run desktop:audit -- [--width 1920] [--height 1080] [--focus]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { auditDesktopWindows, focusDesktopTarget } from '../packages/desktop-adapter/src/desktop-session.mjs';

const argv = process.argv.slice(2);
const numberFlag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index !== -1 && Number(argv[index + 1]) > 0 ? Number(argv[index + 1]) : fallback;
};

if (process.platform !== 'win32') {
  console.error('La auditoría de escritorio solo está disponible en Windows.');
  process.exit(1);
}

const audit = auditDesktopWindows({ monitorWidth: numberFlag('width', 1920), monitorHeight: numberFlag('height', 1080) });
console.log(
  `Monitor ${audit.monitor.width}×${audit.monitor.height} · ${audit.totalWindowsScanned} ventanas · ${audit.auditableWindows} auditables`
);
for (const win of audit.windows) {
  const issues = audit.findings.filter((f) => f.target.targetId === win.targetId);
  console.log(
    `  ${issues.length ? '⚠' : '✓'} ${win.title.slice(0, 60)} (${win.rect.width}×${win.rect.height} @ ${win.rect.x},${win.rect.y})`
  );
  for (const issue of issues) console.log(`      ${issue.severity} ${issue.ruleId}: ${issue.title}`);
}
if (argv.includes('--focus') && audit.windows[0]) {
  console.log(`Foco en la primera ventana: ${focusDesktopTarget(audit.windows[0]) ? 'aplicado' : 'no aplicado'}`);
}

mkdirSync('.qa', { recursive: true });
writeFileSync('.qa/desktop-audit.json', JSON.stringify(audit, null, 2));
console.log(`${audit.totalFindings} hallazgos · informe en .qa/desktop-audit.json`);
