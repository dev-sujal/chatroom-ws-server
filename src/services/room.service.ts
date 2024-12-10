import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export class RoomService {
  static async validateRoomAccess(userId: string, roomId: string): Promise<boolean> {
    try {
      const roomUser = await prisma.roomUser.findUnique({
        where: {
          userId_roomId: {
            userId,
            roomId,
          },
        },
      });
      return !!roomUser;
    } catch (error) {
      logger.error('Error validating room access:', error);
      return false;
    }
  }

  static async addUserToRoom(userId: string, roomId: string): Promise<boolean> {
    try {
      await prisma.roomUser.create({
        data: {
          userId,
          roomId,
        },
      });
      return true;
    } catch (error) {
      logger.error('Error adding user to room:', error);
      return false;
    }
  }

  static async removeUserFromRoom(userId: string, roomId: string): Promise<boolean> {
    try {
      await prisma.roomUser.delete({
        where: {
          userId_roomId: {
            userId,
            roomId,
          },
        },
      });
      return true;
    } catch (error) {
      logger.error('Error removing user from room:', error);
      return false;
    }
  }

  static async getRoomMembers(roomId: string): Promise<string[]> {
    try {
      const roomUsers = await prisma.roomUser.findMany({
        where: { roomId },
        select: { userId: true },
      });
      return roomUsers.map(user => user.userId);
    } catch (error) {
      logger.error('Error getting room members:', error);
      return [];
    }
  }
}