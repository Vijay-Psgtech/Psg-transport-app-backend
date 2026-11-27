import { Router } from 'express';
import {
  listNotifications, markAllNotificationsRead, markNotificationRead,
  registerPushToken, removePushToken, streamNotifications,
} from '../controllers/notificationController.js';
import { protect } from '../middleware/auth.js';

const router = Router();
router.use(protect);
router.get('/', listNotifications);
router.get('/stream', streamNotifications);
router.patch('/read-all', markAllNotificationsRead);
router.patch('/:id/read', markNotificationRead);
router.post('/push-token', registerPushToken);
router.delete('/push-token', removePushToken);

export default router;