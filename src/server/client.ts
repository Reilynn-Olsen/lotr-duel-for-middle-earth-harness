import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { z } from "zod";
import {
  ErrorResponse,
  PROTOCOL_VERSION,
  RequestSchema,
  ServerRequest,
  ServerResponse,
  ServerResponseSchema,
  StateResponse,
} from "../protocol.js";

const MAX_STDERR_BYTES = 64 * 1024;
export class ServerError extends Error {
  constructor(
    message: string,
    readonly stderr = "",
  ) {
    super(stderr ? `${message}\nserver stderr:\n${stderr}` : message);
    this.name = "ServerError";
  }
}
export class ProtocolError extends ServerError {
  constructor(message: string, stderr = "") {
    super(message, stderr);
    this.name = "ProtocolError";
  }
}
export class ServerTimeoutError extends ServerError {
  constructor(message: string, stderr = "") {
    super(message, stderr);
    this.name = "ServerTimeoutError";
  }
}
export class ServerAbortError extends ServerError {
  constructor(message: string, stderr = "") {
    super(message, stderr);
    this.name = "ServerAbortError";
  }
}
export class ServerExitError extends ServerError {
  constructor(message: string, stderr = "") {
    super(message, stderr);
    this.name = "ServerExitError";
  }
}
export class ServerRejectedRequestError extends ServerError {
  constructor(
    readonly response: ErrorResponse,
    stderr = "",
  ) {
    super(
      `rules_server rejected ${response.requestId}: ${response.error}`,
      stderr,
    );
    this.name = "ServerRejectedRequestError";
  }
}
type WithoutEnvelope<T> = T extends unknown
  ? Omit<T, "protocolVersion" | "requestId">
  : never;
export type ClientRequest = WithoutEnvelope<ServerRequest>;
type Pending = {
  requestType: ServerRequest["type"];
  gameId?: string;
  resolve: (value: ServerResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
};

export class RulesServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private buffer = "";
  private stderr = "";
  private sequence = 0;
  private crashed: ServerError | undefined;
  private closing = false;

  constructor(
    command: string,
    cwd: string,
    private readonly timeoutMs: number,
  ) {
    this.child = spawn(command, [], { cwd, shell: true, stdio: "pipe" });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stdout.on("end", () => {
      if (!this.closing && this.buffer.length > 0)
        this.fail(
          new ProtocolError(
            "rules_server ended stdout with an incomplete JSONL message",
            this.stderr,
          ),
        );
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
    });
    this.child.on("error", (error) =>
      this.fail(
        new ServerExitError(
          `rules_server failed: ${error.message}`,
          this.stderr,
        ),
      ),
    );
    this.child.on("exit", (code, signal) => {
      if (!this.closing)
        this.fail(
          new ServerExitError(
            `rules_server exited (${code ?? signal ?? "unknown"})`,
            this.stderr,
          ),
        );
    });
  }

  async hello(
    signal?: AbortSignal,
  ): Promise<Extract<ServerResponse, { type: "hello" }>> {
    return this.request({ type: "hello" }, signal);
  }
  async request(
    input: Extract<ClientRequest, { type: "hello" }>,
    signal?: AbortSignal,
  ): Promise<Extract<ServerResponse, { type: "hello" }>>;
  async request(
    input: Extract<ClientRequest, { type: "new" }>,
    signal?: AbortSignal,
  ): Promise<Extract<ServerResponse, { type: "new" }>>;
  async request(
    input: Exclude<ClientRequest, { type: "hello" | "new" }>,
    signal?: AbortSignal,
  ): Promise<StateResponse>;
  async request(
    input: ClientRequest,
    signal?: AbortSignal,
  ): Promise<ServerResponse> {
    if (this.crashed) throw this.crashed;
    if (signal?.aborted)
      throw new ServerAbortError(
        "rules_server request aborted before write",
        this.stderr,
      );
    let request: ServerRequest;
    try {
      request = RequestSchema.parse({
        ...input,
        protocolVersion: PROTOCOL_VERSION,
        requestId: `request-${++this.sequence}`,
      });
    } catch (error) {
      throw new ProtocolError(
        `invalid rules_server request: ${this.validationMessage(error)}`,
        this.stderr,
      );
    }
    const result = new Promise<ServerResponse>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.rejectPending(
            request.requestId,
            new ServerTimeoutError(
              `rules_server request ${request.requestId} timed out after ${this.timeoutMs}ms`,
              this.stderr,
            ),
          ),
        this.timeoutMs,
      );
      const abort = () =>
        this.rejectPending(
          request.requestId,
          new ServerAbortError(
            `rules_server request ${request.requestId} aborted`,
            this.stderr,
          ),
        );
      this.pending.set(request.requestId, {
        requestType: request.type,
        gameId: "gameId" in request ? request.gameId : undefined,
        resolve,
        reject,
        timer,
        signal,
        abort,
      });
      signal?.addEventListener("abort", abort, { once: true });
    });
    this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
      if (error)
        this.fail(
          new ServerExitError(
            `failed to write request ${request.requestId}: ${error.message}`,
            this.stderr,
          ),
        );
    });
    return result;
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const [requestId] of this.pending)
      this.rejectPending(
        requestId,
        new ServerExitError("rules_server client closed", this.stderr),
      );
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 2_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  diagnostics(): { stderr: string; crashed: boolean } {
    return { stderr: this.stderr, crashed: Boolean(this.crashed) };
  }
  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length === 0) {
        this.fail(
          new ProtocolError(
            "rules_server sent an empty JSONL message",
            this.stderr,
          ),
        );
        return;
      }
      try {
        const response = ServerResponseSchema.parse(JSON.parse(line));
        const pending = this.pending.get(response.requestId);
        if (!pending)
          throw new ProtocolError(
            `rules_server sent an unknown or duplicate requestId ${response.requestId}`,
            this.stderr,
          );
        if (response.type !== "error" && response.type !== pending.requestType)
          throw new ProtocolError(
            `rules_server response type ${response.type} does not match request type ${pending.requestType}`,
            this.stderr,
          );
        if (
          pending.gameId &&
          response.gameId !== null &&
          response.gameId !== pending.gameId
        )
          throw new ProtocolError(
            `rules_server response gameId ${response.gameId} does not match request gameId ${pending.gameId}`,
            this.stderr,
          );
        this.removePending(response.requestId, pending);
        if (response.type === "error")
          pending.reject(new ServerRejectedRequestError(response, this.stderr));
        else pending.resolve(response);
      } catch (error) {
        this.fail(
          error instanceof ProtocolError
            ? error
            : new ProtocolError(
                `invalid JSONL response: ${this.validationMessage(error)}`,
                this.stderr,
              ),
        );
      }
      newline = this.buffer.indexOf("\n");
    }
  }
  private validationMessage(error: unknown): string {
    return error instanceof z.ZodError
      ? error.issues
          .map(
            (issue) => `${issue.path.join(".") || "message"}: ${issue.message}`,
          )
          .join("; ")
      : error instanceof Error
        ? error.message
        : "unknown validation failure";
  }
  private rejectPending(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.removePending(requestId, pending);
    pending.reject(error);
  }
  private removePending(requestId: string, pending: Pending): void {
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abort)
      pending.signal.removeEventListener("abort", pending.abort);
  }
  private fail(error: ServerError): void {
    if (!this.crashed) this.crashed = error;
    for (const [requestId] of this.pending)
      this.rejectPending(requestId, this.crashed);
  }
}
