'use client';
import { WizardContext } from '@demo/machines/src/wizardMachine';
import { useSettings } from '@/lib/data';

export function Wizard() {
  const step = WizardContext.useSelector((s) => s.value);
  const ref = WizardContext.useActorRef();
  useSettings();
  return <button onClick={() => ref.send({ type: 'NEXT' })}>{String(step)}</button>;
}

export default function WizardPage() {
  return (
    <WizardContext.Provider>
      <Wizard />
    </WizardContext.Provider>
  );
}
