class TerminalManager {
    constructor() {
        this.terminal = null;
        this.fitAddon = null;
        this.ws = null;
        this.isConnected = false;
        this.fontSize = this.loadFontSize();
        this.controlsState = 'closed';
        this.init();
    }

    loadFontSize() {
        const saved = localStorage.getItem('fn-terminal-font-size');
        return saved ? parseInt(saved, 10) : 14;
    }

    saveFontSize(size) {
        localStorage.setItem('fn-terminal-font-size', size.toString());
    }

    init() {
        this.terminal = new Terminal({
            cursorBlink: true,
            cursorStyle: 'bar',
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            fontSize: this.fontSize,
            lineHeight: 1.2,
            theme: {
                background: '#0d1117',
                foreground: '#c9d1d9',
                cursor: '#58a6ff',
                selectionBackground: '#264f78'
            }
        });

        this.fitAddon = new FitAddon.FitAddon();
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.open(document.getElementById('terminal'));
        this.fitAddon.fit();

        this.setupEvents();
        this.setupMobileControls();
        window.addEventListener('resize', () => this.fitAddon && this.fitAddon.fit());

        this.connect();
    }

    setupMobileControls() {
        const expandBtn = document.getElementById('expandBtn');
        const fontBtn = document.getElementById('fontBtn');
        const fontDown = document.getElementById('fontDown');
        const fontReset = document.getElementById('fontReset');
        const fontUp = document.getElementById('fontUp');

        const preventDefault = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };

        const refocusTerminal = () => {
            setTimeout(() => this.terminal.focus(), 50);
        };

        // Arrow button
        expandBtn?.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if (this.controlsState === 'closed') {
                this.controlsState = 'font';
                expandBtn.classList.add('open');
                fontBtn.classList.remove('hidden');
            } else {
                this.controlsState = 'closed';
                expandBtn.classList.remove('open');
                fontBtn.classList.add('hidden');
                fontDown.classList.add('hidden');
                fontReset.classList.add('hidden');
                fontUp.classList.add('hidden');
            }
        });

        // Font icon
        fontBtn?.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.controlsState = 'adjust';
            fontBtn.classList.add('hidden');
            fontDown.classList.remove('hidden');
            fontReset.classList.remove('hidden');
            fontUp.classList.remove('hidden');
        });

        // Font size buttons
        fontUp?.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.changeFontSize(2);
            refocusTerminal();
        });

        fontDown?.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.changeFontSize(-2);
            refocusTerminal();
        });

        fontReset?.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.setFontSize(14);
            refocusTerminal();
        });

        // Click outside to close
        document.addEventListener('touchstart', (e) => {
            if (!e.target.closest('#mobile-controls')) {
                this.controlsState = 'closed';
                expandBtn.classList.remove('open');
                fontBtn.classList.add('hidden');
                fontDown.classList.add('hidden');
                fontReset.classList.add('hidden');
                fontUp.classList.add('hidden');
            }
        });
    }

    setupEvents() {
        this.terminal.onData((data) => {
            if (this.ws && this.isConnected) {
                this.ws.send(JSON.stringify({ type: 'input', data }));
            }
        });

        this.terminal.onResize(({ cols, rows }) => {
            if (this.ws && this.isConnected) {
                this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
            }
        });
    }

    changeFontSize(delta) {
        const newSize = Math.max(10, Math.min(32, this.fontSize + delta));
        this.setFontSize(newSize);
    }

    setFontSize(size) {
        this.fontSize = size;
        this.saveFontSize(size);
        this.terminal.options.fontSize = size;
        this.fitAddon.fit();
    }

    handleDisconnect() {
        this.isConnected = false;
        this.terminal.writeln('');
        this.terminal.writeln('\x1b[31m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
        this.terminal.writeln('\x1b[31m  连接已断开\x1b[0m');
        this.terminal.writeln('\x1b[33m  按任意键重新连接...\x1b[0m');
        this.terminal.writeln('\x1b[31m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');

        const reconnectHandler = () => {
            this.terminal.offData(reconnectHandler);
            this.connect();
        };
        this.terminal.onData(reconnectHandler);
    }

    connect() {
        if (this.isConnected) return;

        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${window.location.host}/app/fn-terminal/ws`;

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            this.isConnected = true;
            const dims = this.fitAddon.proposeDimensions();
            if (dims) {
                this.ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
            }
            this.terminal.focus();
        };

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'output') {
                    this.terminal.write(msg.data);
                } else if (msg.type === 'exit') {
                    this.handleDisconnect();
                }
            } catch (e) {
                console.error('Parse error:', e);
            }
        };

        this.ws.onclose = () => {
            if (this.isConnected) {
                this.handleDisconnect();
            }
        };

        this.ws.onerror = (error) => {
            console.error('WS error:', error);
            this.isConnected = false;
        };
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.tm = new TerminalManager();
});
