import WebSocket, { WebSocketServer } from "ws";
import {
  AuthenticatedWebSocket,
  WebSocketMessage,
  WebSocketMessageType,
} from "../types/websocket";
import { RoomService } from "./room.service";
import { MessageService } from "./message.service";
import * as schemas from "../schemas/message.schemas";
import { logger } from "../utils/logger";
import { ErrorHandler } from "../utils/error-handler";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class WebSocketService {
  private wss: WebSocketServer;
  private clients: Map<string, AuthenticatedWebSocket>;

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
    this.clients = new Map();
    this.setupHeartbeat();
  }

  private setupHeartbeat() {
    setInterval(() => {
      this.wss.clients.forEach((ws) => {
        const authenticatedWs = ws as AuthenticatedWebSocket;
        if (!authenticatedWs.isAlive) {
          this.handleDisconnect(authenticatedWs);
          return authenticatedWs.terminate();
        }
        authenticatedWs.isAlive = false;
        authenticatedWs.ping();
      });
    }, 30000);
  }

  public async handleConnection(ws: AuthenticatedWebSocket, userId: string) {
    ws.userId = userId;
    ws.isAlive = true;
    ws.rooms = new Set();
    ws.isTyping = new Map();
    this.clients.set(userId, ws);

    try {
      await this.updateUserStatus(userId, true);
      this.setupWebSocketListeners(ws);
    } catch (error) {
      logger.error("Error in handleConnection:", error);
      ErrorHandler.sendError(
        ws,
        "CONNECTION_ERROR",
        "Failed to establish connection",
      );
    }
  }

  private setupWebSocketListeners(ws: AuthenticatedWebSocket) {
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", async (data: string) => {
      try {
        const message: WebSocketMessage = JSON.parse(data);
        await this.handleMessage(ws, message);
      } catch (error) {
        logger.error("Error processing message:", error);
        ErrorHandler.sendError(
          ws,
          "MESSAGE_PROCESSING_ERROR",
          "Invalid message format",
        );
      }
    });

    ws.on("close", () => this.handleDisconnect(ws));
    ws.on("error", (error) => {
      logger.error("WebSocket error:", error);
      ErrorHandler.sendError(
        ws,
        "WEBSOCKET_ERROR",
        "WebSocket connection error",
      );
    });
  }

  private async handleMessage(
    ws: AuthenticatedWebSocket,
    message: WebSocketMessage,
  ) {
    try {
      switch (message.type) {
        case WebSocketMessageType.JOIN_ROOM:
          await this.handleJoinRoom(ws, message.payload);
          break;
        case WebSocketMessageType.LEAVE_ROOM:
          await this.handleLeaveRoom(ws, message.payload);
          break;
        case WebSocketMessageType.SEND_MESSAGE:
          await this.handleSendMessage(ws, message.payload);
          break;
        case WebSocketMessageType.PRIVATE_MESSAGE:
          await this.handlePrivateMessage(ws, message.payload);
          break;
        case WebSocketMessageType.TYPING_START:
        case WebSocketMessageType.TYPING_STOP:
          await this.handleTypingStatus(ws, message);
          break;
      }
    } catch (error) {
      logger.error("Error in handleMessage:", error);
      ErrorHandler.sendError(
        ws,
        "MESSAGE_HANDLING_ERROR",
        "Failed to process message",
      );
    }
  }

  private async handleJoinRoom(ws: AuthenticatedWebSocket, payload: any) {
    try {
      const { roomId } = schemas.joinRoomSchema.parse({
        type: WebSocketMessageType.JOIN_ROOM,
        payload,
      }).payload;

      if (await RoomService.addUserToRoom(ws.userId, roomId)) {
        ws.rooms.add(roomId);
        this.broadcastToRoom(roomId, {
          type: WebSocketMessageType.USER_STATUS,
          payload: {
            userId: ws.userId,
            status: "joined",
            roomId,
          },
        });
      } else {
        ErrorHandler.sendError(ws, "ROOM_JOIN_ERROR", "Failed to join room");
      }
    } catch (error) {
      logger.error("Error in handleJoinRoom:", error);
      ErrorHandler.sendError(ws, "ROOM_JOIN_ERROR", "Failed to join room");
    }
  }

  private async handleLeaveRoom(ws: AuthenticatedWebSocket, payload: any) {
    try {
      const { roomId } = schemas.leaveRoomSchema.parse({
        type: WebSocketMessageType.LEAVE_ROOM,
        payload,
      }).payload;

      if (await RoomService.removeUserFromRoom(ws.userId, roomId)) {
        ws.rooms.delete(roomId);
        this.broadcastToRoom(roomId, {
          type: WebSocketMessageType.USER_STATUS,
          payload: {
            userId: ws.userId,
            status: "left",
            roomId,
          },
        });
      } else {
        ErrorHandler.sendError(ws, "ROOM_LEAVE_ERROR", "Failed to leave room");
      }
    } catch (error) {
      logger.error("Error in handleLeaveRoom:", error);
      ErrorHandler.sendError(ws, "ROOM_LEAVE_ERROR", "Failed to leave room");
    }
  }

  private async handleSendMessage(ws: AuthenticatedWebSocket, payload: any) {
    try {
      const { roomId, content } = schemas.sendMessageSchema.parse({
        type: WebSocketMessageType.SEND_MESSAGE,
        payload,
      }).payload;

      if (!(await RoomService.validateRoomAccess(ws.userId, roomId))) {
        return ErrorHandler.sendError(
          ws,
          "UNAUTHORIZED",
          "Not a member of this room",
        );
      }

      const message = await MessageService.createMessage(
        ws.userId,
        roomId,
        content,
      );
      this.broadcastToRoom(roomId, {
        type: WebSocketMessageType.SEND_MESSAGE,
        payload: {
          messageId: message.id,
          content: message.content,
          userId: message.userId,
          username: message.user.username,
          roomId: message.roomId,
          createdAt: message.createdAt,
        },
      });
    } catch (error) {
      logger.error("Error in handleSendMessage:", error);
      ErrorHandler.sendError(
        ws,
        "MESSAGE_SEND_ERROR",
        "Failed to send message",
      );
    }
  }

  private async handlePrivateMessage(ws: AuthenticatedWebSocket, payload: any) {
    try {
      const { recipientId, content } = schemas.privateMessageSchema.parse({
        type: WebSocketMessageType.PRIVATE_MESSAGE,
        payload,
      }).payload;

      const recipient = this.clients.get(recipientId);
      if (!recipient) {
        return ErrorHandler.sendError(
          ws,
          "RECIPIENT_NOT_FOUND",
          "Recipient not found or offline",
        );
      }

      const message = {
        type: WebSocketMessageType.PRIVATE_MESSAGE,
        payload: {
          content,
          senderId: ws.userId,
          timestamp: new Date(),
        },
      };

      recipient.send(JSON.stringify(message));
    } catch (error) {
      logger.error("Error in handlePrivateMessage:", error);
      ErrorHandler.sendError(
        ws,
        "PRIVATE_MESSAGE_ERROR",
        "Failed to send private message",
      );
    }
  }

  private async handleTypingStatus(
    ws: AuthenticatedWebSocket,
    message: WebSocketMessage,
  ) {
    try {
      const { roomId } = schemas.typingSchema.parse(message).payload;

      if (!(await RoomService.validateRoomAccess(ws.userId, roomId))) {
        return ErrorHandler.sendError(
          ws,
          "UNAUTHORIZED",
          "Not a member of this room",
        );
      }

      if (message.type === WebSocketMessageType.TYPING_START) {
        // Clear existing timeout if any
        const existingTimeout = ws.isTyping.get(roomId);
        if (existingTimeout) clearTimeout(existingTimeout);

        // Set new timeout
        const timeout = setTimeout(() => {
          this.broadcastTypingStatus(ws, roomId, false);
          ws.isTyping.delete(roomId);
        }, 3000);

        ws.isTyping.set(roomId, timeout);
        this.broadcastTypingStatus(ws, roomId, true);
      } else {
        const timeout = ws.isTyping.get(roomId);
        if (timeout) {
          clearTimeout(timeout);
          ws.isTyping.delete(roomId);
        }
        this.broadcastTypingStatus(ws, roomId, false);
      }
    } catch (error) {
      logger.error("Error in handleTypingStatus:", error);
      ErrorHandler.sendError(
        ws,
        "TYPING_STATUS_ERROR",
        "Failed to update typing status",
      );
    }
  }

  private broadcastTypingStatus(
    ws: AuthenticatedWebSocket,
    roomId: string,
    isTyping: boolean,
  ) {
    this.broadcastToRoom(
      roomId,
      {
        type: isTyping
          ? WebSocketMessageType.TYPING_START
          : WebSocketMessageType.TYPING_STOP,
        payload: {
          userId: ws.userId,
          roomId,
        },
      },
      [ws.userId],
    );
  }

  private async handleDisconnect(ws: AuthenticatedWebSocket) {
    try {
      this.clients.delete(ws.userId);
      await this.updateUserStatus(ws.userId, false);

      // Clear typing timeouts
      ws.isTyping.forEach((timeout) => clearTimeout(timeout));
      ws.isTyping.clear();

      // Notify all rooms about user's departure
      ws.rooms.forEach((roomId) => {
        this.broadcastToRoom(roomId, {
          type: WebSocketMessageType.USER_STATUS,
          payload: {
            userId: ws.userId,
            status: "offline",
            roomId,
          },
        });
      });
    } catch (error) {
      logger.error("Error in handleDisconnect:", error);
    }
  }

  private async updateUserStatus(userId: string, isOnline: boolean) {
    try {
      await prisma.user.update({
        where: { id: userId },
        data: { isOnline },
      });
    } catch (error) {
      logger.error("Error updating user status:", error);
    }
  }

  private async broadcastToRoom(
    roomId: string,
    message: WebSocketMessage,
    excludeUserIds: string[] = [],
  ) {
    try {
      const roomMembers = await RoomService.getRoomMembers(roomId);

      this.clients.forEach((client, userId) => {
        if (
          client.readyState === WebSocket.OPEN &&
          roomMembers.includes(userId) &&
          !excludeUserIds.includes(userId)
        ) {
          client.send(JSON.stringify(message));
        }
      });
    } catch (error) {
      logger.error("Error broadcasting to room:", error);
    }
  }

  public getWSServer() {
    return this.wss;
  }
}

