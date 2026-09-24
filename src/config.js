import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
    // tosu websocket/http address
    tosuHost: '127.0.0.1:24050',
    // Launch tosu automatically if it isn't reachable (path relative to app folder or absolute)
    tosuPath: 'tosu/tosu.exe',
    autoStartTosu: true,

    // Toggle "interactive" mode (panel captures mouse/keyboard until toggled again or Esc)
    hotkeyInteract: 'Control+Shift+P',
    // Hide/show the panel
    hotkeyToggle: 'Control+Shift+O',
    // Inject into osu!stable too (NOT recommended: stable has an anti-cheat)
    allowStable: false,

    // Make the panel clickable just by hovering it with the cursor
    hoverInteract: true,

    // tosu game states where the panel is shown: 4 selectEdit, 5 selectPlay, 12 matchSetup, 13 selectMulti
    showStates: [4, 5, 12, 13],

    // x/y in game pixels; null = default spot under the beatmap info in song select
    panel: { x: null, y: null, scale: 1, pinned: false },
    maxFps: 60
};

export class Config {
    constructor(dir) {
        this.file = path.join(dir, 'config.json');
        this.data = structuredClone(DEFAULT_CONFIG);
        this.load();
    }

    load() {
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            this.data = {
                ...structuredClone(DEFAULT_CONFIG),
                ...raw,
                panel: { ...DEFAULT_CONFIG.panel, ...(raw.panel || {}) }
            };
        } catch (err) {
            if (err.code !== 'ENOENT') console.error('config: failed to read, using defaults:', err.message);
            this.save();
        }
    }

    save() {
        try {
            fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
        } catch (err) {
            console.error('config: failed to save:', err.message);
        }
    }

    update(partial) {
        this.data = {
            ...this.data,
            ...partial,
            panel: { ...this.data.panel, ...(partial.panel || {}) }
        };
        this.save();
    }
}
