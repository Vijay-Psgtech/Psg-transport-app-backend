import { Router } from 'express';
import {
  acknowledgeAdvancePayment,
  createAdvanceRequest,
  getAdvanceProof,
  listAdvanceRequests,
  reviewAdvanceRequest,
} from '../controllers/advanceRequestController.js';
import { protect, authorize } from '../middleware/auth.js';
import uploadAdvanceProof from '../middleware/advanceProofUpload.js';
import { FLEET_MANAGERS, ROLES } from '../constants/roles.js';

const router = Router();
router.use(protect);

router.get('/', authorize(ROLES.DRIVER, ...FLEET_MANAGERS), listAdvanceRequests);
router.post('/', authorize(ROLES.DRIVER), uploadAdvanceProof, createAdvanceRequest);
router.get('/:id/proof', authorize(ROLES.DRIVER, ...FLEET_MANAGERS), getAdvanceProof);
router.patch('/:id/review', authorize(...FLEET_MANAGERS), reviewAdvanceRequest);
router.patch('/:id/acknowledge', authorize(...FLEET_MANAGERS), acknowledgeAdvancePayment);

export default router;