import { createHash } from 'node:crypto';

/**
 * Детерминированный jobId: повторная публикация или повторный запуск задачи
 * после сбоя не создаёт дубль, потому что BullMQ игнорирует существующий jobId.
 */
export const toQueueJobId = (eventId: string, rescheduleCount = 0): string => {
  const base = /^[a-zA-Z0-9_-]+$/.test(eventId)
    ? eventId
    : `event-${createHash('sha256').update(eventId).digest('hex')}`;

  return rescheduleCount > 0 ? `${base}--r${rescheduleCount}` : base;
};
