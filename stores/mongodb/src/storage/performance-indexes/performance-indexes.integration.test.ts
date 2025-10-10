import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoDBStore } from '../index';
import type { MongoDBConfig } from '../types';
import {
  TABLE_THREADS,
  TABLE_MESSAGES,
  TABLE_TRACES,
  TABLE_EVALS,
  TABLE_SCORERS,
  TABLE_AI_SPANS,
} from '@mastra/core/storage';

const TEST_CONFIG: MongoDBConfig = {
  url: process.env.MONGODB_URL || 'mongodb://localhost:27017',
  dbName: process.env.MONGODB_DB_NAME || 'mastra-test-indexes',
};

describe('MongoDBStore Performance Indexes - Integration Tests', () => {
  let store: MongoDBStore;

  beforeAll(async () => {
    store = new MongoDBStore(TEST_CONFIG);
    await store.init();

    // Clean up any existing test data
    try {
      await store.stores.operations.dropTable({ tableName: TABLE_THREADS });
      await store.stores.operations.dropTable({ tableName: TABLE_MESSAGES });
      await store.stores.operations.dropTable({ tableName: TABLE_TRACES });
    } catch (error) {
      // Tables might not exist, that's fine
    }

    // Create test collections by inserting dummy data
    await store.stores.operations.insert({
      tableName: TABLE_THREADS,
      record: { id: 'test-1', resourceId: 'res-1', createdAt: new Date() },
    });
    await store.stores.operations.insert({
      tableName: TABLE_MESSAGES,
      record: { id: 'msg-1', thread_id: 'thread-1', content: 'test', role: 'user', createdAt: new Date() },
    });
    await store.stores.operations.insert({
      tableName: TABLE_TRACES,
      record: { id: 'trace-1', name: 'test-trace', startTime: new Date() },
    });
  });

  afterAll(async () => {
    // Clean up test data
    try {
      await store.stores.operations.clearTable({ tableName: TABLE_THREADS });
      await store.stores.operations.clearTable({ tableName: TABLE_MESSAGES });
      await store.stores.operations.clearTable({ tableName: TABLE_TRACES });
    } catch (error) {
      // Ignore cleanup errors
    }
    await store.disconnect();
  });

  describe('createIndex', () => {
    it('should create a real index', async () => {
      await store.stores.operations.createIndex({
        name: 'test_simple_index',
        table: TABLE_THREADS,
        columns: ['resourceId'],
      });

      const indexes = await store.stores.operations.listIndexes(TABLE_THREADS);
      const createdIndex = indexes.find(idx => idx.name === 'test_simple_index');

      expect(createdIndex).toBeDefined();
      expect(createdIndex?.columns).toContain('resourceId');
    });

    it('should create a compound index with ascending and descending', async () => {
      await store.stores.operations.createIndex({
        name: 'test_compound_index',
        table: TABLE_THREADS,
        columns: ['resourceId', 'createdAt DESC'],
      });

      const indexes = await store.stores.operations.listIndexes(TABLE_THREADS);
      const createdIndex = indexes.find(idx => idx.name === 'test_compound_index');

      expect(createdIndex).toBeDefined();
      expect(createdIndex?.columns).toContain('resourceId');
      expect(createdIndex?.columns).toContain('createdAt');
    });

    it('should create a unique index', async () => {
      await store.stores.operations.createIndex({
        name: 'test_unique_index',
        table: TABLE_THREADS,
        columns: ['id'],
        unique: true,
      });

      const indexes = await store.stores.operations.listIndexes(TABLE_THREADS);
      const createdIndex = indexes.find(idx => idx.name === 'test_unique_index');

      expect(createdIndex).toBeDefined();
      expect(createdIndex?.unique).toBe(true);
    });

    it('should not throw when creating duplicate index', async () => {
      await store.stores.operations.createIndex({
        name: 'test_duplicate_index',
        table: TABLE_THREADS,
        columns: ['resourceId'],
      });

      // Try to create the same index again
      await expect(
        store.stores.operations.createIndex({
          name: 'test_duplicate_index',
          table: TABLE_THREADS,
          columns: ['resourceId'],
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('listIndexes', () => {
    it('should list all indexes for a collection', async () => {
      const indexes = await store.stores.operations.listIndexes(TABLE_THREADS);

      // Should have at least our test indexes
      expect(indexes.length).toBeGreaterThan(0);

      // Should not include _id_ index
      const hasIdIndex = indexes.some(idx => idx.name === '_id_');
      expect(hasIdIndex).toBe(false);
    });

    it('should list indexes for all collections', async () => {
      const indexes = await store.stores.operations.listIndexes();

      // Should have indexes from multiple collections
      expect(indexes.length).toBeGreaterThan(0);

      const tables = [...new Set(indexes.map(idx => idx.table))];
      expect(tables.length).toBeGreaterThan(1);
    });
  });

  describe('describeIndex', () => {
    it('should get detailed info about an index', async () => {
      await store.stores.operations.createIndex({
        name: 'test_describe_index',
        table: TABLE_THREADS,
        columns: ['resourceId', 'createdAt DESC'],
      });

      const indexInfo = await store.stores.operations.describeIndex('test_describe_index');

      expect(indexInfo.name).toBe('test_describe_index');
      expect(indexInfo.table).toBe(TABLE_THREADS);
      expect(indexInfo.columns).toContain('resourceId');
      expect(indexInfo.columns).toContain('createdAt');
      expect(indexInfo.method).toBe('btree');
      expect(indexInfo.scans).toBeGreaterThanOrEqual(0);
    });

    it('should throw if index not found', async () => {
      await expect(store.stores.operations.describeIndex('nonexistent_index_xyz')).rejects.toThrow(
        /not found/,
      );
    });
  });

  describe('dropIndex', () => {
    it('should drop an existing index', async () => {
      // Create an index
      await store.stores.operations.createIndex({
        name: 'test_drop_index',
        table: TABLE_THREADS,
        columns: ['resourceId'],
      });

      // Verify it exists
      let indexes = await store.stores.operations.listIndexes(TABLE_THREADS);
      let hasIndex = indexes.some(idx => idx.name === 'test_drop_index');
      expect(hasIndex).toBe(true);

      // Drop it
      await store.stores.operations.dropIndex('test_drop_index');

      // Verify it's gone
      indexes = await store.stores.operations.listIndexes(TABLE_THREADS);
      hasIndex = indexes.some(idx => idx.name === 'test_drop_index');
      expect(hasIndex).toBe(false);
    });

    it('should not throw when dropping non-existent index', async () => {
      await expect(store.stores.operations.dropIndex('nonexistent_drop_index')).resolves.not.toThrow();
    });
  });

  describe('createAutomaticIndexes', () => {
    it('should create all automatic indexes', async () => {
      await store.stores.operations.createAutomaticIndexes();

      // Verify some key indexes were created
      const threadsIndexes = await store.stores.operations.listIndexes(TABLE_THREADS);
      const hasThreadsIndex = threadsIndexes.some(
        idx => idx.name === 'mastra_threads_resourceid_createdat_idx',
      );
      expect(hasThreadsIndex).toBe(true);

      const messagesIndexes = await store.stores.operations.listIndexes(TABLE_MESSAGES);
      const hasMessagesIndex = messagesIndexes.some(
        idx => idx.name === 'mastra_messages_thread_id_createdat_idx',
      );
      expect(hasMessagesIndex).toBe(true);

      const tracesIndexes = await store.stores.operations.listIndexes(TABLE_TRACES);
      const hasTracesIndex = tracesIndexes.some(idx => idx.name === 'mastra_traces_name_starttime_idx');
      expect(hasTracesIndex).toBe(true);
    });

    it('should not fail when called multiple times', async () => {
      await expect(store.stores.operations.createAutomaticIndexes()).resolves.not.toThrow();
      await expect(store.stores.operations.createAutomaticIndexes()).resolves.not.toThrow();
    });
  });

  describe('Index functionality', () => {
    it('should use compound index for sorting queries', async () => {
      // Create compound index
      await store.stores.operations.createIndex({
        name: 'test_sort_index',
        table: TABLE_THREADS,
        columns: ['resourceId', 'createdAt DESC'],
      });

      // Insert multiple records
      await store.stores.operations.insert({
        tableName: TABLE_THREADS,
        record: { id: 'test-2', resourceId: 'res-2', createdAt: new Date('2024-01-01') },
      });
      await store.stores.operations.insert({
        tableName: TABLE_THREADS,
        record: { id: 'test-3', resourceId: 'res-2', createdAt: new Date('2024-01-02') },
      });
      await store.stores.operations.insert({
        tableName: TABLE_THREADS,
        record: { id: 'test-4', resourceId: 'res-2', createdAt: new Date('2024-01-03') },
      });

      // Query should be able to use the index
      const collection = await store.stores.operations.getCollection(TABLE_THREADS);
      const results = await collection
        .find({ resourceId: 'res-2' })
        .sort({ createdAt: -1 })
        .toArray();

      expect(results.length).toBe(3);
      // Verify sorting (descending)
      expect(new Date(results[0].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(results[1].createdAt).getTime(),
      );
    });
  });
});
