// The game client reaches its login and world servers through WebSockets at /ws/<port> of its own
// origin. Here those servers run inside the tab, so `WebSocket` is replaced by a class that hands
// such connections to the in-tab server and leaves every other URL to the browser's own.

// A task of its own, soon: a message channel is not slowed down in a background tab as timers are.
const tasks = [];
const ticker = new MessageChannel();
ticker.port1.onmessage = () => tasks.shift()?.();
const nextTask = (fn) => {
  tasks.push(fn);
  ticker.port2.postMessage(0);
};

export function installWebSocketShim(server, scope = window) {
  const Native = scope.WebSocket;

  class TabSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url, protocols) {
      const parsed = new URL(url, scope.location.href);
      const match = /^\/ws\/(\d+)$/.exec(parsed.pathname);
      if (!match) return new Native(url, protocols);
      super();
      this.url = parsed.href;
      this.protocol = '';
      this.extensions = '';
      this.binaryType = 'blob';
      this.bufferedAmount = 0;
      this.readyState = TabSocket.CONNECTING;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;

      const conn = server.connect(Number(match[1]));
      this.conn = conn;
      // With the browser's own sockets no message arrives in the same task as the open event, and
      // a page may attach its message handler only after that event (the game client does). The
      // world server speaks first, so what arrives with the open event is held for the next task.
      let held = null;
      const message = (bytes) => {
        if (this.readyState !== TabSocket.OPEN) return;
        const data = this.binaryType === 'arraybuffer'
          ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          : new Blob([bytes]);
        this.#emit(new MessageEvent('message', { data }));
      };
      const closed = (wasOpen) => {
        if (this.readyState === TabSocket.CLOSED) return;
        this.readyState = TabSocket.CLOSED;
        if (!wasOpen) this.#emit(new Event('error'));
        this.#emit(new CloseEvent('close', { wasClean: !!wasOpen, code: wasOpen ? 1000 : 1006 }));
      };
      conn.onopen = () => {
        if (this.readyState !== TabSocket.CONNECTING) return;
        this.readyState = TabSocket.OPEN;
        held = [];
        this.#emit(new Event('open'));
        nextTask(() => {
          const waiting = held;
          held = null;
          for (const deliver of waiting) deliver();
        });
      };
      conn.ondata = (bytes) => {
        if (this.readyState === TabSocket.CONNECTING) conn.onopen(); // data means it is open
        if (held) held.push(() => message(bytes));
        else message(bytes);
      };
      conn.onclose = (wasOpen) => {
        if (held) held.push(() => closed(wasOpen));
        else closed(wasOpen);
      };
    }

    get CONNECTING() { return 0; }
    get OPEN() { return 1; }
    get CLOSING() { return 2; }
    get CLOSED() { return 3; }

    send(data) {
      if (this.readyState !== TabSocket.OPEN) throw new DOMException('the socket is not open', 'InvalidStateError');
      if (typeof data === 'string') this.conn.send(new TextEncoder().encode(data));
      else if (data instanceof ArrayBuffer) this.conn.send(new Uint8Array(data));
      else if (ArrayBuffer.isView(data)) this.conn.send(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      else if (data instanceof Blob) data.arrayBuffer().then((b) => this.conn.send(new Uint8Array(b)));
    }

    close() {
      if (this.readyState === TabSocket.CLOSED || this.readyState === TabSocket.CLOSING) return;
      this.readyState = TabSocket.CLOSING;
      this.conn.close();
      queueMicrotask(() => {
        if (this.readyState === TabSocket.CLOSED) return;
        this.readyState = TabSocket.CLOSED;
        this.#emit(new CloseEvent('close', { wasClean: true, code: 1000 }));
      });
    }

    #emit(event) {
      const handler = this['on' + event.type];
      if (typeof handler === 'function') {
        try {
          handler.call(this, event);
        } catch (e) {
          console.error(e);
        }
      }
      this.dispatchEvent(event);
    }
  }

  scope.WebSocket = TabSocket;
  return () => {
    scope.WebSocket = Native;
  };
}
