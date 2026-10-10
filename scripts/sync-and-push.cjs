const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Configuration
const MONOREPO_ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.resolve(MONOREPO_ROOT, '..', 'sri-krishna-swacch-aaharam-frontend');
const BACKEND_DIR = path.resolve(MONOREPO_ROOT, '..', 'sri-krishna-swacch-aaharam-backend');

// Find functional Git binary
function getGitBinary() {
  const preferred = 'C:\\Users\\DELL\\.tools\\git\\cmd\\git.exe';
  if (fs.existsSync(preferred)) {
    return preferred;
  }
  return 'git';
}

const GIT = getGitBinary();

// Parse CLI arguments
const rawArgs = process.argv.slice(2);
let targetWeb = true;
let targetApi = true;
let customMessage = '';

for (const arg of rawArgs) {
  if (arg === '--web') {
    targetWeb = true;
    targetApi = false;
  } else if (arg === '--api') {
    targetWeb = false;
    targetApi = true;
  } else if (!arg.startsWith('--')) {
    customMessage = arg;
  }
}

if (!customMessage) {
  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  customMessage = `update: sync changes from development workspace (${timestamp})`;
}

console.log('====================================================');
console.log(' Sri Krishna Swacch Aaharam — Workspace Sync & Push ');
console.log('====================================================');
console.log(`Commit message: "${customMessage}"`);
console.log(`Target: ${targetWeb && targetApi ? 'Both Frontend & Backend' : targetWeb ? 'Frontend only' : 'Backend only'}\n`);

function runCommand(cmd, cwd, silent = false) {
  try {
    return execSync(cmd, { cwd, stdio: silent ? 'pipe' : 'inherit', encoding: 'utf-8' });
  } catch (err) {
    if (!silent) {
      console.error(`Error running command in ${cwd}:`, err.message);
    }
    throw err;
  }
}

function syncDirectory(src, dest, excludes = []) {
  if (!fs.existsSync(src)) return;
  const excludeDirs = ['node_modules', 'dist', '.turbo', '.next', 'coverage', ...excludes];
  const xdArg = excludeDirs.length > 0 ? `/XD ${excludeDirs.join(' ')}` : '';
  const xfArg = `/XF *.log *.tsbuildinfo .env*`;

  // Robocopy returns exit codes 0-7 for success (1 means files copied).
  // /IS /IT ensures files are always overwritten from the canonical monorepo even if timestamps match.
  const robocopyCmd = `robocopy "${src}" "${dest}" /E /IS /IT ${xdArg} ${xfArg} /NP /NFL /NDL /NJH /NJS`;
  try {
    execSync(robocopyCmd, { stdio: 'pipe' });
  } catch (e) {
    // Robocopy returns non-zero (1-7) when files are copied, which is normal
    if (e.status > 7) {
      console.error(`Robocopy failed between ${src} and ${dest}:`, e.message);
    }
  }
}

// ─── 1. FRONTEND SYNC & PUSH ──────────────────────────────────────────────────
if (targetWeb) {
  if (!fs.existsSync(FRONTEND_DIR)) {
    console.error(`[Frontend] Directory not found: ${FRONTEND_DIR}`);
  } else {
    console.log('[Frontend] Syncing files from wood-pressed-natural-foods...');
    
    // Backup deployment configs in frontend repo so they are never overwritten
    const preserveFiles = ['apps/web/vite.config.ts', 'apps/web/vercel.json', 'apps/web/package.json', 'vercel.json', '.npmrc', 'pnpm-lock.yaml'];
    const backups = {};
    for (const rel of preserveFiles) {
      const full = path.join(FRONTEND_DIR, rel);
      if (fs.existsSync(full)) {
        backups[rel] = fs.readFileSync(full, 'utf-8');
      }
    }

    // Sync apps/web, packages, and scripts
    syncDirectory(path.join(MONOREPO_ROOT, 'apps', 'web'), path.join(FRONTEND_DIR, 'apps', 'web'));
    syncDirectory(path.join(MONOREPO_ROOT, 'packages'), path.join(FRONTEND_DIR, 'packages'));
    syncDirectory(path.join(MONOREPO_ROOT, 'scripts'), path.join(FRONTEND_DIR, 'scripts'));

    // Restore preserved deployment configs
    for (const [rel, content] of Object.entries(backups)) {
      const full = path.join(FRONTEND_DIR, rel);
      fs.writeFileSync(full, content, 'utf-8');
    }

    // Check git status
    const status = execSync(`"${GIT}" status --porcelain`, { cwd: FRONTEND_DIR, encoding: 'utf-8' }).trim();
    if (!status) {
      console.log('✓ [Frontend] No changes to push. Already up to date!\n');
    } else {
      console.log('[Frontend] Changes detected:');
      console.log(status.split('\n').map(l => '  ' + l).join('\n'));
      console.log('\n[Frontend] Staging, committing, and pushing to origin main...');
      runCommand(`"${GIT}" add .`, FRONTEND_DIR);
      runCommand(`"${GIT}" commit -m "${customMessage.replace(/"/g, '\\"')}"`, FRONTEND_DIR);
      runCommand(`"${GIT}" push origin main`, FRONTEND_DIR);
      console.log('✓ [Frontend] Successfully pushed to GitHub main!\n');
    }
  }
}

// ─── 2. BACKEND SYNC & PUSH ───────────────────────────────────────────────────
if (targetApi) {
  if (!fs.existsSync(BACKEND_DIR)) {
    console.error(`[Backend] Directory not found: ${BACKEND_DIR}`);
  } else {
    console.log('[Backend] Syncing files from wood-pressed-natural-foods...');

    // Backup deployment configs in backend repo
    const preserveFiles = [
      'apps/api/package.json',
      'apps/api/src/common/config/validate-env.ts',
      'apps/api/src/main.ts',
      'apps/api/src/payment/payment-provider.config.ts'
    ];
    const backups = {};
    for (const rel of preserveFiles) {
      const full = path.join(BACKEND_DIR, rel);
      if (fs.existsSync(full)) {
        backups[rel] = fs.readFileSync(full, 'utf-8');
      }
    }

    // Sync apps/api, packages, and scripts
    syncDirectory(path.join(MONOREPO_ROOT, 'apps', 'api'), path.join(BACKEND_DIR, 'apps', 'api'));
    syncDirectory(path.join(MONOREPO_ROOT, 'packages'), path.join(BACKEND_DIR, 'packages'));
    syncDirectory(path.join(MONOREPO_ROOT, 'scripts'), path.join(BACKEND_DIR, 'scripts'));

    // Restore preserved deployment configs
    for (const [rel, content] of Object.entries(backups)) {
      const full = path.join(BACKEND_DIR, rel);
      fs.writeFileSync(full, content, 'utf-8');
    }

    // Check git status
    const status = execSync(`"${GIT}" status --porcelain`, { cwd: BACKEND_DIR, encoding: 'utf-8' }).trim();
    if (!status) {
      console.log('✓ [Backend] No changes to push. Already up to date!\n');
    } else {
      console.log('[Backend] Changes detected:');
      console.log(status.split('\n').map(l => '  ' + l).join('\n'));
      console.log('\n[Backend] Staging, committing, and pushing to origin main...');
      runCommand(`"${GIT}" add .`, BACKEND_DIR);
      runCommand(`"${GIT}" commit -m "${customMessage.replace(/"/g, '\\"')}"`, BACKEND_DIR);
      runCommand(`"${GIT}" push origin main`, BACKEND_DIR);
      console.log('✓ [Backend] Successfully pushed to GitHub main!\n');
    }
  }
}

console.log('====================================================');
console.log(' All done! Your workspace changes are now on GitHub.');
console.log('====================================================');
