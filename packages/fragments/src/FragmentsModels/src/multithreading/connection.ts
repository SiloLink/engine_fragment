import { ConnectionHandlers, ThreadHandler } from "./connection-handlers";
import { MultithreadingHelper } from "./multithreading-helper";
import {
  FRAGMENTS_PROTOCOL_VERSION,
  PROTOCOL_HANDSHAKE_TIMEOUT,
  ProtocolHello,
  TileRequest,
} from "./protocol";

interface PortProtocol {
  ready: Promise<Error | undefined>;
  settled: boolean;
  error?: Error;
  finish: (error?: Error) => void;
}

export class Connection {
  private readonly _handlers = new ConnectionHandlers();
  private readonly _handleInput: ThreadHandler;
  private _port?: MessagePort;
  private readonly _protocols = new WeakMap<MessagePort, PortProtocol>();

  constructor(handleInput: ThreadHandler) {
    this._handleInput = handleInput;
  }

  fetchMeshCompute(modelId: string, list: TileRequest[]) {
    const helper = MultithreadingHelper;
    const input = helper.getMeshComputeRequest(modelId, list);
    const content = helper.getRequestContent(input);
    this.fetch(input, content);
  }

  fetch(input: any, content?: any[]) {
    this._handlers.setupInput(input);
    return new Promise<any>((resolve, reject) => {
      this._handlers.set(input.requestId, reject, resolve);
      this.executeConnection(input, content).catch((error) => {
        this._handlers.fail(input.requestId, error);
      });
    });
  }

  init(port: MessagePort) {
    this._port = port;
    this.initConnection(port);
  }

  protected initConnection(connection: MessagePort) {
    let resolve!: (error?: Error) => void;
    const ready = new Promise<Error | undefined>((done) => {
      resolve = done;
    });
    const state: PortProtocol = {
      ready,
      settled: false,
      finish: (error) => {
        if (state.settled) return;
        state.settled = true;
        state.error = error;
        clearTimeout(timeout);
        resolve(error);
      },
    };
    const timeout = setTimeout(
      () =>
        state.finish(
          new Error("Fragments: worker protocol handshake timed out"),
        ),
      PROTOCOL_HANDSHAKE_TIMEOUT,
    );
    this._protocols.set(connection, state);
    connection.onmessage = (event) => this.onInput(event, state);
    const hello: ProtocolHello = {
      fragmentsProtocol: FRAGMENTS_PROTOCOL_VERSION,
    };
    try {
      connection.postMessage(hello);
    } catch (error) {
      state.finish(error instanceof Error ? error : new Error(String(error)));
    }
  }

  protected closeConnection(connection: MessagePort) {
    const protocol = this._protocols.get(connection);
    if (protocol) {
      const error = new Error("Fragments: worker connection closed");
      protocol.finish(error);
      protocol.error = error;
    }
    connection.close();
  }

  protected async fetchConnection(_input: any) {
    if (!this._port) {
      throw new Error("Fragments: Connection not initialized");
    }
    return this._port;
  }

  private async executeConnection(input: any, content?: any[]) {
    const connectionPort = await this.fetchConnection(input);
    const protocol = this._protocols.get(connectionPort)!;
    await protocol.ready;
    if (protocol.error) throw protocol.error;
    connectionPort.postMessage(input, content as any);
  }

  private async manageOutput(input: any) {
    const connection = await this.fetchConnection(input);
    input.toMainThread = true;
    const content: Transferable[] = [];
    if (input.itemLocalIds) {
      content.push(input.itemLocalIds.buffer);
    }
    connection.postMessage(input, content);
  }

  private onInput(input: MessageEvent, state: PortProtocol) {
    if (!state.settled) {
      const version = input.data?.fragmentsProtocol;
      // Legacy workers echo unknown requests as RPC errors, including every
      // original field. Such an echo is not a protocol declaration.
      const isHello =
        typeof input.data === "object" &&
        input.data !== null &&
        Object.keys(input.data).length === 1 &&
        typeof version === "number";
      state.finish(
        isHello && version === FRAGMENTS_PROTOCOL_VERSION
          ? undefined
          : new Error(
              `Fragments: worker protocol incompatible (expected ${FRAGMENTS_PROTOCOL_VERSION}, received ${isHello ? version : "invalid handshake"})`,
            ),
      );
      return;
    }
    if (state.error) return;
    if (input.data.toMainThread) {
      this._handlers.run(input.data);
      return;
    }
    this.manageInput(input.data);
  }

  private async manageConnection(input: any) {
    try {
      await this._handleInput(input);
    } catch (error: any) {
      input.errorInfo = error.toString();
      // Aborts are intentional — don't log them as unexpected errors.
      if (error?.name !== "LoadAbortedError") {
        console.error(error);
      }
    }
  }

  private async manageInput(input: any): Promise<void> {
    await this.manageConnection(input);
    await this.manageOutput(input);
  }
}
