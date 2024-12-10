import { WebSocket } from "ws";
import { WebSocketMessageType, ErrorResponse } from "../types/websocket";
import { logger } from "./logger";

export class ErrorHandler {
  static sendError(
    ws: WebSocket,
    code: string,
    message: string,
    details?: any
  ) {
    const errorResponse: ErrorResponse = {
      code,
      message,
      details,
    };

    try {
      ws.send(
        JSON.stringify({
          type: WebSocketMessageType.ERROR,
          payload: errorResponse,
        })
      );
    } catch (error) {
      logger.error("Error sending error message:", error);
    }
  }
}
