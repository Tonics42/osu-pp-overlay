// In-game overlay session for one game process, built on asdf-overlay
// (same injection library tosu uses for its in-game overlay).
//
// The injected DLL blends our texture over every game frame, so the texture is kept as small as
// the panel (the offscreen window is panel-sized and moved with setPosition) and is detached
// completely while the panel is hidden — otherwise a full-screen texture costs the game FPS,
// which in lazer delays background/texture loading on map change.
import { Overlay, defaultDllDir } from '@asdf-overlay/core';
import { ElectronOverlayInput } from '@asdf-overlay/electron/input';
import { ElectronOverlaySurface } from '@asdf-overlay/electron/surface';
import { BrowserWindow } from 'electron';
import EventEmitter from 'node:events';

import { Keybind } from './keybind.js';

// Cursor must rest on the pill this long before it expands (ms).
const EXPAND_DELAY = 200;
// Expanded panel turns back into the pill this long after the cursor leaves (ms).
const COLLAPSE_DELAY = 500;

export class OverlaySession extends EventEmitter {
    /** Lock mode: input captured until hotkey/Esc. */
    locked = false;
    /** Cursor is over the panel (hover mode). */
    hovering = false;
    blocking = false;

    visible = false;
    /** Panel size in game pixels, reported by the renderer. */
    size = { width: 0, height: 0 };
    /** Panel position in game pixels. */
    pos = { x: 0, y: 0 };
    game = { width: 0, height: 0 };

    /** Pill (compact) mode: expanded on hover dwell, collapsed when the cursor leaves. */
    pinned = false;
    expanded = false;
    /** Layout the renderer last reported (true = full panel). */
    shownExpanded = false;
    /** Top-left of the pill; the full panel opens down or up from it. */
    anchor = { x: 0, y: 0 };
    pillSize = { width: 0, height: 0 };
    expandTimer = null;
    collapseTimer = null;

    surfaceLink = null;
    inputs = [];
    cursor = { x: 0, y: 0 };
    drag = null;

    constructor(pid, overlay, surface, gameSize, window, config, log) {
        super();
        this.log = log;
        this.pid = pid;
        this.overlay = overlay;
        this.surface = surface;
        this.game = gameSize;
        this.window = window;
        this.config = config;
        const { x, y } = config.data.panel;
        this.anchor =
            x == null || y == null
                ? { x: Math.round(gameSize.width * 0.088), y: Math.round(gameSize.height * 0.355) }
                : { x, y };
        this.pos = { ...this.anchor };
        this.pinned = !!config.data.panel.pinned;
        this.reloadKeybinds();

        // Input forwarded to the page is translated into panel coordinates.
        this.proxy = {
            event: new EventEmitter(),
            setBlockingCursor: (cursor) => overlay.setBlockingCursor(cursor)
        };

        overlay.event.once('disconnected', () => this.onDisconnected());

        overlay.event.on('surface_resized', (id, width, height) => {
            if (id !== this.surface.id) return;
            this.log('surface resized', `${width}x${height}`);
            this.setGameSize(width, height);
        });

        overlay.event.on('surface_destroyed', (id) => {
            if (id !== this.surface.id) return;
            this.log('surface destroyed, waiting for a new one');
            // Swapchain recreated (resolution / fullscreen change): rebind to the new surface.
            const wasAttached = !!this.surfaceLink;
            this.detachTexture();
            waitMainSurface(overlay).then(([next, width, height]) => {
                this.surface = next;
                this.log('rebound to new surface', next.info.ty.type, `${width}x${height}`);
                this.setGameSize(width, height);
                if (wasAttached || this.visible) this.attachTexture();
            });
        });

        overlay.event.on('input_blocking_ended', () => {
            // Game lost focus etc. — blocking was cancelled by the overlay itself.
            this.blocking = false;
            this.locked = false;
            this.hovering = false;
            this.drag = null;
            this.disconnectInputs();
            this.notifyRenderer();
        });

        overlay.event.on('window_keyboard_input', (id, input) => {
            this.proxy.event.emit('window_keyboard_input', id, input);
            if (input.type !== 'Key') return;
            if (this.interactKey.update(input.key, input.state)) {
                this.setLocked(!this.locked);
            }
            if (this.toggleKey.update(input.key, input.state)) {
                this.emit('toggle-panel');
            }
        });

        overlay.event.on('window_cursor_input', (id, input) => this.onCursor(id, input));
    }

    static async attach(pid, config, log = console.log) {
        const dllDir = defaultDllDir().replaceAll('app.asar', 'app.asar.unpacked');
        const overlay = await Overlay.attach(dllDir, pid, 5000);
        log('injected into pid', pid, '- waiting for the game to render a frame');
        overlay.event.on('tracing_event', (meta, message) => {
            if (meta.level === 'Error' || meta.level === 'Warn') log(`[overlay ${meta.level}]`, message ?? '');
        });

        overlay.event.on('window_added', (id) => {
            overlay.listenInput(id, config.data.hoverInteract, true).catch(() => {});
        });

        const [surface, width, height] = await waitMainSurface(overlay);
        log('game surface found:', surface.info.ty.type, `${width}x${height}`);

        const window = new BrowserWindow({
            show: false,
            transparent: true,
            frame: false,
            backgroundColor: '#00000000',
            webPreferences: {
                offscreen: {
                    useSharedTexture: true,
                    // HDR textures aren't supported by the overlay yet.
                    sharedTexturePixelFormat: 'argb'
                },
                transparent: true,
                backgroundThrottling: false,
                preload: config.preloadPath
            }
        });
        // Real size comes from the renderer once the panel is laid out.
        window.setSize(400, 400, false);
        window.webContents.setFrameRate(config.data.maxFps || 60);

        return new OverlaySession(pid, overlay, surface, { width, height }, window, config, log);
    }

    reloadKeybinds() {
        this.interactKey = new Keybind(this.config.data.hotkeyInteract);
        this.toggleKey = new Keybind(this.config.data.hotkeyToggle);
    }

    // ---------- texture / placement ----------

    attachTexture() {
        if (this.surfaceLink || this.window.isDestroyed()) return;
        this.surfaceLink = ElectronOverlaySurface.connect(this.surface, this.window.webContents);
        this.surfaceLink.events.on('error', (err) => this.log('surface error:', String(err?.message || err)));
        this.log('texture attached', `${this.size.width}x${this.size.height}`, 'at', `${this.pos.x},${this.pos.y}`);
        this.applyPosition();
        this.window.webContents.invalidate();
    }

    detachTexture() {
        if (!this.surfaceLink) return;
        this.surfaceLink.disconnect().catch(() => {});
        this.surfaceLink = null;
        this.log('texture detached');
    }

    setGameSize(width, height) {
        this.game = { width, height };
        if (!this.window.isDestroyed()) this.window.webContents.send('game-size', this.game);
        this.placeFromAnchor();
    }

    /** Position the texture from the anchor: the full panel opens downwards, or upwards near the bottom. */
    placeFromAnchor() {
        const { height } = this.size;
        let { x, y } = this.anchor;
        if (this.shownExpanded && y + height > this.game.height) {
            y = y + (this.pillSize.height || 0) - height;
        }
        this.pos = { x, y };
        this.applyPosition();
    }

    applyPosition() {
        const maxX = Math.max(0, this.game.width - this.size.width);
        const maxY = Math.max(0, this.game.height - this.size.height);
        this.pos.x = Math.round(Math.min(Math.max(0, this.pos.x), maxX));
        this.pos.y = Math.round(Math.min(Math.max(0, this.pos.y), maxY));
        if (this.surfaceLink) {
            this.overlay.setPosition(this.surface.id, this.pos.x, this.pos.y).catch(() => {});
        }
    }

    isOverPanel(x, y) {
        if (!this.visible) return false;
        const { x: px, y: py } = this.pos;
        return x >= px && y >= py && x < px + this.size.width && y < py + this.size.height;
    }

    /** Renderer reports whether the panel is shown and its size in game pixels. */
    setPanel({ visible, expanded, width, height }) {
        if (visible !== this.visible) this.log('panel', visible ? 'shown' : 'hidden', `${width}x${height}`);
        this.visible = visible;

        if (width > 0 && height > 0) {
            this.shownExpanded = !!expanded;
            if (!expanded) this.pillSize = { width, height };
            if (width !== this.size.width || height !== this.size.height) {
                this.size = { width, height };
                this.window.setSize(width, height, false);
            }
            this.placeFromAnchor();
        }

        if (visible) {
            this.attachTexture();
        } else {
            this.detachTexture();
            // Never keep the game's input captured while the panel is hidden (e.g. gameplay started).
            this.locked = false;
            this.hovering = false;
            this.drag = null;
            this.setExpanded(false);
            this.updateBlocking();
        }
    }

    // ---------- pill / expanded layout ----------

    isExpanded() {
        return this.expanded || this.pinned || this.locked;
    }

    sendLayout() {
        if (this.window.isDestroyed()) return;
        this.window.webContents.send('layout', { expanded: this.isExpanded() });
    }

    setExpanded(expanded) {
        clearTimeout(this.expandTimer);
        clearTimeout(this.collapseTimer);
        this.expandTimer = this.collapseTimer = null;
        if (this.expanded === expanded) return;
        this.expanded = expanded;
        this.sendLayout();
    }

    setPinned(pinned) {
        this.pinned = pinned;
        if (!pinned && !this.isOverPanel(this.cursor.x, this.cursor.y)) this.setExpanded(false);
        this.sendLayout();
    }

    // ---------- input ----------

    onCursor(id, input) {
        this.lastWindowId = id;
        if (input.kind.type !== 'Leave') this.cursor = { x: input.x, y: input.y };

        if (this.drag) {
            if (input.kind.type === 'Move') {
                this.anchor.x = this.drag.x + (input.x - this.drag.sx);
                this.anchor.y = this.drag.y + (input.y - this.drag.sy);
                this.placeFromAnchor();
            } else if (input.kind.type === 'Action' && input.kind.state.type === 'Released') {
                this.drag = null;
                this.clampAnchor();
                this.emit('save-position', { ...this.anchor });
                this.updateHover(id, input);
            }
            return;
        }

        const over = this.isOverPanel(input.x, input.y);
        if (this.locked && !over && input.kind.type === 'Action' && input.kind.state.type === 'Pressed') {
            // Click outside the panel leaves lock mode.
            this.setLocked(false);
            return;
        }

        if (this.blocking) {
            this.proxy.event.emit('window_cursor_input', id, {
                ...input,
                x: input.x - this.pos.x,
                y: input.y - this.pos.y
            });
        }

        this.updateHover(id, input);
    }

    updateHover(id, input) {
        if (!this.config.data.hoverInteract || this.locked) return;
        const over = input.kind.type !== 'Leave' && this.isOverPanel(input.x, input.y);

        if (!this.isExpanded()) {
            // Pill: only a short dwell expands it, so a cursor passing by doesn't grab the game's input.
            if (over && !this.expandTimer) {
                this.expandTimer = setTimeout(() => {
                    this.expandTimer = null;
                    if (!this.isOverPanel(this.cursor.x, this.cursor.y)) return;
                    this.setExpanded(true);
                    this.hovering = true;
                    this.updateBlocking();
                }, EXPAND_DELAY);
            } else if (!over && this.expandTimer) {
                clearTimeout(this.expandTimer);
                this.expandTimer = null;
            }
            return;
        }

        // Expanded: the game gets its input back as soon as the cursor leaves; the pill returns a bit later.
        if (!this.pinned) {
            if (over) {
                clearTimeout(this.collapseTimer);
                this.collapseTimer = null;
            } else if (!this.collapseTimer) {
                this.collapseTimer = setTimeout(() => {
                    this.collapseTimer = null;
                    if (!this.isOverPanel(this.cursor.x, this.cursor.y) && !this.drag) this.setExpanded(false);
                }, COLLAPSE_DELAY);
            }
        }

        if (this.hovering === over) return;
        this.hovering = over;
        this.updateBlocking();
    }

    /** Renderer: the header was pressed, move the panel with the cursor until release. */
    startDrag() {
        if (!this.blocking) return;
        this.drag = { sx: this.cursor.x, sy: this.cursor.y, x: this.anchor.x, y: this.anchor.y };
    }

    clampAnchor() {
        const w = this.pillSize.width || this.size.width;
        const h = this.pillSize.height || this.size.height;
        this.anchor.x = Math.round(Math.min(Math.max(0, this.anchor.x), Math.max(0, this.game.width - w)));
        this.anchor.y = Math.round(Math.min(Math.max(0, this.anchor.y), Math.max(0, this.game.height - h)));
    }

    setLocked(locked) {
        if (locked && !this.visible) {
            this.emit('show-panel');
        }
        this.locked = locked;
        if (!locked) {
            this.hovering = this.isOverPanel(this.cursor.x, this.cursor.y) && this.config.data.hoverInteract;
            if (!this.hovering) this.setExpanded(false);
        }
        this.sendLayout();
        this.updateBlocking();
    }

    updateBlocking() {
        const shouldBlock = this.locked || this.hovering;
        if (shouldBlock !== this.blocking) {
            this.blocking = shouldBlock;
            this.overlay.blockInput(shouldBlock).catch((err) => this.log('blockInput:', String(err?.message || err)));

            if (shouldBlock) this.connectInputs();
            else {
                this.disconnectInputs();
                this.window.blurWebView?.();
            }
        }
        this.notifyRenderer();
    }

    connectInputs() {
        this.disconnectInputs();
        const ids = new Set();
        const mainId = this.surface.info.ty.windowId;
        if (mainId != null) ids.add(mainId);
        if (this.lastWindowId != null) ids.add(this.lastWindowId);
        for (const id of ids) {
            this.inputs.push(ElectronOverlayInput.connect({ id, overlay: this.proxy }, this.window.webContents));
        }
        this.window.focusOnWebView?.();
    }

    disconnectInputs() {
        for (const input of this.inputs) input.disconnect().catch(() => {});
        this.inputs = [];
    }

    notifyRenderer() {
        if (this.window.isDestroyed()) return;
        this.window.webContents.send('interaction', {
            locked: this.locked,
            hovering: this.hovering,
            active: this.blocking
        });
    }

    onDisconnected() {
        this.disconnectInputs();
        if (!this.window.isDestroyed()) this.window.destroy();
        this.emit('destroyed');
    }

    destroy() {
        try {
            if (this.blocking) this.overlay.blockInput(false).catch(() => {});
            this.disconnectInputs();
            this.detachTexture();
            this.overlay.detach();
        } catch {
            // already detached
        }
    }
}

/** Resolves with the first surface bound to a window. */
function waitMainSurface(overlay) {
    return new Promise((resolve) => {
        const handler = (id, width, height, info) => {
            if (info.ty.windowId == null) return;
            overlay.event.off('surface_added', handler);
            resolve([{ id, overlay, info }, width, height]);
        };
        overlay.event.on('surface_added', handler);
    });
}
