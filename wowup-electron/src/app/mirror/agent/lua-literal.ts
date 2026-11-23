type LuaValue = unknown;

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_]/;

/**
 * Parses the subset of Lua that SavedVariables files use: top-level `Name = value` statements whose values are
 * strings, numbers, booleans, nil and tables. Tables become plain objects keyed by the Lua key (positional entries
 * are keyed 1, 2, ...). Throws an error naming the position on malformed input.
 */
export function parseLuaAssignments(source: string): Record<string, unknown> {
  return new LuaParser(source).parseChunk();
}

function setKey(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

class LuaParser {
  private pos = 0;

  public constructor(private readonly s: string) {}

  public parseChunk(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.skip();
    while (this.pos < this.s.length) {
      const name = this.readName();
      this.skip();
      this.expect("=");
      this.skip();
      setKey(out, name, this.parseValue());
      this.skip();
      if (this.s[this.pos] === ";") {
        this.pos++;
      }
      this.skip();
    }
    return out;
  }

  private fail(message: string, at = this.pos): never {
    throw new Error(`Lua parse error at position ${at}: ${message}`);
  }

  private expect(ch: string): void {
    if (this.s[this.pos] !== ch) {
      const found = this.pos >= this.s.length ? "but reached the end" : `but found "${this.s[this.pos]}"`;
      this.fail(`expected "${ch}" ${found}`);
    }
    this.pos++;
  }

  private skip(): void {
    for (;;) {
      const c = this.s[this.pos];
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\uFEFF") {
        this.pos++;
      } else if (c === "-" && this.s[this.pos + 1] === "-") {
        const start = this.pos;
        this.pos += 2;
        const level = this.longBracketLevel();
        if (level >= 0) {
          this.readLongBracket(level, start);
        } else {
          while (this.pos < this.s.length && this.s[this.pos] !== "\n") {
            this.pos++;
          }
        }
      } else {
        return;
      }
    }
  }

  private readName(): string {
    const start = this.pos;
    if (!NAME_START.test(this.s[this.pos] ?? "")) {
      this.fail("expected a name");
    }
    while (this.pos < this.s.length && NAME_PART.test(this.s[this.pos])) {
      this.pos++;
    }
    return this.s.slice(start, this.pos);
  }

  /** At `[`: returns the level of a long bracket opener (`[[` = 0, `[=[` = 1) or -1, without consuming. */
  private longBracketLevel(): number {
    if (this.s[this.pos] !== "[") {
      return -1;
    }
    let i = this.pos + 1;
    while (this.s[i] === "=") {
      i++;
    }
    return this.s[i] === "[" ? i - this.pos - 1 : -1;
  }

  private readLongBracket(level: number, start: number): string {
    this.pos += level + 2;
    if (this.s[this.pos] === "\r") {
      this.pos++;
    }
    if (this.s[this.pos] === "\n") {
      this.pos++;
    }
    const close = "]" + "=".repeat(level) + "]";
    const end = this.s.indexOf(close, this.pos);
    if (end < 0) {
      this.fail("unterminated long bracket", start);
    }
    const text = this.s.slice(this.pos, end);
    this.pos = end + close.length;
    return text;
  }

  private parseValue(): LuaValue {
    const c = this.s[this.pos];
    if (c === undefined) {
      this.fail("expected a value but reached the end");
    }
    if (c === '"' || c === "'") {
      return this.readQuoted(c);
    }
    if (c === "[") {
      const level = this.longBracketLevel();
      if (level < 0) {
        this.fail('unexpected "["');
      }
      return this.readLongBracket(level, this.pos);
    }
    if (c === "{") {
      return this.parseTable();
    }
    if (c === "-" || c === "." || (c >= "0" && c <= "9")) {
      return this.readNumber();
    }
    if (NAME_START.test(c)) {
      const at = this.pos;
      const word = this.readName();
      if (word === "true") {
        return true;
      }
      if (word === "false") {
        return false;
      }
      if (word === "nil") {
        return undefined;
      }
      this.fail(`unexpected identifier "${word}"`, at);
    }
    this.fail(`unexpected "${c}"`);
  }

  private readNumber(): number {
    const start = this.pos;
    const rest = this.s.slice(this.pos);
    const m =
      /^-?\s*(?:0[xX][0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?(?:[pP][+-]?\d+)?|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(rest);
    if (!m) {
      this.fail("malformed number");
    }
    this.pos += m[0].length;
    const text = m[0].replace(/\s+/g, "");
    const neg = text.startsWith("-");
    const body = neg ? text.slice(1) : text;
    const n = /^0[xX]/.test(body) ? Number(body) : parseFloat(body);
    if (Number.isNaN(n)) {
      this.fail("malformed number", start);
    }
    return neg ? -n : n;
  }

  private readQuoted(quote: string): string {
    const start = this.pos;
    this.pos++;
    let out = "";
    for (;;) {
      if (this.pos >= this.s.length) {
        this.fail("unterminated string", start);
      }
      const c = this.s[this.pos++];
      if (c === quote) {
        return out;
      }
      if (c === "\n") {
        this.fail("newline in string", this.pos - 1);
      }
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = this.s[this.pos++];
      switch (e) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case "r":
          out += "\r";
          break;
        case "a":
          out += "\x07";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "v":
          out += "\v";
          break;
        case "\\":
        case '"':
        case "'":
          out += e;
          break;
        case "\n":
          out += "\n";
          break;
        case "x": {
          const hex = this.s.slice(this.pos, this.pos + 2);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
            this.fail("bad \\x escape", this.pos - 2);
          }
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += 2;
          break;
        }
        default:
          if (e !== undefined && e >= "0" && e <= "9") {
            const digits = /^\d{1,3}/.exec(this.s.slice(this.pos - 1))?.[0] ?? e;
            this.pos += digits.length - 1;
            const code = parseInt(digits, 10);
            if (code > 255) {
              this.fail("decimal escape too large", this.pos - digits.length - 1);
            }
            out += String.fromCharCode(code);
          } else {
            this.fail(`invalid escape "\\${e ?? ""}"`, this.pos - 2);
          }
      }
    }
  }

  private parseTable(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.expect("{");
    let index = 1;
    for (;;) {
      this.skip();
      const c = this.s[this.pos];
      if (c === undefined) {
        this.fail("unterminated table");
      }
      if (c === "}") {
        this.pos++;
        return out;
      }
      if (c === "[" && this.longBracketLevel() < 0) {
        this.pos++;
        this.skip();
        const key = this.parseValue();
        this.skip();
        this.expect("]");
        this.skip();
        this.expect("=");
        this.skip();
        const value = this.parseValue();
        if (key !== undefined && key !== null) {
          setKey(out, String(key), value);
        }
      } else if (NAME_START.test(c) && this.isNamedField()) {
        const name = this.readName();
        this.skip();
        this.expect("=");
        this.skip();
        setKey(out, name, this.parseValue());
      } else {
        setKey(out, String(index++), this.parseValue());
      }
      this.skip();
      const sep = this.s[this.pos];
      if (sep === "," || sep === ";") {
        this.pos++;
      } else if (sep !== "}") {
        this.fail(sep === undefined ? "unterminated table" : `expected "," or "}" but found "${sep}"`);
      }
    }
  }

  private isNamedField(): boolean {
    let i = this.pos;
    while (i < this.s.length && NAME_PART.test(this.s[i])) {
      i++;
    }
    while (/\s/.test(this.s[i] ?? "")) {
      i++;
    }
    return this.s[i] === "=" && this.s[i + 1] !== "=";
  }
}
