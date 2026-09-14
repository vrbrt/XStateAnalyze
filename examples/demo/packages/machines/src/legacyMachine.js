// XState v4 style machine in plain JS
import { Machine } from 'xstate';

export const trafficLight = Machine(
  {
    id: 'light',
    initial: 'green',
    states: {
      green: { on: { TIMER: 'yellow' }, after: { 5000: 'yellow' } },
      yellow: { on: { TIMER: 'red' } },
      red: {
        type: 'parallel',
        states: {
          walk: { initial: 'go', states: { go: { on: { STOP: 'stop' } }, stop: {} } },
          countdown: { initial: 'counting', states: { counting: { on: { DONE: 'done' } }, done: { type: 'final' } } },
        },
        on: { TIMER: { target: 'green', cond: 'isSafe', actions: 'beep' } },
      },
    },
  },
  {
    guards: { isSafe: (ctx) => ctx.safe },
    actions: { beep: () => console.log('beep') },
  },
);
