import { mapKeycode } from '@asdf-overlay/electron/input/conv';

/** Tracks a key combination like "Control+Shift+P" from raw overlay key events. */
export class Keybind {
    constructor(combo) {
        this.keys = String(combo || '')
            .split(/\s*\+\s*/)
            .filter(Boolean)
            .map(normalize);
        this.pressed = new Set();
        this.fired = false;
    }

    /** @returns true once when the whole combination becomes pressed */
    update(key, state) {
        const name = normalize(mapKeycode(key.code) || '');
        if (!name) return false;

        if (state === 'Pressed') this.pressed.add(name);
        else this.pressed.delete(name);

        const all = this.keys.length > 0 && this.keys.every((k) => this.pressed.has(k));
        if (all && !this.fired) {
            this.fired = true;
            return true;
        }
        if (!all) this.fired = false;
        return false;
    }

    reset() {
        this.pressed.clear();
        this.fired = false;
    }
}

function normalize(name) {
    const n = String(name).toLowerCase();
    if (n === 'ctrl' || n === 'control' || n === 'commandorcontrol') return 'control';
    if (n === 'alt' || n === 'option') return 'alt';
    return n;
}
