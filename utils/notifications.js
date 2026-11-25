import { EventEmitter } from 'node:events';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import { FLEET_MANAGERS } from '../constants/roles.js';

export const notificationEvents = new EventEmitter();
notificationEvents.setMaxListeners(1000);

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

  if (sendPush) {
    const user = await User.findById(recipientId).select('pushTokens').lean();
    const tokens = [...new Set((user?.pushTokens || []).map((item) => item.token).filter(Boolean))];
    if (tokens.length) {
      try {
        await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tokens.map((to) => ({ to, title, body, data }))),
          signal: AbortSignal.timeout(8000),
        });
      } catch (error) {
        console.error('Unable to deliver Expo push notification:', error.message);
      }
    }
  }
  return notification;
}

export async function notifyFleetManagers(notification) {
  const managers = await User.find({ role: { $in: FLEET_MANAGERS }, isActive: true }).select('_id');
  await Promise.all(managers.map((manager) => createNotification({ recipient: manager._id, ...notification })));
}
