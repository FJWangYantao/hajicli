export interface TerminalMouseEvent {
  type: 'mouse';
  action: 'down' | 'move' | 'up' | 'wheel';
  button: number;
  column: number;
  row: number;
  wheelRows?: number;
}

export interface TerminalKeyboardEvent {
  type: 'keyboard';
  data: string;
}

export interface TerminalPasteEvent {
  type: 'paste';
  text: string;
}

export type TerminalProtocolEvent = TerminalMouseEvent | TerminalKeyboardEvent | TerminalPasteEvent;

const SGR_MOUSE_PREFIX = '\x1b[<';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const ANSI_SEQUENCE = /^\x1b\[[0-?]*[ -/]*[@-~]/;
const SGR_MOUSE_SEQUENCE = /^\x1b\[<(\d+);(\d+);(\d+)([mM])/;

function isPrefixOf(value: string, target: string): boolean {
  return target.startsWith(value);
}

function decodeMouse(button: number, column: number, row: number, suffix: string): TerminalMouseEvent {
  if ((button & 64) !== 0) {
    return {
      type: 'mouse',
      action: 'wheel',
      button,
      column,
      row,
      wheelRows: (button & 1) === 0 ? 3 : -3
    };
  }

  if (suffix === 'm') {
    return { type: 'mouse', action: 'up', button, column, row };
  }

  return {
    type: 'mouse',
    action: (button & 32) !== 0 ? 'move' : 'down',
    button,
    column,
    row
  };
}

/**
 * Stateful VT input decoder. It owns packet reassembly, so mouse bytes are
 * never heuristically passed into readline as keyboard input.
 */
export class TerminalProtocolParser {
  private buffer = '';
  private pasteText = '';
  private inPaste = false;

  push(input: Buffer | string): TerminalProtocolEvent[] {
    this.buffer += typeof input === 'string' ? input : input.toString('utf8');
    return this.parseAvailable();
  }

  flushPending(): TerminalProtocolEvent[] {
    if (!this.buffer) {
      return [];
    }

    if (this.inPaste) {
      return [];
    }

    const pending = this.buffer;
    this.buffer = '';
    if (pending === '\x1b') {
      return [{ type: 'keyboard', data: pending }];
    }
    if (pending.startsWith(SGR_MOUSE_PREFIX) || isPrefixOf(pending, SGR_MOUSE_PREFIX)) {
      return [];
    }
    return [{ type: 'keyboard', data: pending }];
  }

  reset(): void {
    this.buffer = '';
    this.pasteText = '';
    this.inPaste = false;
  }

  private parseAvailable(): TerminalProtocolEvent[] {
    const events: TerminalProtocolEvent[] = [];

    while (this.buffer) {
      if (this.inPaste) {
        const pasteEnd = this.buffer.indexOf(PASTE_END);
        if (pasteEnd === -1) {
          const keep = Math.min(PASTE_END.length - 1, this.buffer.length);
          const consumable = this.buffer.length - keep;
          this.pasteText += this.buffer.slice(0, consumable);
          this.buffer = this.buffer.slice(consumable);
          break;
        }

        this.pasteText += this.buffer.slice(0, pasteEnd);
        this.buffer = this.buffer.slice(pasteEnd + PASTE_END.length);
        events.push({ type: 'paste', text: this.pasteText });
        this.pasteText = '';
        this.inPaste = false;
        continue;
      }

      if (this.buffer.startsWith(PASTE_START)) {
        this.buffer = this.buffer.slice(PASTE_START.length);
        this.inPaste = true;
        continue;
      }
      if (isPrefixOf(this.buffer, PASTE_START)) {
        break;
      }

      if (this.buffer.startsWith(SGR_MOUSE_PREFIX)) {
        const match = this.buffer.match(SGR_MOUSE_SEQUENCE);
        if (!match) {
          if (/^\x1b\[<[\d;]*$/.test(this.buffer)) {
            break;
          }
          this.buffer = this.buffer.slice(1);
          continue;
        }

        events.push(decodeMouse(
          Number.parseInt(match[1], 10),
          Number.parseInt(match[2], 10),
          Number.parseInt(match[3], 10),
          match[4]
        ));
        this.buffer = this.buffer.slice(match[0].length);
        continue;
      }
      if (isPrefixOf(this.buffer, SGR_MOUSE_PREFIX)) {
        break;
      }

      if (this.buffer[0] === '\x1b') {
        const ansi = this.buffer.match(ANSI_SEQUENCE)?.[0];
        if (ansi) {
          events.push({ type: 'keyboard', data: ansi });
          this.buffer = this.buffer.slice(ansi.length);
          continue;
        }
        if (this.buffer.length === 1 || this.buffer === '\x1b[') {
          break;
        }
        events.push({ type: 'keyboard', data: this.buffer.slice(0, 2) });
        this.buffer = this.buffer.slice(2);
        continue;
      }

      const nextEscape = this.buffer.indexOf('\x1b');
      const end = nextEscape === -1 ? this.buffer.length : nextEscape;
      events.push({ type: 'keyboard', data: this.buffer.slice(0, end) });
      this.buffer = this.buffer.slice(end);
    }

    return events;
  }
}
