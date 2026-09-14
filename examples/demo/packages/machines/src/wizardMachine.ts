import { setup, spawnChild, createActor } from 'xstate';
import { createActorContext } from '@xstate/react';
import { notifierMachine } from './notifierMachine';

export const wizardMachine = setup({
  actors: { notifier: notifierMachine },
  guards: { isComplete: ({ context }) => (context as any).done === true },
}).createMachine({
  id: 'wizard',
  initial: 'form',
  states: {
    form: {
      initial: 'step1',
      states: {
        hist: { type: 'history', history: 'deep' },
        step1: { on: { NEXT: 'step2' } },
        step2: { on: { NEXT: 'step3', BACK: 'step1' } },
        step3: { on: { SUBMIT: '#wizard.submitting' }, entry: spawnChild('notifier', { id: 'n' }) },
      },
      on: { RESET: '.step1' },
    },
    submitting: {
      always: [{ target: 'done', guard: 'isComplete' }, { target: 'form.hist' }],
    },
    done: { type: 'final' },
  },
});

export const WizardContext = createActorContext(wizardMachine);

export function startWizard() {
  const actor = createActor(wizardMachine);
  actor.start();
  return actor;
}
