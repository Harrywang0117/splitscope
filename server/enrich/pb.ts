/** Minimal protobuf wire-format reader (varint + length-delimited only), enough for v2ray .dat files. */

export interface PbField {
  no: number;
  wire: number;
  /** varint value (wire 0) */
  num: number;
  /** payload bounds (wire 2) */
  start: number;
  end: number;
}

export function* pbFields(buf: Uint8Array, start = 0, end = buf.length): Generator<PbField> {
  let pos = start;
  const varint = (): number => {
    let result = 0;
    let mul = 1;
    for (;;) {
      const b = buf[pos++];
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
  };
  while (pos < end) {
    const tag = varint();
    const no = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      yield { no, wire, num: varint(), start: 0, end: 0 };
    } else if (wire === 2) {
      const len = varint();
      const s = pos;
      pos += len;
      yield { no, wire, num: 0, start: s, end: pos };
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire} at ${pos}`);
    }
  }
}

const decoder = new TextDecoder();
export function pbString(buf: Uint8Array, f: PbField): string {
  return decoder.decode(buf.subarray(f.start, f.end));
}
