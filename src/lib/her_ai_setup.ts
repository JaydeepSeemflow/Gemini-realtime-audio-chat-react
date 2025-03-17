/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Content, GenerativeContentBlob, Part } from "@google/generative-ai";
import { EventEmitter } from "eventemitter3";
import { difference } from "lodash";
import {
  ClientContentMessage,
  isInterrupted,
  isModelTurn,
  isServerContenteMessage,
  isSetupCompleteMessage,
  isToolCallCancellationMessage,
  isToolCallMessage,
  isTurnComplete,
  LiveIncomingMessage,
  ModelTurn,
  RealtimeInputMessage,
  ServerContent,
  SetupMessage,
  StreamingLog,
  ToolCall,
  ToolCallCancellation,
  ToolResponseMessage,
  type LiveConfig,
} from "../multimodal-live-types";
import { blobToJSON, base64ToArrayBuffer } from "./utils";
import { io, Socket } from "socket.io-client";

/**
 * the events that this client will emit
 */
interface MultimodalLiveClientEventTypes {
  open: () => void;
  log: (log: StreamingLog) => void;
  close: (event: CloseEvent) => void;
  audio: (data: ArrayBuffer) => void;
  content: (data: ServerContent) => void;
  interrupted: () => void;
  setupcomplete: () => void;
  turncomplete: () => void;
  toolcall: (toolCall: ToolCall) => void;
  toolcallcancellation: (toolcallCancellation: ToolCallCancellation) => void;
}

export type MultimodalLiveAPIClientConnection = {
  url?: string;
  apiKey: string;
};

/**
 * A event-emitting class that manages the connection to the websocket and emits
 * events to the rest of the application.
 * If you dont want to use react you can still use this.
 */
export class MultimodalLiveClient extends EventEmitter<MultimodalLiveClientEventTypes> {
  public socket: Socket | null = null;
  protected config: LiveConfig | null = null;
  public url: string = "";
  public getConfig() {
    return { ...this.config };
  }

  constructor({ url, apiKey }: MultimodalLiveAPIClientConnection) {
    super();
    this.url =
      "https://her-ai-ed62b6fa47b5.herokuapp.com?user_id=0f115525-2879-4854-bbb6-98f2f65eca8c&mode=STANDARD&is_ai_first=true";
    this.send = this.send.bind(this);
  }

  log(type: string, message: StreamingLog["message"]) {
    const log: StreamingLog = {
      date: new Date(),
      type,
      message,
    };
    this.emit("log", log);
  }

  createStreamingLog(type: string, message: string) {
    return {
      date: new Date(),
      type,
      message,
    };
  }

  connect(config: LiveConfig): Promise<boolean> {
    const socket = io(this.url);

    socket.on("message", async (d) => {
      const data = JSON.parse(d);
      this.receive(data);
    });
    return new Promise((resolve, reject) => {
      const onError = (ev: Event) => {
        this.disconnect(socket);
        const message = `Could not connect to "${this.url}"`;
        this.log(`server.${ev.type}`, message);
        reject(new Error(message));
      };
      socket.on("error", onError);
      socket.on("connect", () => {
        console.log("connected JP!");
        this.emit(
          "log",
          this.createStreamingLog("client.connect", "SOCKET CONNECTED")
        );

        this.emit("open");
        this.emit("log", this.createStreamingLog("client.open", "OPEN SOCKET"));
        this.socket = socket;

        resolve(true);
      });
    });
  }

  disconnect(socket?: Socket) {
    // could be that this is an old websocket and theres already a new instance
    // only close it if its still the correct reference
    if ((!socket || this.socket === socket) && this.socket) {
      this.socket.close();
      this.socket = null;
      this.log("client.close", `Disconnected`);
      return true;
    }
    return false;
  }

  protected async receive(data: any) {
    switch (data.event) {
      case "setupComplete":
        this.log("server.send", "setupComplete");
        this.emit("setupcomplete");
        break;
      case "interrupted":
        this.log("receive.serverContent", "interrupted");
        this.emit("interrupted");
        break;
      case "media":
        const chunk = data.media.payload;
        const media = base64ToArrayBuffer(chunk);
        this.emit("audio", media);
        this.log(`server.audio`, `buffer (${media.byteLength})`);
        break;
    }
  }

  /**
   * send realtimeInput, this is base64 chunks of "audio/pcm" and/or "image/jpg"
   */
  sendRealtimeInput(chunks: GenerativeContentBlob[]) {
    let hasAudio = false;
    let hasVideo = false;
    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      if (ch.mimeType.includes("audio")) {
        hasAudio = true;
      }
      if (ch.mimeType.includes("image")) {
        hasVideo = true;
      }
      if (hasAudio && hasVideo) {
        break;
      }
    }
    const message =
      hasAudio && hasVideo
        ? "audio + video"
        : hasAudio
        ? "audio"
        : hasVideo
        ? "video"
        : "unknown";

    const data = {
      event: "media",
      media: {
        payload: chunks[0].data,
      },
    };
    this._sendDirect(data);
    this.log(`client.realtimeInput`, message);
  }

  // /**
  //  * send normal content parts such as { text }
  //  */
  send(parts: Part | Part[], turnComplete: boolean = true) {
    parts = Array.isArray(parts) ? parts : [parts];
    const content: Content = {
      role: "user",
      parts,
    };

    const clientContentRequest: ClientContentMessage = {
      clientContent: {
        turns: [content],
        turnComplete,
      },
    };

    this._sendDirect(clientContentRequest);
    this.log(`client.send`, clientContentRequest);
  }

  sendToolResponse(toolResponse: ToolResponseMessage["toolResponse"]) {
    const message: ToolResponseMessage = {
      toolResponse,
    };

    // this._sendDirect(message);
    this.log(`client.toolResponse`, message);
  }

  /**
   *  used internally to send all messages
   *  don't use directly unless trying to send an unsupported message type
   */
  _sendDirect(request: object) {
    if (!this.socket) {
      throw new Error("WebSocket is not connected");
    }
    // const str = JSON.stringify(request);
    this.socket.send(request);
  }
}
