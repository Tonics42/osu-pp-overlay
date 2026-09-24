// Downloads the official tosu release (github.com/tosuapp/tosu) on first run, so the app doesn't
// have to ship its own copy and always starts from a current version (tosu updates itself later).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LATEST_RELEASE = 'https://api.github.com/repos/tosuapp/tosu/releases/latest';

// Our overlay replaces tosu's own in-game overlay (two injected overlays would fight each other).
const TOSU_ENV = [
    'OPEN_DASHBOARD_ON_STARTUP=false',
    'ENABLE_INGAME_OVERLAY=false',
    'ENABLE_KEY_OVERLAY=false',
    'ENABLE_AUTOUPDATE=true',
    'CALCULATE_PP=true',
    'SERVER_IP=127.0.0.1',
    'SERVER_PORT=24050',
    ''
].join('\n');

function run(file, args) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
    });
}

async function extractZip(zip, dir) {
    // Windows 10+ ships bsdtar, which reads zip archives. Use it by full path: a GNU tar from Git
    // earlier in PATH would treat "C:" as a remote host.
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    try {
        await run(tar, ['-xf', zip, '-C', dir]);
    } catch {
        await run('powershell.exe', [
            '-NoProfile',
            '-Command',
            `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`
        ]);
    }
}

/** Makes sure tosu.exe exists at `exe`, downloading it if needed. Returns true when it's ready. */
export async function ensureTosuInstalled(exe, log, notify) {
    if (fs.existsSync(exe)) return true;

    const dir = path.dirname(exe);
    fs.mkdirSync(dir, { recursive: true });
    try {
        notify?.('Скачиваю tosu (нужен, чтобы знать выбранную карту)…');
        const release = await (await fetch(LATEST_RELEASE, { headers: { 'User-Agent': 'osu-pp-overlay' } })).json();
        const asset = (release.assets || []).find((a) => /^tosu-windows-.*\.zip$/.test(a.name));
        if (!asset) throw new Error('no windows build in the latest tosu release');

        log('downloading', asset.name, `${Math.round(asset.size / 1e6)} MB`);
        const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'osu-pp-overlay' } });
        if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
        const zip = path.join(dir, asset.name);
        // Written under a temp name first, so an interrupted download never looks complete.
        fs.writeFileSync(`${zip}.part`, Buffer.from(await res.arrayBuffer()));
        fs.renameSync(`${zip}.part`, zip);

        await extractZip(zip, dir);
        fs.rmSync(zip, { force: true });
        if (!fs.existsSync(path.join(dir, 'tosu.env'))) fs.writeFileSync(path.join(dir, 'tosu.env'), TOSU_ENV);

        log('tosu', release.tag_name, 'installed to', dir);
        notify?.(`tosu ${release.tag_name} установлен`);
        return fs.existsSync(exe);
    } catch (err) {
        log('tosu install failed:', String(err?.message || err));
        notify?.('Не удалось скачать tosu. Проверь интернет или положи tosu.exe вручную (см. README).');
        return false;
    }
}
