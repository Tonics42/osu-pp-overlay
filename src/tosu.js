// tosu websocket client (main process). tosu rejects browser pages served from file:// by their
// Origin header, so the overlay page gets its data from here over IPC instead.
import EventEmitter from 'node:events';

export class TosuClient extends EventEmitter {
    connected = false;
    last = null; // last forwarded snapshot (JSON)
    snapshot = null;

    constructor(host, log = console.log) {
        super();
        this.host = host;
        this.log = log;
    }

    start() {
        this.connect();
    }

    connect() {
        let ws;
        try {
            ws = new WebSocket(`ws://${this.host}/websocket/v2`);
        } catch (err) {
            this.log('tosu: websocket error', err?.message || err);
            setTimeout(() => this.connect(), 2000);
            return;
        }

        ws.onopen = () => {
            this.connected = true;
            this.log('tosu: connected');
            this.emitState();
        };
        ws.onclose = () => {
            if (this.connected) this.log('tosu: disconnected');
            this.connected = false;
            this.snapshot = null;
            this.emitState();
            setTimeout(() => this.connect(), 1500);
        };
        ws.onerror = () => {};
        ws.onmessage = (ev) => {
            let d;
            try {
                d = JSON.parse(ev.data);
            } catch {
                return;
            }
            this.snapshot = pick(d);
            this.emitState();
        };
    }

    state() {
        return { connected: this.connected, data: this.snapshot };
    }

    emitState() {
        const json = JSON.stringify(this.state());
        if (json === this.last) return;
        this.last = json;
        this.emit('state', this.state());
    }
}

/** Only the fields the overlay needs, so unchanged polls can be skipped cheaply. */
function pick(d) {
    if (!d || !d.beatmap) return { error: d?.error || null };
    const b = d.beatmap;
    return {
        state: d.state,
        client: d.client,
        settings: { mode: d.settings?.mode },
        beatmap: {
            checksum: b.checksum,
            artist: b.artist,
            title: b.title,
            version: b.version,
            mapper: b.mapper,
            mode: b.mode,
            stats: { bpm: { common: b.stats?.bpm?.common } }
        },
        play: { mods: { array: d.play?.mods?.array || [], rate: d.play?.mods?.rate || 1 } },
        folders: { songs: d.folders?.songs },
        directPath: { beatmapFile: d.directPath?.beatmapFile }
    };
}
