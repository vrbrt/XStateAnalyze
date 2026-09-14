import { assign, fromPromise, sendTo, setup, type ActorRefFrom } from 'xstate';
import { fetchUser, updateUser, type User } from '@demo/api-client';
import { notifierMachine } from './notifierMachine';

export interface UserContext {
  userId: string;
  user?: User;
  error?: string;
  retries: number;
}

export type UserEvent =
  | { type: 'FETCH' }
  | { type: 'RETRY' }
  | { type: 'EDIT'; user: User }
  | { type: 'SAVE' }
  | { type: 'CANCEL' };

export const MAX_RETRIES = 3;

export const userMachine = setup({
  types: {
    context: {} as UserContext,
    events: {} as UserEvent,
    input: {} as { userId: string },
  },
  actors: {
    loadUser: fromPromise(async ({ input }: { input: { userId: string } }) => {
      const user = await fetchUser(input.userId);
      return user;
    }),
    saveUser: fromPromise(({ input }: { input: User }) => updateUser(input)),
    notifier: notifierMachine,
  },
  actions: {
    setUser: assign({ user: ({ event }) => (event as any).output }),
    setError: assign({ error: ({ event }) => String((event as any).error) }),
    incrementRetries: assign({ retries: ({ context }) => context.retries + 1 }),
    notifySaved: sendTo('notifierRef', ({ context }) => ({ type: 'NOTIFY', message: `Saved ${context.user?.name}` })),
    logError: ({ context }) => {
      console.error('user machine error', context.error);
    },
  },
  guards: {
    canRetry: ({ context }) => context.retries < MAX_RETRIES,
    hasUser: ({ context }) => !!context.user,
  },
}).createMachine({
  id: 'user',
  initial: 'idle',
  context: ({ input }) => ({ userId: input.userId, retries: 0 }),
  invoke: { src: 'notifier', id: 'notifierRef' },
  states: {
    idle: {
      on: { FETCH: 'loading' },
    },
    loading: {
      tags: ['busy'],
      invoke: {
        src: 'loadUser',
        input: ({ context }) => ({ userId: context.userId }),
        onDone: { target: 'loaded', actions: 'setUser' },
        onError: [
          { target: 'retrying', guard: 'canRetry', actions: ['setError', 'incrementRetries'] },
          { target: 'failed', actions: ['setError', 'logError'] },
        ],
      },
    },
    retrying: {
      after: { 1000: 'loading' },
    },
    loaded: {
      initial: 'viewing',
      states: {
        viewing: {
          on: { EDIT: { target: 'editing', actions: assign({ user: ({ event }) => event.user }) } },
        },
        editing: {
          on: {
            SAVE: { target: 'saving', guard: 'hasUser' },
            CANCEL: 'viewing',
          },
        },
        saving: {
          tags: ['busy'],
          invoke: {
            src: 'saveUser',
            input: ({ context }) => context.user!,
            onDone: { target: 'viewing', actions: ['setUser', 'notifySaved'] },
            onError: { target: 'editing', actions: 'setError' },
          },
        },
      },
      on: { FETCH: { target: '.viewing', reenter: true } },
    },
    failed: {
      type: 'final',
      entry: 'logError',
    },
  },
  on: {
    RETRY: { target: '#user.loading', guard: 'canRetry' },
  },
});

export type UserActorRef = ActorRefFrom<typeof userMachine>;
