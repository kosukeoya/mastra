import {
  TABLE_THREADS,
  TABLE_MESSAGES,
  TABLE_TRACES,
  TABLE_EVALS,
  TABLE_SCORERS,
  TABLE_AI_SPANS,
} from '@mastra/core/storage';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StoreOperationsMongoDB } from '../domains/operations';

describe('MongoDBStore Performance Indexes', () => {
  let operations: StoreOperationsMongoDB;
  let mockCollection: any;
  let mockDb: any;
  let mockConnector: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock collection
    mockCollection = {
      createIndex: vi.fn().mockResolvedValue('index_created'),
      dropIndex: vi.fn().mockResolvedValue(undefined),
      indexes: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn(() => ({
        toArray: vi.fn().mockResolvedValue([]),
      })),
    };

    // Mock database
    mockDb = {
      listCollections: vi.fn(() => ({
        toArray: vi.fn().mockResolvedValue([
          { name: TABLE_THREADS },
          { name: TABLE_MESSAGES },
          { name: TABLE_TRACES },
        ]),
      })),
      collection: vi.fn(() => mockCollection),
    };

    // Mock connector
    mockConnector = {
      getCollection: vi.fn().mockResolvedValue(mockCollection),
      getDatabase: vi.fn().mockResolvedValue(mockDb),
    };

    operations = new StoreOperationsMongoDB({
      connector: mockConnector as any,
    });
  });

  describe('createIndex', () => {
    it('should create a basic index', async () => {
      await operations.createIndex({
        name: 'test_index',
        table: TABLE_THREADS,
        columns: ['resourceId'],
      });

      expect(mockConnector.getCollection).toHaveBeenCalledWith(TABLE_THREADS);
      expect(mockCollection.createIndex).toHaveBeenCalledWith(
        { resourceId: 1 },
        { name: 'test_index', unique: false },
      );
    });

    it('should create a unique index', async () => {
      await operations.createIndex({
        name: 'unique_index',
        table: TABLE_THREADS,
        columns: ['resourceId'],
        unique: true,
      });

      expect(mockCollection.createIndex).toHaveBeenCalledWith(
        { resourceId: 1 },
        { name: 'unique_index', unique: true },
      );
    });

    it('should create a compound index with DESC', async () => {
      await operations.createIndex({
        name: 'compound_index',
        table: TABLE_THREADS,
        columns: ['resourceId', 'createdAt DESC'],
      });

      expect(mockCollection.createIndex).toHaveBeenCalledWith(
        { resourceId: 1, createdAt: -1 },
        { name: 'compound_index', unique: false },
      );
    });

    it('should skip if index already exists', async () => {
      mockCollection.indexes.mockResolvedValue([
        { name: 'existing_index', key: { field: 1 } },
      ]);

      await operations.createIndex({
        name: 'existing_index',
        table: TABLE_THREADS,
        columns: ['field'],
      });

      expect(mockCollection.createIndex).not.toHaveBeenCalled();
    });

    it('should handle IndexAlreadyExists error', async () => {
      const error: any = new Error('Index already exists');
      error.code = 85;
      error.codeName = 'IndexAlreadyExists';
      mockCollection.indexes.mockResolvedValue([]);
      mockCollection.createIndex.mockRejectedValue(error);

      await expect(
        operations.createIndex({
          name: 'test_index',
          table: TABLE_THREADS,
          columns: ['field'],
        }),
      ).resolves.not.toThrow();
    });

    it('should throw on other errors', async () => {
      const error = new Error('Connection failed');
      mockCollection.indexes.mockResolvedValue([]);
      mockCollection.createIndex.mockRejectedValue(error);

      await expect(
        operations.createIndex({
          name: 'test_index',
          table: TABLE_THREADS,
          columns: ['field'],
        }),
      ).rejects.toThrow();
    });
  });

  describe('dropIndex', () => {
    it('should drop an existing index', async () => {
      await operations.dropIndex('test_index');

      expect(mockConnector.getDatabase).toHaveBeenCalled();
      expect(mockDb.listCollections).toHaveBeenCalled();
      expect(mockCollection.dropIndex).toHaveBeenCalledWith('test_index');
    });

    it('should continue searching if index not found in first collection', async () => {
      const error: any = new Error('Index not found');
      error.codeName = 'IndexNotFound';
      error.code = 27;

      mockCollection.dropIndex
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(undefined);

      await operations.dropIndex('test_index');

      expect(mockCollection.dropIndex).toHaveBeenCalledTimes(3);
    });

    it('should not throw if index not found in any collection', async () => {
      const error: any = new Error('Index not found');
      error.codeName = 'IndexNotFound';
      mockCollection.dropIndex.mockRejectedValue(error);

      await expect(operations.dropIndex('nonexistent_index')).resolves.not.toThrow();
    });

    it('should throw on other errors', async () => {
      const error = new Error('Permission denied');
      mockCollection.dropIndex.mockRejectedValue(error);

      await expect(operations.dropIndex('test_index')).rejects.toThrow();
    });
  });

  describe('listIndexes', () => {
    it('should list indexes for a specific collection', async () => {
      mockCollection.indexes.mockResolvedValue([
        { name: '_id_', key: { _id: 1 } },
        { name: 'idx1', key: { field1: 1 }, unique: false },
        { name: 'idx2', key: { field2: -1 }, unique: true },
      ]);

      const result = await operations.listIndexes(TABLE_THREADS);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'idx1',
        table: TABLE_THREADS,
        columns: ['field1'],
        unique: false,
        size: '0',
        definition: expect.any(String),
      });
      expect(result[1]).toEqual({
        name: 'idx2',
        table: TABLE_THREADS,
        columns: ['field2'],
        unique: true,
        size: '0',
        definition: expect.any(String),
      });
    });

    it('should exclude _id_ index', async () => {
      mockCollection.indexes.mockResolvedValue([
        { name: '_id_', key: { _id: 1 } },
        { name: 'custom_idx', key: { field: 1 } },
      ]);

      const result = await operations.listIndexes(TABLE_THREADS);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('custom_idx');
    });

    it('should list indexes for all collections when no table specified', async () => {
      mockCollection.indexes.mockResolvedValue([
        { name: 'idx1', key: { field: 1 }, unique: false },
      ]);

      const result = await operations.listIndexes();

      expect(mockDb.listCollections).toHaveBeenCalled();
      expect(result).toHaveLength(3); // 3 collections
    });

    it('should handle empty collections', async () => {
      mockCollection.indexes.mockResolvedValue([{ name: '_id_', key: { _id: 1 } }]);

      const result = await operations.listIndexes(TABLE_THREADS);

      expect(result).toHaveLength(0);
    });
  });

  describe('describeIndex', () => {
    it('should return detailed index stats', async () => {
      mockCollection.indexes.mockResolvedValue([
        {
          name: 'test_index',
          key: { field1: 1, field2: -1 },
          unique: true,
        },
      ]);

      const mockStats = [
        {
          name: 'test_index',
          accesses: { ops: 42 },
        },
      ];

      mockCollection.aggregate.mockReturnValue({
        toArray: vi.fn().mockResolvedValue(mockStats),
      });

      const result = await operations.describeIndex('test_index');

      expect(result).toEqual({
        name: 'test_index',
        table: TABLE_THREADS,
        columns: ['field1', 'field2'],
        unique: true,
        size: '0',
        definition: expect.any(String),
        method: 'btree',
        scans: 42,
        tuples_read: 0,
        tuples_fetched: 0,
      });
    });

    it('should handle missing index stats', async () => {
      mockCollection.indexes.mockResolvedValue([
        { name: 'test_index', key: { field: 1 } },
      ]);

      mockCollection.aggregate.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      });

      const result = await operations.describeIndex('test_index');

      expect(result.scans).toBe(0);
    });

    it('should handle $indexStats errors gracefully', async () => {
      mockCollection.indexes.mockResolvedValue([
        { name: 'test_index', key: { field: 1 } },
      ]);

      mockCollection.aggregate.mockReturnValue({
        toArray: vi.fn().mockRejectedValue(new Error('$indexStats not supported')),
      });

      const loggerWarnSpy = vi.fn();
      Object.defineProperty(operations, 'logger', {
        value: { warn: loggerWarnSpy },
        writable: true,
        configurable: true,
      });

      const result = await operations.describeIndex('test_index');

      expect(loggerWarnSpy).toHaveBeenCalled();
      expect(result.scans).toBe(0);
    });

    it('should throw if index not found', async () => {
      mockCollection.indexes.mockResolvedValue([]);

      await expect(operations.describeIndex('nonexistent_index')).rejects.toThrow(
        /Index "nonexistent_index" not found/,
      );
    });
  });

  describe('getAutomaticIndexDefinitions', () => {
    it('should return 9 index definitions', () => {
      const definitions = (operations as any).getAutomaticIndexDefinitions();

      expect(definitions).toHaveLength(9);
    });

    it('should include threads index', () => {
      const definitions = (operations as any).getAutomaticIndexDefinitions();

      expect(definitions).toContainEqual({
        name: 'mastra_threads_resourceid_createdat_idx',
        table: TABLE_THREADS,
        columns: ['resourceId', 'createdAt DESC'],
      });
    });

    it('should include messages index', () => {
      const definitions = (operations as any).getAutomaticIndexDefinitions();

      expect(definitions).toContainEqual({
        name: 'mastra_messages_thread_id_createdat_idx',
        table: TABLE_MESSAGES,
        columns: ['thread_id', 'createdAt DESC'],
      });
    });

    it('should include traces index', () => {
      const definitions = (operations as any).getAutomaticIndexDefinitions();

      expect(definitions).toContainEqual({
        name: 'mastra_traces_name_starttime_idx',
        table: TABLE_TRACES,
        columns: ['name', 'startTime DESC'],
      });
    });

    it('should include evals index', () => {
      const definitions = (operations as any).getAutomaticIndexDefinitions();

      expect(definitions).toContainEqual({
        name: 'mastra_evals_agent_name_created_at_idx',
        table: TABLE_EVALS,
        columns: ['agent_name', 'created_at DESC'],
      });
    });

    it('should include scorers index', () => {
      const definitions = (operations as any).getAutomaticIndexDefinitions();

      expect(definitions).toContainEqual({
        name: 'mastra_scores_trace_id_span_id_created_at_idx',
        table: TABLE_SCORERS,
        columns: ['traceId', 'spanId', 'createdAt DESC'],
      });
    });

    it('should include 4 AI spans indexes', () => {
      const definitions = (operations as any).getAutomaticIndexDefinitions();

      const aiSpansIndexes = definitions.filter((def: any) => def.table === TABLE_AI_SPANS);
      expect(aiSpansIndexes).toHaveLength(4);
    });
  });

  describe('createAutomaticIndexes', () => {
    it('should create all necessary indexes', async () => {
      const createIndexSpy = vi.spyOn(operations, 'createIndex').mockResolvedValue(undefined);

      await operations.createAutomaticIndexes();

      expect(createIndexSpy).toHaveBeenCalledTimes(9);

      // Verify specific indexes
      expect(createIndexSpy).toHaveBeenCalledWith({
        name: 'mastra_threads_resourceid_createdat_idx',
        table: TABLE_THREADS,
        columns: ['resourceId', 'createdAt DESC'],
      });

      expect(createIndexSpy).toHaveBeenCalledWith({
        name: 'mastra_messages_thread_id_createdat_idx',
        table: TABLE_MESSAGES,
        columns: ['thread_id', 'createdAt DESC'],
      });
    });

    it('should handle index creation errors gracefully', async () => {
      const loggerWarnSpy = vi.fn();
      Object.defineProperty(operations, 'logger', {
        value: { warn: loggerWarnSpy },
        writable: true,
        configurable: true,
      });

      vi.spyOn(operations, 'createIndex')
        .mockRejectedValueOnce(new Error('Index creation failed'))
        .mockResolvedValue(undefined);

      await operations.createAutomaticIndexes();

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to create index'),
        expect.any(Error),
      );

      // Should still try to create all 9 indexes
      expect(operations.createIndex).toHaveBeenCalledTimes(9);
    });

    it('should continue creating indexes even if some fail', async () => {
      const loggerWarnSpy = vi.fn();
      Object.defineProperty(operations, 'logger', {
        value: { warn: loggerWarnSpy },
        writable: true,
        configurable: true,
      });

      vi.spyOn(operations, 'createIndex')
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockRejectedValueOnce(new Error('Error 3'))
        .mockResolvedValue(undefined);

      await operations.createAutomaticIndexes();

      expect(loggerWarnSpy).toHaveBeenCalledTimes(3);
      expect(operations.createIndex).toHaveBeenCalledTimes(9);
    });
  });
});
