import mongoose from 'mongoose';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { notificationEvents } from '../utils/notifications.js';

export const listNotifications = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const filter = { recipient: req.user._id };
  if (req.query.unread === 'true') filter.readAt = null;

  const [data, total, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ recipient: req.user._id, readAt: null }),
  ]);
  res.json({ data, unread, pagination: { page, limit, total, pages: Math.max(Math.ceil(total / limit), 1) } });
});

export const markNotificationRead = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Notification ID is invalid');
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, recipient: req.user._id, readAt: null },
    { $set: { readAt: new Date() } },
    { new: true }
  );
  if (!notification) throw new ApiError(404, 'Notification not found');
  res.json({ data: notification });
});

export const markAllNotificationsRead = asyncHandler(async (_req, res) => {
  const result = await Notification.updateMany(
    { recipient: _req.user._id, readAt: null },
    { $set: { readAt: new Date() } }
  );
  res.json({ data: { updated: result.modifiedCount } });
});

export const registerPushToken = asyncHandler(async (req, res) => {
  const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
  if (!token) throw new ApiError(400, 'Push token is required');
  const platform = ['android', 'ios', 'web'].includes(req.body.platform) ? req.body.platform : 'android';
  await User.updateOne(
    { _id: req.user._id },
    { $pull: { pushTokens: { token } }, }
  );
  await User.updateOne(
    { _id: req.user._id },
    { $push: { pushTokens: { token, platform, updatedAt: new Date() } } }
  );
  res.status(201).json({ message: 'Push notification token registered' });
});

export const removePushToken = asyncHandler(async (req, res) => {
  const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
  await User.updateOne(
    { _id: req.user._id },
    token ? { $pull: { pushTokens: { token } } } : { $set: { pushTokens: [] } }
  );
  res.json({ message: 'Push notification token removed' });
});

export const streamNotifications = asyncHandler(async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const eventName = `notification:${req.user._id}`;
  const onNotification = (notification) => {
    res.write(`event: notification\n`);
    res.write(`data: ${JSON.stringify(notification)}\n\n`);
  };
  notificationEvents.on(eventName, onNotification);
  res.write(': connected\n\n');

  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    notificationEvents.off(eventName, onNotification);
  });
});
