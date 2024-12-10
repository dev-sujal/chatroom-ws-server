import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export class MessageService {
  static async createMessage(userId: string, roomId: string, content: string) {
    try {
      return await prisma.message.create({
        data: {
          content,
          userId,
          roomId,
        },
        include: {
          user: {
            select: {
              username: true,
            },
          },
        },
      });
    } catch (error) {
      logger.error('Error creating message:', error);
      throw new Error('Failed to create message');
    }
  }

  static async getRecentMessages(roomId: string, limit = 50) {
    try {
      return await prisma.message.findMany({
        where: { roomId },
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              username: true,
            },
          },
        },
      });
    } catch (error) {
      logger.error('Error fetching recent messages:', error);
      throw new Error('Failed to fetch messages');
    }
  }
}