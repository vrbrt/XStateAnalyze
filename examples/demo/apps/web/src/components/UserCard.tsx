'use client';

import { useMachine } from '@xstate/react';
import { userMachine } from '@demo/machines';
import { saveUserAction } from '@/actions/user';
import { useEffect, useState, useCallback } from 'react';

export function useOrders(userId: string) {
  const [orders, setOrders] = useState<unknown[]>([]);
  useEffect(() => {
    fetch(`/api/users/${userId}`).then((r) => r.json()).then(setOrders);
  }, [userId]);
  return orders;
}

export function UserCard({ userId }: { userId: string }) {
  const [state, send] = useMachine(userMachine, { input: { userId } });
  const orders = useOrders(userId);
  const handleSave = useCallback(async () => {
    if (state.context.user) await saveUserAction(state.context.user);
    send({ type: 'SAVE' });
  }, [state, send]);

  return (
    <div>
      <h2>{state.context.user?.name ?? 'Loading'}</h2>
      <p>{orders.length} orders</p>
      <button onClick={() => send({ type: 'FETCH' })}>Load</button>
      <button onClick={handleSave}>Save</button>
      <StatusBadge busy={state.hasTag('busy')} />
    </div>
  );
}

function StatusBadge({ busy }: { busy: boolean }) {
  return <span>{busy ? '⏳' : '✓'}</span>;
}
