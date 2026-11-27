import { EventEmitter } from 'node:events';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import { FLEET_MANAGERS } from '../constants/roles.js';
import { log } from './logger.js';

export const notificationEvents = new EventEmitter();
notificationEvents.setMaxListeners(1000);
const MAX_DELIVERY_ATTEMPTS = 6;
const PROCESSING_LEASE_MS = 60 * 1000;
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 120_000, 600_000, 1_800_000];
let workerTimer;
let workerRunning = false;

export async function createNotification({
  recipient,
  title,
  body,
  category,
  data = {},
  sendPush = true,
}) {
  const recipientId = recipient?._id || recipient;
  if (!recipientId) return null;

  const notification = await Notification.create({
    recipient: recipientId,
    title,
    body,
    category,
    data,
    pushDelivery: { status: sendPush ? 'queued' : 'skipped' },
  });
  const payload = {
    _id: notification._id,
    recipient: recipientId,
    title,
    body,
    category,
    data,
    readAt: null,
    createdAt: notification.createdAt,
  };
  notificationEvents.emit(`notification:${recipientId}`, payload);

  return notification;
}

async function deliverNextNotification() {
  const now = new Date();
  const notification = await Notification.findOneAndUpdate(
    {
      $or: [
        { 'pushDelivery.status': 'queued', 'pushDelivery.nextAttemptAt': { $lte: now } },
        { 'pushDelivery.status': 'processing', 'pushDelivery.lockedAt': { $lte: new Date(now.getTime() - PROCESSING_LEASE_MS) } },
      ],
    },
    {
      $set: { 'pushDelivery.status': 'processing', 'pushDelivery.lockedAt': now },
      $inc: { 'pushDelivery.attempts': 1 },
    },
    { new: true, sort: { 'pushDelivery.nextAttemptAt': 1, createdAt: 1 } }
  ).select('+pushDelivery').lean();
  if (!notification) return false;

  const user = await User.findById(notification.recipient).select('pushTokens').lean();
  const tokens = [...new Set((user?.pushTokens || []).map((item) => item.token).filter(Boolean))];
  if (tokens.length === 0) {
    await Notification.updateOne(
      { _id: notification._id, 'pushDelivery.status': 'processing' },
      {
        $set: {
          'pushDelivery.status': 'skipped',
          'pushDelivery.lastError': 'No push token was registered for this recipient.',
        },
        $unset: { 'pushDelivery.lockedAt': 1 },
      }
    );
    return true;
  }

  let acceptedTicketCount = 0;
  try {
    for (let offset = 0; offset < tokens.length; offset += 100) {
      const tokenBatch = tokens.slice(offset, offset + 100);
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tokenBatch.map((to) => ({
          to,
          title: notification.title,
          body: notification.body,
          data: notification.data,
        }))),
        signal: AbortSignal.timeout(8000),
      });
      const result = await response.json();
      const tickets = Array.isArray(result.data) ? result.data : [result.data];
      const failures = tickets.filter((ticket) => ticket?.status !== 'ok');
      const invalidTokens = tickets.flatMap((ticket, index) =>
        ticket?.details?.error === 'DeviceNotRegistered' && tokenBatch[index] ? [tokenBatch[index]] : []
      );
      acceptedTicketCount += tickets.filter((ticket) => ticket?.status === 'ok').length;
      if (invalidTokens.length) {
        await User.updateOne(
          { _id: delivery.recipient },
          { $pull: { pushTokens: { token: { $in: invalidTokens } } } }
        );
      }
      const retryableFailures = failures.filter((ticket) => ticket?.details?.error !== 'DeviceNotRegistered');
      if (!response.ok || tickets.length !== tokenBatch.length || retryableFailures.length) {
        const message = retryableFailures.map((ticket) => ticket?.message || ticket?.details?.error).filter(Boolean).join('; ')
          || `Expo push request failed with status ${response.status}`;
        throw new Error(message);
      }
    }

    if (acceptedTicketCount === 0) {
      await Notification.updateOne(
        { _id: notification._id, 'pushDelivery.status': 'processing' },
        { $set: { 'pushDelivery.status': 'skipped', 'pushDelivery.lastError': 'All registered push tokens were no longer active.' }, $unset: { 'pushDelivery.lockedAt': 1 } }
      );
    } else {
      await Notification.updateOne(
        { _id: notification._id, 'pushDelivery.status': 'processing' },
        { $set: { 'pushDelivery.status': 'delivered', 'pushDelivery.deliveredAt': new Date() }, $unset: { 'pushDelivery.lockedAt': 1, 'pushDelivery.lastError': 1 } }
      );
    }
  } catch (error) {
    const terminal = notification.pushDelivery.attempts >= MAX_DELIVERY_ATTEMPTS;
    await Notification.updateOne(
      { _id: notification._id, 'pushDelivery.status': 'processing' },
      {
        $set: {
          'pushDelivery.status': terminal ? 'failed' : 'queued',
          'pushDelivery.nextAttemptAt': new Date(Date.now() + RETRY_DELAYS_MS[Math.min(notification.pushDelivery.attempts - 1, RETRY_DELAYS_MS.length - 1)]),
          'pushDelivery.lastError': String(error.message || error).slice(0, 1000),
        },
        $unset: { 'pushDelivery.lockedAt': 1 },
      }
    );
  }
  return true;
}

export function startNotificationWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      await deliverNextNotification();
    } catch (error) {
      log('error', 'notification_delivery_worker_error', { message: error.message });
    } finally {
      workerRunning = false;
    }
  }, 2_000);
  workerTimer.unref?.();
}

export function stopNotificationWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = undefined;
}

export async function notifyFleetManagers(notification) {
  const managers = await User.find({ role: { $in: FLEET_MANAGERS }, isActive: true }).select('_id');
  await Promise.all(managers.map((manager) => createNotification({ recipient: manager._id, ...notification })));
}