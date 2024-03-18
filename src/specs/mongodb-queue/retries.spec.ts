import mongoDbQueue from '../../mongodb-queue';
import setupMongo from '../__helpers__/setup-mongo';
import sleep from '../__helpers__/sleep';

describe('retries', () => {
  const queueName = 'testing-retries-queue';
  const setupDb = setupMongo();

  beforeAll(async () => {
    await setupDb.connect();
  });

  afterEach(async () => {
    await setupDb.db.collection(queueName).deleteMany({});
  });

  afterAll(async () => {
    await setupDb.client?.close();
  });

  it('allows retrying not acknowledged messages', async () => {
    const queue = mongoDbQueue<string>(setupDb.db, queueName);

    await queue.add('test message for retry');

    const messageToIgnore = await queue.get({ visibility: 1 });

    expect(messageToIgnore).toBeDefined();

    await sleep(1500);

    const message = await queue.get();

    expect(message).toBeDefined();

    expect(messageToIgnore?.tries).toBe(1);
    expect(message?.tries).toBe(2);

    expect(message?.id).toBe(messageToIgnore?.id);
    expect(message?.payload).toBe('test message for retry');
    expect(message?.payload).toBe(messageToIgnore?.payload);

    // @ts-expect-error check is defined above
    const id = await queue.ack(message.ack);

    expect(id).toBeDefined();
  });

  it('marks messages retried more than maxRetries', async () => {
    const queue = mongoDbQueue<string>(setupDb.db, queueName, {
      maxRetries: 3,
    });

    await queue.add('test message too many retries');

    const messageToIgnore = await queue.get({ visibility: 0.25 });

    expect(messageToIgnore).toBeDefined();

    await sleep(500);
    const message = await queue.get({ visibility: 0.25 });

    await sleep(500);
    const get2 = await queue.get(); // should be undefined (and dead)

    expect(message).toBeDefined();
    expect(get2).not.toBeDefined();

    expect(messageToIgnore?.tries).toBe(1);
    expect(message?.tries).toBe(2);

    expect(message?.id).toBe(messageToIgnore?.id);
    expect(message?.payload).toBe('test message too many retries');
    expect(message?.payload).toBe(messageToIgnore?.payload);

    const get3 = await setupDb.db
      .collection(queueName)
      .findOne({ payload: message!.payload });
    console.log(get3);
    expect(get3?.deleted).toBeTruthy();
    expect(get3?.dead).toEqual(true);
  });
});
