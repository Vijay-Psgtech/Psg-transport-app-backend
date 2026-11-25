import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import RefreshSession from '../models/RefreshSession.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  REFRESH_COOKIE,
  signAccessToken,
  signRefreshToken,
  setRefreshCookie,
  clearRefreshCookie,
} from '../utils/tokens.js';

const hashRefreshToken = (token) => createHash('sha256').update(token).digest('hex');

const refreshTokenExpiry = (token) => {
  const payload = jwt.decode(token);
  if (!payload || typeof payload !== 'object' || typeof payload.exp !== 'number') {
    throw new ApiError(500, 'The server generated an invalid refresh token');
  }
  return new Date(payload.exp * 1000);
};

const createRefreshSession = (userId, sessionId, token) => RefreshSession.create({
  user: userId,
  sessionId,
  tokenHash: hashRefreshToken(token),
  expiresAt: refreshTokenExpiry(token),
});

const clearInvalidWebRefresh = (res, nativeClient) => {
  if (!nativeClient) clearRefreshCookie(res);
};

// POST /api/auth/login
export const login = asyncHandler(async (req, res) => {
  const { email, phone, password } = req.body;
  const nativeClient = req.body.client === 'native';
  const hasEmail = email !== undefined;
  const hasPhone = phone !== undefined;
  // typeof checks also block NoSQL operator injection such as { "$ne": "" }
  if (
    hasEmail === hasPhone ||
    (hasEmail && (typeof email !== 'string' || !email.trim())) ||
    (hasPhone && (typeof phone !== 'string' || !phone.trim())) ||
    typeof password !== 'string' ||
    !password
  ) {
    throw new ApiError(400, 'Enter an email address or phone number and your password');
  }

  const query = hasPhone
    ? { phone: phone.replace(/[\s-]/g, '') }
    : { email: email.toLowerCase().trim() };
  const user = await User.findOne(query).select('+password');
  const valid = user && (await user.comparePassword(password));
  if (!valid) throw new ApiError(401, 'Invalid sign-in details', 'INVALID_CREDENTIALS');
  if (!user.isActive) throw new ApiError(403, 'Your account is deactivated. Contact the administrator.', 'ACCOUNT_DISABLED');

  await User.updateOne({ _id: user._id }, { lastLoginAt: new Date() });

  const sessionId = randomUUID();
  const refreshToken = signRefreshToken(user, sessionId);
  await createRefreshSession(user._id, sessionId, refreshToken);
  if (nativeClient) {
    return res.json({ accessToken: signAccessToken(user), refreshToken, user });
  }
  setRefreshCookie(res, refreshToken);
  res.json({ accessToken: signAccessToken(user), user });
});

// POST /api/auth/refresh (web uses the httpOnly cookie; native clients send the refresh token in the body)
export const refresh = asyncHandler(async (req, res) => {
  const nativeClient = req.body?.client === 'native';
  const token = nativeClient ? req.body.refreshToken : req.cookies?.[REFRESH_COOKIE];
  if (nativeClient && (typeof token !== 'string' || !token)) {
    throw new ApiError(401, 'No active session', 'NO_SESSION');
  }
  if (!token) throw new ApiError(401, 'No active session', 'NO_SESSION');

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  } catch {
    clearInvalidWebRefresh(res, nativeClient);
    throw new ApiError(401, 'Session expired. Please sign in again.', 'SESSION_EXPIRED');
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.sub !== 'string' ||
    typeof payload.sid !== 'string' ||
    typeof payload.iat !== 'number'
  ) {
    clearInvalidWebRefresh(res, nativeClient);
    throw new ApiError(401, 'Session expired. Please sign in again.', 'SESSION_EXPIRED');
  }

  const user = await User.findById(payload.sub);
  if (!user || !user.isActive || user.changedPasswordAfter(payload.iat)) {
    await RefreshSession.deleteOne({ tokenHash: hashRefreshToken(token) });
    clearInvalidWebRefresh(res, nativeClient);
    throw new ApiError(401, 'Session expired. Please sign in again.', 'SESSION_EXPIRED');
  }

  const refreshToken = signRefreshToken(user, payload.sid);
  const updatedSession = await RefreshSession.findOneAndUpdate(
    {
      sessionId: payload.sid,
      user: user._id,
      tokenHash: hashRefreshToken(token),
      expiresAt: { $gt: new Date() },
    },
    {
      $set: {
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: refreshTokenExpiry(refreshToken),
      },
    },
    { new: true }
  );
  if (!updatedSession) {
    clearInvalidWebRefresh(res, nativeClient);
    throw new ApiError(401, 'Session expired. Please sign in again.', 'SESSION_EXPIRED');
  }

  if (nativeClient) {
    return res.json({ accessToken: signAccessToken(user), refreshToken, user });
  }
  setRefreshCookie(res, refreshToken); // sliding session
  res.json({ accessToken: signAccessToken(user), user });
});

// POST /api/auth/logout
export const logout = asyncHandler(async (req, res) => {
  const nativeClient = req.body?.client === 'native';
  const token = nativeClient ? req.body.refreshToken : req.cookies?.[REFRESH_COOKIE];
  if (typeof token === 'string' && token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET, { ignoreExpiration: true });
      if (payload && typeof payload === 'object' && typeof payload.sid === 'string') {
        await RefreshSession.deleteOne({ sessionId: payload.sid });
      }
    } catch (error) {
      if (!(error instanceof jwt.JsonWebTokenError)) throw error;
    }
  }
  clearRefreshCookie(res);
  res.json({ message: 'Signed out' });
});

// GET /api/auth/me
export const me = (req, res) => res.json({ user: req.user });

// PUT /api/auth/me  -> users edit their own name and phone only
export const updateMe = asyncHandler(async (req, res) => {
  const { name, phone } = req.body;
  const user = req.user;
  if (name !== undefined) user.name = name;
  if (phone !== undefined) user.phone = phone === '' || phone === null ? undefined : phone;
  await user.validate(['name', 'phone']);
  await user.save({ validateBeforeSave: false });
  res.json({ user });
});

// PUT /api/auth/change-password
export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword) {
    throw new ApiError(400, 'Current password and new password are required');
  }

  const user = await User.findById(req.user._id).select('+password');
  if (!(await user.comparePassword(currentPassword))) {
    throw new ApiError(400, 'Current password is incorrect', 'WRONG_PASSWORD');
  }
  if (currentPassword === newPassword) throw new ApiError(400, 'New password must be different from the current one');

  user.password = newPassword;
  user.mustChangePassword = false;
  await user.validate(['password']); // password policy, checked on the plain text
  await user.save({ validateBeforeSave: false });

  await RefreshSession.deleteMany({ user: user._id });
  const sessionId = randomUUID();
  const refreshToken = signRefreshToken(user, sessionId);
  await createRefreshSession(user._id, sessionId, refreshToken);
  if (req.body.client === 'native') {
    return res.json({ accessToken: signAccessToken(user), refreshToken, user, message: 'Password changed' });
  }
  setRefreshCookie(res, refreshToken);
  res.json({ accessToken: signAccessToken(user), user, message: 'Password changed' });
});
