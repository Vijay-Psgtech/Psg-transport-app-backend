import AdvanceRequest from '../models/AdvanceRequest.js';
import TripSheet from '../models/TripSheet.js';

async function replaceLegacyIndex(Model, scopedIndexName) {
  const collection = Model.collection;
  const indexes = await collection.indexes().catch((error) => {
    if (error.code === 26 || error.codeName === 'NamespaceNotFound') return [];
    throw error;
  });
  const legacyIndexes = indexes.filter((index) =>
    Object.keys(index.key).length === 1 && index.key.idempotencyKey === 1
  );
  for (const index of legacyIndexes) {
    try {
      await collection.dropIndex(index.name);
    } catch (error) {
      if (error.code !== 27 && error.codeName !== 'IndexNotFound') throw error;
    }
  }
  await collection.createIndex(
    { driver: 1, assignment: 1, idempotencyKey: 1 },
    {
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: 'string' } },
      name: scopedIndexName,
    }
  );
}

export default async function migrateIdempotencyIndexes() {
  await replaceLegacyIndex(TripSheet, 'uniq_trip_idempotency_scope');
  await replaceLegacyIndex(AdvanceRequest, 'uniq_advance_idempotency_scope');
}