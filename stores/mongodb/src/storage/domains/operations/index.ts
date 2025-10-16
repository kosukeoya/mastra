import { ErrorCategory, ErrorDomain, MastraError } from '@mastra/core/error';
import {
  safelyParseJSON,
  StoreOperations,
  TABLE_SCHEMAS,
  TABLE_THREADS,
  TABLE_MESSAGES,
  TABLE_TRACES,
  TABLE_EVALS,
  TABLE_SCORERS,
  TABLE_AI_SPANS,
} from '@mastra/core/storage';
import type {
  StorageColumn,
  TABLE_NAMES,
  CreateIndexOptions,
  IndexInfo,
  StorageIndexStats,
} from '@mastra/core/storage';
import type { CreateIndexesOptions as MongoCreateIndexOptions, IndexDirection } from 'mongodb';
import type { MongoDBConnector } from '../../connectors/MongoDBConnector';

// Re-export the types for convenience
export type { CreateIndexOptions, IndexInfo, StorageIndexStats };

export interface MongoDBOperationsConfig {
  connector: MongoDBConnector;
}
export class StoreOperationsMongoDB extends StoreOperations {
  readonly #connector: MongoDBConnector;

  constructor(config: MongoDBOperationsConfig) {
    super();
    this.#connector = config.connector;
  }

  async getCollection(collectionName: string) {
    return this.#connector.getCollection(collectionName);
  }

  /**
   * Get the database instance from connector
   */
  private async getDatabase() {
    return this.#connector.getDatabase();
  }

  async hasColumn(_table: string, _column: string): Promise<boolean> {
    // MongoDB is schemaless, so we can assume any column exists
    // We could check a sample document, but for now return true
    return true;
  }

  async createTable(): Promise<void> {
    // Nothing to do here, MongoDB is schemaless
  }

  async alterTable(_args: {
    tableName: TABLE_NAMES;
    schema: Record<string, StorageColumn>;
    ifNotExists: string[];
  }): Promise<void> {
    // Nothing to do here, MongoDB is schemaless
  }

  async clearTable({ tableName }: { tableName: TABLE_NAMES }): Promise<void> {
    try {
      const collection = await this.getCollection(tableName);
      await collection.deleteMany({});
    } catch (error) {
      if (error instanceof Error) {
        const matstraError = new MastraError(
          {
            id: 'STORAGE_MONGODB_STORE_CLEAR_TABLE_FAILED',
            domain: ErrorDomain.STORAGE,
            category: ErrorCategory.THIRD_PARTY,
            details: { tableName },
          },
          error,
        );
        this.logger.error(matstraError.message);
        this.logger?.trackException(matstraError);
      }
    }
  }

  async dropTable({ tableName }: { tableName: TABLE_NAMES }): Promise<void> {
    try {
      const collection = await this.getCollection(tableName);
      await collection.drop();
    } catch (error) {
      // Collection might not exist, which is fine
      if (error instanceof Error && error.message.includes('ns not found')) {
        return;
      }
      throw new MastraError(
        {
          id: 'MONGODB_STORE_DROP_TABLE_FAILED',
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
          details: { tableName },
        },
        error,
      );
    }
  }

  private processJsonbFields(tableName: TABLE_NAMES, record: Record<string, any>): Record<string, any> {
    const schema = TABLE_SCHEMAS[tableName];

    return Object.fromEntries(
      Object.entries(schema).map(([key, value]) => {
        if (value.type === 'jsonb' && record[key] && typeof record[key] === 'string') {
          return [key, safelyParseJSON(record[key])];
        }
        return [key, record[key]];
      }),
    );
  }

  async insert({ tableName, record }: { tableName: TABLE_NAMES; record: Record<string, any> }): Promise<void> {
    try {
      const collection = await this.getCollection(tableName);
      const recordToInsert = this.processJsonbFields(tableName, record);
      await collection.insertOne(recordToInsert);
    } catch (error) {
      if (error instanceof Error) {
        const matstraError = new MastraError(
          {
            id: 'STORAGE_MONGODB_STORE_INSERT_FAILED',
            domain: ErrorDomain.STORAGE,
            category: ErrorCategory.THIRD_PARTY,
            details: { tableName },
          },
          error,
        );
        this.logger.error(matstraError.message);
        this.logger?.trackException(matstraError);
      }
    }
  }

  async batchInsert({ tableName, records }: { tableName: TABLE_NAMES; records: Record<string, any>[] }): Promise<void> {
    if (!records.length) {
      return;
    }

    try {
      const collection = await this.getCollection(tableName);
      const processedRecords = records.map(record => this.processJsonbFields(tableName, record));
      await collection.insertMany(processedRecords);
    } catch (error) {
      throw new MastraError(
        {
          id: 'STORAGE_MONGODB_STORE_BATCH_INSERT_FAILED',
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
          details: { tableName },
        },
        error,
      );
    }
  }

  async load<R>({ tableName, keys }: { tableName: TABLE_NAMES; keys: Record<string, string> }): Promise<R | null> {
    this.logger.info(`Loading ${tableName} with keys ${JSON.stringify(keys)}`);
    try {
      const collection = await this.getCollection(tableName);
      return (await collection.find(keys).toArray()) as R;
    } catch (error) {
      throw new MastraError(
        {
          id: 'STORAGE_MONGODB_STORE_LOAD_FAILED',
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
          details: { tableName },
        },
        error,
      );
    }
  }

  /**
   * Convert columns array to MongoDB index specification
   * Example: ['resourceId', 'createdAt DESC'] → { resourceId: 1, createdAt: -1 }
   */
  private columnsToMongoIndexSpec(columns: string[]): Record<string, IndexDirection> {
    return Object.fromEntries(
      columns.map(col => {
        // Handle 'DESC' or 'ASC' suffix
        const parts = col.trim().split(/\s+/);
        const fieldName = parts[0];
        const order = parts[1]?.toUpperCase();

        // -1 for descending, 1 for ascending
        const direction: IndexDirection = order === 'DESC' ? -1 : 1;

        return [fieldName, direction];
      }),
    );
  }

  /**
   * Convert MongoDB index info to IndexInfo format
   */
  private mongoIndexToIndexInfo(mongoIndex: any, tableName: string): IndexInfo {
    // Extract column names from key object
    const columns = Object.keys(mongoIndex.key || {});

    return {
      name: mongoIndex.name,
      table: tableName,
      columns,
      unique: mongoIndex.unique || false,
      size: '0', // MongoDB doesn't provide size in index metadata
      definition: JSON.stringify(mongoIndex),
    };
  }

  /**
   * Create a new index on a collection
   */
  async createIndex(options: CreateIndexOptions): Promise<void> {
    try {
      const {
        name,
        table,
        columns,
        unique = false,
        // MongoDB-specific note: concurrent, method, opclass, storage, tablespace are not applicable
        // concurrent: MongoDB index creation is always non-blocking
        // method: btree is default, other methods use special index types
        // opclass, storage, tablespace: not supported in MongoDB
      } = options;

      const collection = await this.getCollection(table);

      // Create index specification
      const indexSpec = this.columnsToMongoIndexSpec(columns);

      // Build MongoDB index options
      const mongoOptions: MongoCreateIndexOptions = {
        name,
        unique,
      };

      // Check if index already exists
      const indexes = await collection.indexes();
      const existingIndex = indexes.find(idx => idx.name === name);

      if (existingIndex) {
        // Index already exists, skip creation
        this.logger?.debug?.(`Index ${name} already exists on collection ${table}`);
        return;
      }

      // Create the index
      await collection.createIndex(indexSpec, mongoOptions);

      this.logger?.debug?.(`Created index ${name} on collection ${table}`);
    } catch (error: any) {
      // MongoDB error codes 85 or 86 indicate existing index
      if (error.code === 85 || error.code === 86 || error.codeName === 'IndexAlreadyExists') {
        // Index already exists, skip
        return;
      }

      throw new MastraError(
        {
          id: 'MASTRA_STORAGE_MONGODB_INDEX_CREATE_FAILED',
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
          details: {
            indexName: options.name,
            tableName: options.table,
          },
        },
        error,
      );
    }
  }

  /**
   * Drop an existing index
   */
  async dropIndex(indexName: string): Promise<void> {
    try {
      // Since we don't know which collection has the index,
      // we need to search all collections
      const db = await this.getDatabase();
      const collections = await db.listCollections().toArray();

      for (const collInfo of collections) {
        const collection = db.collection(collInfo.name);
        try {
          await collection.dropIndex(indexName);
          this.logger?.debug?.(`Dropped index ${indexName} from collection ${collInfo.name}`);
          return; // Exit after finding and dropping the index
        } catch (error: any) {
          // IndexNotFound error means the index is not in this collection, continue to next
          if (error.codeName === 'IndexNotFound' || error.code === 27) {
            continue;
          }
          throw error;
        }
      }

      // Index not found in any collection, which is fine
      this.logger?.debug?.(`Index ${indexName} not found in any collection`);
    } catch (error) {
      throw new MastraError(
        {
          id: 'MASTRA_STORAGE_MONGODB_INDEX_DROP_FAILED',
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
          details: {
            indexName,
          },
        },
        error,
      );
    }
  }

  /**
   * List indexes for a specific collection or all collections
   */
  async listIndexes(tableName?: string): Promise<IndexInfo[]> {
    try {
      const result: IndexInfo[] = [];
      const db = await this.getDatabase();

      if (tableName) {
        // List indexes for a specific collection
        const collection = await this.getCollection(tableName);
        const indexes = await collection.indexes();

        for (const idx of indexes) {
          // Skip the default _id_ index
          if (idx.name === '_id_') continue;

          result.push(this.mongoIndexToIndexInfo(idx, tableName));
        }
      } else {
        // List indexes for all collections
        const collections = await db.listCollections().toArray();

        for (const collInfo of collections) {
          const collection = db.collection(collInfo.name);
          const indexes = await collection.indexes();

          for (const idx of indexes) {
            // Skip the default _id_ index
            if (idx.name === '_id_') continue;

            result.push(this.mongoIndexToIndexInfo(idx, collInfo.name));
          }
        }
      }

      return result;
    } catch (error) {
      throw new MastraError(
        {
          id: 'MASTRA_STORAGE_MONGODB_INDEX_LIST_FAILED',
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
          details: tableName ? { tableName } : {},
        },
        error,
      );
    }
  }

  /**
   * Get detailed statistics for a specific index
   */
  async describeIndex(indexName: string): Promise<StorageIndexStats> {
    try {
      const db = await this.getDatabase();
      const collections = await db.listCollections().toArray();

      // Find the collection that has this index
      for (const collInfo of collections) {
        const collection = db.collection(collInfo.name);
        const indexes = await collection.indexes();

        const index = indexes.find((idx: any) => idx.name === indexName);
        if (index) {
          // Get index stats using $indexStats aggregation
          let scans = 0;
          let tuples_read = 0;
          let tuples_fetched = 0;

          try {
            const indexStats = await collection
              .aggregate([{ $indexStats: {} }, { $match: { name: indexName } }])
              .toArray();

            if (indexStats.length > 0) {
              const stats = indexStats[0] as any;
              scans = stats?.accesses?.ops || 0;
              // MongoDB doesn't provide tuples_read and tuples_fetched, use 0
            }
          } catch (error) {
            // $indexStats might not be available in all MongoDB versions
            this.logger?.warn?.(`Could not get index stats for ${indexName}:`, error);
          }

          const columns = Object.keys(index.key || {});

          return {
            name: index.name || '',
            table: collInfo.name,
            columns,
            unique: index.unique || false,
            size: '0', // MongoDB doesn't provide size in index metadata
            definition: JSON.stringify(index),
            method: 'btree', // MongoDB default
            scans,
            tuples_read,
            tuples_fetched,
          };
        }
      }

      throw new Error(`Index "${indexName}" not found in any collection`);
    } catch (error) {
      throw new MastraError(
        {
          id: 'MASTRA_STORAGE_MONGODB_INDEX_DESCRIBE_FAILED',
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
          details: {
            indexName,
          },
        },
        error,
      );
    }
  }

  /**
   * Returns definitions for automatic performance indexes
   * These composite indexes cover both filtering and sorting in a single index
   */
  protected getAutomaticIndexDefinitions(): CreateIndexOptions[] {
    return [
      // Composite index for threads (filter + sort)
      {
        name: 'mastra_threads_resourceid_createdat_idx',
        table: TABLE_THREADS,
        columns: ['resourceId', 'createdAt DESC'],
      },
      // Composite index for messages (filter + sort)
      {
        name: 'mastra_messages_thread_id_createdat_idx',
        table: TABLE_MESSAGES,
        columns: ['thread_id', 'createdAt DESC'],
      },
      // Composite index for traces (filter + sort)
      {
        name: 'mastra_traces_name_starttime_idx',
        table: TABLE_TRACES,
        columns: ['name', 'startTime DESC'],
      },
      // Composite index for evals (filter + sort)
      {
        name: 'mastra_evals_agent_name_created_at_idx',
        table: TABLE_EVALS,
        columns: ['agent_name', 'created_at DESC'],
      },
      // Composite index for scores (filter + sort)
      {
        name: 'mastra_scores_trace_id_span_id_created_at_idx',
        table: TABLE_SCORERS,
        columns: ['traceId', 'spanId', 'createdAt DESC'],
      },
      // AI Spans indexes for optimal trace querying
      {
        name: 'mastra_ai_spans_traceid_startedat_idx',
        table: TABLE_AI_SPANS,
        columns: ['traceId', 'startedAt DESC'],
      },
      {
        name: 'mastra_ai_spans_parentspanid_startedat_idx',
        table: TABLE_AI_SPANS,
        columns: ['parentSpanId', 'startedAt DESC'],
      },
      {
        name: 'mastra_ai_spans_name_idx',
        table: TABLE_AI_SPANS,
        columns: ['name'],
      },
      {
        name: 'mastra_ai_spans_spantype_startedat_idx',
        table: TABLE_AI_SPANS,
        columns: ['spanType', 'startedAt DESC'],
      },
    ];
  }

  /**
   * Creates automatic indexes for optimal query performance
   * Uses getAutomaticIndexDefinitions() to determine which indexes to create
   */
  async createAutomaticIndexes(): Promise<void> {
    try {
      const indexes = this.getAutomaticIndexDefinitions();

      for (const indexOptions of indexes) {
        try {
          await this.createIndex(indexOptions);
        } catch (error) {
          // Log but continue with other indexes
          this.logger?.warn?.(`Failed to create index ${indexOptions.name}:`, error);
        }
      }
    } catch (error) {
      throw new MastraError(
        {
          id: 'MASTRA_STORAGE_MONGODB_STORE_CREATE_PERFORMANCE_INDEXES_FAILED',
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
        },
        error,
      );
    }
  }
}
