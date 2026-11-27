import RateLimitBucket from '../models/RateLimitBucket.js';

export default class MongoRateLimitStore {
  init(options) {
    this.windowMs = options.windowMs;
  }

  async get(key) {
    const bucket = await RateLimitBucket.findOne({ _id: key, resetTime: { $gt: new Date() } }).lean();
    return bucket ? { totalHits: bucket.totalHits, resetTime: bucket.resetTime } : undefined;
  }

  async increment(key) {
    const now = new Date();
    const resetTime = new Date(now.getTime() + this.windowMs);
    const update = [
      {
        $set: {
          totalHits: {
            $cond: [
              { $gt: ['$resetTime', now] },
              { $add: [{ $ifNull: ['$totalHits', 0] }, 1] },
              1,
            ],
          },
          resetTime: { $cond: [{ $gt: ['$resetTime', now] }, '$resetTime', resetTime] },
        },
      },
    ];
    let bucket;
    try {
      bucket = await RateLimitBucket.findOneAndUpdate(
        { _id: key },
        update,
        { upsert: true, new: true, setDefaultsOnInsert: false }
      ).lean();
    } catch (error) {
      if (error.code !== 11000) throw error;
      bucket = await RateLimitBucket.findOneAndUpdate(
        { _id: key },
        update,
        { new: true, setDefaultsOnInsert: false }
      ).lean();
    }
    if (!bucket) {
      bucket = await RateLimitBucket.findOneAndUpdate(
        { _id: key },
        update,
        { upsert: true, new: true, setDefaultsOnInsert: false }
      ).lean();
    }
    return { totalHits: bucket.totalHits, resetTime: bucket.resetTime };
  }

  async decrement(key) {
    await RateLimitBucket.updateOne({ _id: key, totalHits: { $gt: 0 } }, { $inc: { totalHits: -1 } });
  }

  async resetKey(key) {
    await RateLimitBucket.deleteOne({ _id: key });
  }

  async resetAll() {
    await RateLimitBucket.deleteMany({});
  }

  shutdown() {}
}