import { createMachine, assign } from 'xstate';
import { NotificationClient } from '@demo/api-client';

const client = new NotificationClient('token');

export const notifierMachine = createMachine({
  id: 'notifier',
  initial: 'idle',
  context: { queue: [] as string[] },
  states: {
    idle: {
      on: {
        NOTIFY: { target: 'sending', actions: assign({ queue: ({ context, event }) => [...context.queue, (event as any).message] }) },
      },
    },
    sending: {
      invoke: {
        src: 'deliver',
        onDone: 'idle',
        onError: 'idle',
      },
    },
  },
}).provide({
  actors: {},
  actions: {
    deliverNow: async () => {
      await client.send('u1', 'hello');
    },
  },
});
