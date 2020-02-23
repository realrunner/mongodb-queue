/*
 * Copyright (c) 2020 Filipe Guerra
 * https://github.com/openwar/mongodb-queue
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

// TODO @fguerra use `import type` once babel supports typescript 3.8:
// https://github.com/babel/babel/issues/10981
import { Db, ObjectId, UpdateQuery } from 'mongodb';
import crypto from 'crypto';

// some helper functions
function id() {
  return crypto.randomBytes(16).toString('hex');
}

function now() {
  return new Date().toISOString();
}

function nowPlusSecs(secs: number) {
  return new Date(Date.now() + secs * 1000).toISOString();
}

type MessageSchema = {
  _id: ObjectId;
  createdAt: Date;
  updatedAt?: Date;
  visible: string;
  payload: any;
  ack?: string;
  tries: number;
};

export type Message = {
  id: string;
  ack: string | undefined;
  createdAt: Date;
  updatedAt: Date | undefined;
  payload: any;
  tries: number;
};

export interface MongoDbQueue {
  createIndexes(): Promise<void>;

  add(payload: any): Promise<string>;

  get(options?: { visibility?: number }): Promise<Message | undefined>;

  ping(ack: string, options?: { visibility?: number }): Promise<string>;

  ack(ack: string): Promise<string>;

  total(): Promise<number>;

  size(): Promise<number>;

  inFlight(): Promise<number>;

  done(): Promise<number>;
}

class MongoDbQueueImpl implements MongoDbQueue {
  private _db: Db;
  private _name: string;
  private _visibility: number;

  private get collection() {
    return this._db.collection<MessageSchema>(this._name);
  }

  constructor(db: Db, name: string, options: { visibility?: number } = {}) {
    if (!db) {
      throw new Error('Please provide a mongodb.MongoClient.db');
    }
    if (!name) {
      throw new Error('Please provide a queue name');
    }

    this._db = db;
    this._name = name;
    this._visibility = options.visibility || 30;
  }

  async createIndexes() {
    await this.collection.createIndex({ deleted: 1, visible: 1 });
    await this.collection.createIndex(
      { ack: 1 },
      { unique: true, sparse: true },
    );
  }

  async add(payload: any): Promise<string> {
    const visible = now();

    const results = await this.collection.insertOne({
      createdAt: new Date(),
      visible,
      payload,
      tries: 0,
    });

    return results.ops[0]._id.toHexString();
  }

  async get(
    options: { visibility?: number } = {},
  ): Promise<Message | undefined> {
    const visibility = options.visibility || this._visibility;
    const query = {
      deleted: null,
      visible: { $lte: now() },
    };
    const sort = {
      _id: 1,
    };
    const update: UpdateQuery<MessageSchema> = {
      $inc: { tries: 1 },
      $set: {
        updatedAt: new Date(),
        ack: id(),
        visible: nowPlusSecs(visibility),
      },
    };

    const result = await this.collection.findOneAndUpdate(query, update, {
      sort: sort,
      returnOriginal: false,
    });

    const message = result.value;

    // nothing in the queue
    if (!message) return;

    // convert to an external representation
    return {
      id: message._id.toHexString(),
      ack: message.ack,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      payload: message.payload,
      tries: message.tries,
    };
  }

  async ping(
    ack: string,
    options: { visibility?: number } = {},
  ): Promise<string> {
    const visibility = options.visibility || this._visibility;
    const query = {
      ack: ack,
      visible: { $gt: now() },
      deleted: null,
    };
    const update = {
      $set: {
        visible: nowPlusSecs(visibility),
      },
    };

    const message = await this.collection.findOneAndUpdate(query, update, {
      returnOriginal: false,
    });

    if (!message.value) {
      throw new Error(`Queue.ping(): Unidentified ack : ${ack}`);
    }

    return message.value._id.toHexString();
  }

  async ack(ack: string): Promise<string> {
    const query = {
      ack: ack,
      visible: { $gt: now() },
      deleted: null,
    };
    const update = {
      $set: {
        deleted: now(),
      },
    };

    const message = await this.collection.findOneAndUpdate(query, update, {
      returnOriginal: false,
    });

    if (!message.value) {
      throw new Error(`Queue.ack(): Unidentified ack : ${ack}`);
    }

    return message.value._id.toHexString();
  }

  async total() {
    return await this.collection.countDocuments();
  }

  async size() {
    const query = {
      deleted: null,
      visible: { $lte: now() },
    };

    return await this.collection.countDocuments(query);
  }

  async inFlight() {
    const query = {
      ack: { $exists: true },
      visible: { $gt: now() },
      deleted: null,
    };

    return await this.collection.countDocuments(query);
  }

  async done() {
    const query = {
      deleted: { $exists: true },
    };

    return await this.collection.countDocuments(query);
  }
}

export default function mongoDbQueue(
  db: Db,
  name: string,
  options: { visibility?: number } = {},
): MongoDbQueue {
  return new MongoDbQueueImpl(db, name, options);
}