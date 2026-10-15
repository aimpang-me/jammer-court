export class ToolError extends Error {
  constructor(code, message, { retryable = false, retryAfter = null } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }

  toResult() {
    return {
      content: [{ type: "text", text: this.message }],
      structuredContent: { error: { code: this.code, message: this.message, retryable: this.retryable, retry_after_s: this.retryAfter } },
      isError: true,
    };
  }
}
