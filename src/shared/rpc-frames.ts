/**
 * pi RPC 模式的 JSONL 分帧。
 *
 * 协议规则（packages/coding-agent/docs/rpc.md）：
 * - LF 是唯一的记录分隔符；
 * - 行尾的 CR 会被剥离，因此 CRLF 输入可接受；
 * - U+2028 / U+2029 **不是**分隔符 —— 正因如此协议文档明确点名 Node 的
 *   `readline` 不合规。这里因此不借助任何流式行读取器，自己按 LF 切。
 */

export const RECORD_DELIMITER = "\n";

/** 单条记录的默认字符上限，防止畸形输入把内存吃光。 */
const DEFAULT_MAX_RECORD_LENGTH = 8 * 1024 * 1024;

export class RpcFrameError extends Error {
  /** 出问题的那一段原文（截断后的），便于定位。 */
  readonly record: string;

  constructor(message: string, record: string) {
    super(message);
    this.name = "RpcFrameError";
    this.record = record;
  }
}

/**
 * 把一条命令编码成一个以 LF 结尾的记录。
 *
 * U+2028 / U+2029 会被转义成 `\u2028` / `\u2029`：JSON 语义完全等价，
 * 但万一对端用了按 Unicode 分隔符切行的读取器，也不会把一条记录切成两条。
 */
export function encodeRecord(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new RpcFrameError("值无法序列化为 JSON", String(value));
  }
  return json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029") + RECORD_DELIMITER;
}

export interface DecodeOutcome {
  /** 成功解析出的记录。 */
  readonly records: readonly unknown[];
  /** 解析失败的记录。一条坏记录不会中断整个流。 */
  readonly errors: readonly RpcFrameError[];
}

const EMPTY_OUTCOME: DecodeOutcome = Object.freeze({ records: [], errors: [] });

export interface JsonlDecoderOptions {
  readonly maxRecordLength?: number;
}

/**
 * 增量 JSONL 解码器。任意切分位置的 chunk 都能正确处理，
 * 包括把一条记录切成两半、以及一个 chunk 里塞多条记录。
 */
export class JsonlDecoder {
  #buffer = "";
  #discarding = false;
  readonly #maxRecordLength: number;

  constructor(options: JsonlDecoderOptions = {}) {
    this.#maxRecordLength = options.maxRecordLength ?? DEFAULT_MAX_RECORD_LENGTH;
  }

  /** 缓冲区里尚未成记录的字节数。 */
  get bufferedLength(): number {
    return this.#buffer.length;
  }

  push(chunk: string): DecodeOutcome {
    if (chunk.length === 0) return EMPTY_OUTCOME;
    this.#buffer += chunk;

    const records: unknown[] = [];
    const errors: RpcFrameError[] = [];
    let start = 0;
    for (;;) {
      const newlineAt = this.#buffer.indexOf(RECORD_DELIMITER, start);
      if (newlineAt === -1) break;
      this.#consume(this.#buffer.slice(start, newlineAt), records, errors);
      start = newlineAt + 1;
    }
    this.#buffer = this.#buffer.slice(start);

    if (this.#buffer.length > this.#maxRecordLength) {
      errors.push(
        new RpcFrameError(`记录超过 ${this.#maxRecordLength} 字符上限，已丢弃`, preview(this.#buffer)),
      );
      this.#buffer = "";
      this.#discarding = true;
    }

    return { records, errors };
  }

  /** 结束输入。协议要求每条记录都以 LF 结尾，残留内容按错误上报。 */
  end(): DecodeOutcome {
    const rest = this.#buffer;
    this.#buffer = "";
    const wasDiscarding = this.#discarding;
    this.#discarding = false;
    if (rest.length === 0 || wasDiscarding) return EMPTY_OUTCOME;
    return { records: [], errors: [new RpcFrameError("流结束时存在不完整的记录", preview(rest))] };
  }

  #consume(raw: string, records: unknown[], errors: RpcFrameError[]): void {
    if (this.#discarding) {
      // 上一条因为超长被丢弃后，这里要一直吞到下一个分隔符为止。
      this.#discarding = false;
      return;
    }
    const record = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (record.trim().length === 0) return; // 容忍多余的空行
    if (record.length > this.#maxRecordLength) {
      // 完整的超长记录也要拦：一次 chunk 里可以塞任意长度的内容。
      errors.push(
        new RpcFrameError(`记录超过 ${this.#maxRecordLength} 字符上限，已丢弃`, preview(record)),
      );
      return;
    }
    try {
      records.push(JSON.parse(record) as unknown);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(new RpcFrameError(`记录不是合法 JSON：${detail}`, preview(record)));
    }
  }
}

function preview(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 200)}…`;
}
